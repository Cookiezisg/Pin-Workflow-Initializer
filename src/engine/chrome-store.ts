/**
 * Where things live:
 *  - chrome.storage.sync  — workspaces (one key each) and settings: small, follows you across devices
 *  - chrome.storage.local — runtime state, per-workspace sessions, API keys (never synced)
 *  - IndexedDB            — snapshots and the tab archive (can be large)
 * Items too big for sync's 8 KB per-item quota transparently fall back to local.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { defaultSettings, defaultWorkspaces, migrateV1, sanitizeSettings, sanitizeWorkspace } from '../core/defaults';
import type { ArchivedTab, Secrets, Settings, Snapshot, WindowSnap, Workspace } from '../core/types';
import type { AppState, Store } from './store';

export const KEYS = {
  settings: 'settings',
  wsIndex: 'ws:index',
  ws: (id: string) => `ws:${id}`,
  state: 'state',
  secrets: 'secrets',
  session: (id: string) => `session:${id}`,
  v1: 'pinnedUrls',
};

async function putSynced(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.sync.set({ [key]: value });
    await chrome.storage.local.remove(`overflow:${key}`);
  } catch {
    // QUOTA_BYTES_PER_ITEM or write-rate limits: keep it local rather than lose it.
    await chrome.storage.local.set({ [`overflow:${key}`]: value });
  }
}

async function getSynced<T>(key: string): Promise<T | undefined> {
  const local = await chrome.storage.local.get(`overflow:${key}`);
  if (local[`overflow:${key}`] !== undefined) return local[`overflow:${key}`] as T;
  const sync = await chrome.storage.sync.get(key);
  return sync[key] as T | undefined;
}

let dbPromise: Promise<IDBPDatabase> | undefined;
function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB('pin-workflow', 1, {
    upgrade(d) {
      d.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      d.createObjectStore('archive', { keyPath: 'id' }).createIndex('archivedAt', 'archivedAt');
    },
  });
  return dbPromise;
}

async function newestFirst<T>(store: 'snapshots' | 'archive', index: string): Promise<T[]> {
  const all = (await (await db()).getAllFromIndex(store, index)) as T[];
  return all.reverse();
}

async function prune(store: 'snapshots' | 'archive', index: string, limit: number): Promise<void> {
  const d = await db();
  const count = await d.count(store);
  if (count <= limit) return;
  const tx = d.transaction(store, 'readwrite');
  let cursor = await tx.store.index(index).openCursor(); // oldest first
  let excess = count - limit;
  while (cursor && excess > 0) {
    await cursor.delete();
    excess--;
    cursor = await cursor.continue();
  }
  await tx.done;
}

export const chromeStore: Store = {
  async getWorkspaces() {
    const index = (await getSynced<string[]>(KEYS.wsIndex)) ?? [];
    const list = await Promise.all(index.map((id) => getSynced<unknown>(KEYS.ws(id))));
    return list.filter((w) => w !== undefined).map(sanitizeWorkspace);
  },
  async saveWorkspaces(list) {
    const previous = (await getSynced<string[]>(KEYS.wsIndex)) ?? [];
    for (const ws of list) await putSynced(KEYS.ws(ws.id), ws);
    await putSynced(KEYS.wsIndex, list.map((w) => w.id));
    const gone = previous.filter((id) => !list.some((w) => w.id === id));
    if (gone.length) {
      await chrome.storage.sync.remove(gone.map(KEYS.ws));
      await chrome.storage.local.remove([...gone.map((id) => `overflow:${KEYS.ws(id)}`), ...gone.map(KEYS.session)]);
    }
  },
  async getSettings() {
    return sanitizeSettings(await getSynced(KEYS.settings));
  },
  async saveSettings(s) {
    await putSynced(KEYS.settings, s);
  },
  async getSecrets() {
    return ((await chrome.storage.local.get(KEYS.secrets))[KEYS.secrets] as Secrets | undefined) ?? {};
  },
  async getState() {
    const s = (await chrome.storage.local.get(KEYS.state))[KEYS.state] as AppState | undefined;
    return { lastFired: {}, ...s };
  },
  async patchState(p) {
    const s = await chromeStore.getState();
    await chrome.storage.local.set({ [KEYS.state]: { ...s, ...p } });
  },
  async getSession(id) {
    return (await chrome.storage.local.get(KEYS.session(id)))[KEYS.session(id)] as WindowSnap | undefined;
  },
  async setSession(id, s) {
    if (s) await chrome.storage.local.set({ [KEYS.session(id)]: s });
    else await chrome.storage.local.remove(KEYS.session(id));
  },
  async addSnapshot(s) {
    await (await db()).put('snapshots', s);
  },
  listSnapshots: () => newestFirst<Snapshot>('snapshots', 'createdAt'),
  async getSnapshot(id) {
    return (await (await db()).get('snapshots', id)) as Snapshot | undefined;
  },
  async patchSnapshot(id, p) {
    const d = await db();
    const s = (await d.get('snapshots', id)) as Snapshot | undefined;
    if (s) await d.put('snapshots', { ...s, ...p });
  },
  async deleteSnapshot(id) {
    await (await db()).delete('snapshots', id);
  },
  pruneSnapshots: (limit) => prune('snapshots', 'createdAt', limit),
  async addArchived(list) {
    const tx = (await db()).transaction('archive', 'readwrite');
    await Promise.all([...list.map((a) => tx.store.put(a)), tx.done]);
  },
  listArchived: () => newestFirst<ArchivedTab>('archive', 'archivedAt'),
  async takeArchived(ids) {
    const tx = (await db()).transaction('archive', 'readwrite');
    const items = (await Promise.all(ids.map((id) => tx.store.get(id)))).filter(Boolean) as ArchivedTab[];
    await Promise.all(ids.map((id) => tx.store.delete(id)));
    await tx.done;
    return items;
  },
  async clearArchive() {
    await (await db()).clear('archive');
  },
  pruneArchive: (limit) => prune('archive', 'archivedAt', limit),
};

/** First run and upgrades from v1. Idempotent. */
export async function ensureInitialized(): Promise<void> {
  const index = await getSynced<string[]>(KEYS.wsIndex);
  if (index && index.length) return;
  const v1 = (await chrome.storage.sync.get(KEYS.v1))[KEYS.v1];
  const workspaces: Workspace[] = v1 !== undefined ? [migrateV1(v1)] : defaultWorkspaces();
  const settings: Settings = defaultSettings(workspaces);
  await chromeStore.saveWorkspaces(workspaces);
  await chromeStore.saveSettings(settings);
  await chromeStore.patchState({ activeWorkspaceId: workspaces[0]!.id });
}

export async function saveSecrets(s: Secrets): Promise<void> {
  await chrome.storage.local.set({ [KEYS.secrets]: s });
}
