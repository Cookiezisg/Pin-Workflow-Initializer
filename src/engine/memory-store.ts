import { defaultSettings } from '../core/defaults';
import type { ArchivedTab, Secrets, Settings, Snapshot, WindowSnap, Workspace } from '../core/types';
import type { AppState, Store } from './store';

const clone = <T>(v: T): T => structuredClone(v);

/** Non-persistent Store, used by tests. */
export class MemoryStore implements Store {
  workspaces: Workspace[];
  settings: Settings;
  secrets: Secrets = {};
  state: AppState = { lastFired: {} };
  sessions = new Map<string, WindowSnap>();
  snapshots: Snapshot[] = [];
  archive: ArchivedTab[] = [];

  constructor(workspaces: Workspace[], settings?: Partial<Settings>) {
    this.workspaces = workspaces;
    this.settings = { ...defaultSettings(workspaces), ...settings };
  }
  async getWorkspaces() { return clone(this.workspaces); }
  async saveWorkspaces(list: Workspace[]) { this.workspaces = clone(list); }
  async getSettings() { return clone(this.settings); }
  async saveSettings(s: Settings) { this.settings = clone(s); }
  async getSecrets() { return clone(this.secrets); }
  async getState() { return clone(this.state); }
  async patchState(p: Partial<AppState>) { this.state = { ...this.state, ...clone(p) }; }
  async getSession(id: string) { const s = this.sessions.get(id); return s && clone(s); }
  async setSession(id: string, s: WindowSnap | undefined) { if (s) this.sessions.set(id, clone(s)); else this.sessions.delete(id); }
  async addSnapshot(s: Snapshot) { this.snapshots.unshift(clone(s)); }
  async listSnapshots() { return clone(this.snapshots); }
  async getSnapshot(id: string) { const s = this.snapshots.find((x) => x.id === id); return s && clone(s); }
  async patchSnapshot(id: string, p: Partial<Snapshot>) { const s = this.snapshots.find((x) => x.id === id); if (s) Object.assign(s, clone(p)); }
  async deleteSnapshot(id: string) { this.snapshots = this.snapshots.filter((x) => x.id !== id); }
  async pruneSnapshots(limit: number) { this.snapshots = this.snapshots.slice(0, limit); }
  async addArchived(list: ArchivedTab[]) { this.archive.unshift(...clone(list)); }
  async listArchived() { return clone(this.archive); }
  async takeArchived(ids: string[]) {
    const set = new Set(ids);
    const taken = this.archive.filter((a) => set.has(a.id));
    this.archive = this.archive.filter((a) => !set.has(a.id));
    return taken;
  }
  async clearArchive() { this.archive = []; }
  async pruneArchive(limit: number) { this.archive = this.archive.slice(0, limit); }
}
