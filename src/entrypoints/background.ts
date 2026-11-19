import { normalizeUrl, hostOf } from '../core/match';
import { evaluateRules } from '../core/rules';
import type { GroupColor, Settings, Workspace } from '../core/types';
import { chromeApi } from '../engine/chrome-api';
import { chromeStore, ensureInitialized, KEYS } from '../engine/chrome-store';
import { Engine } from '../engine/engine';
import type { RpcMap, RpcName, RpcRequest, RpcResponse } from '../lib/rpc';

const COLOR_HEX: Record<GroupColor, string> = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e',
};

export default defineBackground(() => {
  const notify = (title: string, message: string) => {
    chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('/icon-128.png'), title, message });
  };

  const engine = new Engine(chromeApi, chromeStore, {
    notify,
    onActiveChange: (ws) => void showWorkspace(ws),
  });

  // ------------------------------------------------------------ cached settings (rules run on every navigation)
  let settingsCache: Promise<Settings> | undefined;
  let activeCache: Promise<string | undefined> | undefined;
  const settings = () => (settingsCache ??= chromeStore.getSettings());
  const activeId = () => (activeCache ??= chromeStore.getState().then((s) => s.activeWorkspaceId));

  chrome.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes);
    if (keys.some((k) => k === KEYS.settings || k === `overflow:${KEYS.settings}`)) {
      settingsCache = undefined;
      void setupAlarms();
    }
    if (area === 'local' && keys.includes(KEYS.state)) activeCache = undefined;
    if (keys.some((k) => k.startsWith('ws:') || k.startsWith('overflow:ws:') || k === KEYS.state)) void refreshBadge();
  });

  // ------------------------------------------------------------ badge
  async function showWorkspace(ws: Workspace) {
    await chrome.action.setBadgeText({ text: ws.icon });
    await chrome.action.setBadgeBackgroundColor({ color: COLOR_HEX[ws.color] });
    await chrome.action.setTitle({ title: `Pin Workflow · ${ws.name}` });
  }
  async function refreshBadge() {
    try {
      await showWorkspace((await engine.workspaces()).active);
    } catch {
      /* not initialised yet */
    }
  }

  // ------------------------------------------------------------ alarms
  async function setupAlarms() {
    const s = await settings();
    await chrome.alarms.create('tick', { periodInMinutes: 1 });
    await chrome.alarms.clear('autosnap');
    if (s.autoSnapshotMinutes > 0) await chrome.alarms.create('autosnap', { periodInMinutes: s.autoSnapshotMinutes });
    await chrome.alarms.clear('idle');
    if (s.idleArchiveMinutes > 0) await chrome.alarms.create('idle', { periodInMinutes: 5 });
  }

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    try {
      if (alarm.name === 'tick') await engine.runSchedules();
      else if (alarm.name === 'autosnap') await engine.autoSnapshot();
      else if (alarm.name === 'idle') {
        const n = await engine.idleSweep();
        if (n > 0 && (await settings()).notifications) notify('Pin Workflow', chrome.i18n.getMessage('idleArchived', [String(n)]) || `${n} idle tabs archived`);
      }
    } catch (e) {
      console.warn('[pwi] alarm', alarm.name, e);
    }
  });

  // ------------------------------------------------------------ lifecycle
  chrome.runtime.onInstalled.addListener(async (details) => {
    await ensureInitialized();
    await setupAlarms();
    await refreshBadge();
    if (details.reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#welcome') });
    if (details.reason === 'update' && details.previousVersion?.startsWith('1.')) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#upgraded') });
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    await setupAlarms();
    await refreshBadge();
    if ((await settings()).pinsOnStartup) {
      // Give session restore a moment to bring windows back.
      setTimeout(() => void engine.ensurePins().catch((e) => console.warn('[pwi] startup pins', e)), 4000);
    }
  });

  // ------------------------------------------------------------ keyboard
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'open-side-panel') {
      // Must run synchronously inside the user gesture.
      if (tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    const run: Record<string, () => Promise<unknown>> = {
      'apply-workspace': () => engine.apply(),
      undo: () => engine.undo(),
      'next-workspace': () => engine.switchNext(1),
      'archive-ungrouped': () => engine.archiveUngrouped(),
    };
    run[command]?.().catch((e) => console.warn('[pwi] command', command, e));
  });

  // ------------------------------------------------------------ live rules & de-duplication
  const createdAt = new Map<number, number>();
  chrome.tabs.onCreated.addListener((t) => t.id !== undefined && createdAt.set(t.id, Date.now()));
  chrome.tabs.onRemoved.addListener((id) => createdAt.delete(id));

  async function hostAllowed(url: string): Promise<boolean> {
    const allow = ((await chrome.storage.session.get('allow')).allow ?? {}) as Record<string, number>;
    return (allow[hostOf(url)] ?? 0) > Date.now();
  }

  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (!info.url || tab.incognito) return;
    const url = info.url;
    try {
      const s = await settings();
      const born = createdAt.get(tabId);
      if (s.dedupeLive && born && Date.now() - born < 5000 && /^https?:/.test(url)) {
        const siblings = await chrome.tabs.query({ windowId: tab.windowId });
        const dup = siblings.find((t) => t.id !== tabId && t.url && normalizeUrl(t.url) === normalizeUrl(url));
        if (dup?.id !== undefined) {
          await chrome.tabs.update(dup.id, { active: true });
          await chrome.tabs.remove(tabId);
          return;
        }
      }
      const hit = evaluateRules(s.rules, await activeId(), url);
      if (!hit) return;
      const { action } = hit;
      if (action.type === 'block') {
        if (await hostAllowed(url)) return;
        const current = await activeId();
        const ws = (await chromeStore.getWorkspaces()).find((w) => w.id === current);
        const q = new URLSearchParams({ url, ws: ws ? `${ws.icon} ${ws.name}` : '' });
        await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('/blocked.html')}?${q}` });
      } else if (action.type === 'pin') {
        if (!tab.pinned) await chrome.tabs.update(tabId, { pinned: true });
      } else if (action.type === 'group') {
        if (tab.pinned || (tab.groupId ?? -1) !== -1) return;
        const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: action.title });
        const groupId = await chrome.tabs.group({
          tabIds: tabId,
          ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }),
        });
        if (!existing) await chrome.tabGroups.update(groupId, { title: action.title, color: action.color });
      }
    } catch (e) {
      console.warn('[pwi] rules', e);
    }
  });

  // ------------------------------------------------------------ RPC
  const handlers: { [K in RpcName]: (args: RpcMap[K]['args']) => Promise<RpcMap[K]['result']> } = {
    apply: (a) => engine.apply(a.workspaceId),
    switchTo: (a) => engine.switchTo(a.workspaceId),
    switchNext: (a) => engine.switchNext(a.direction),
    ensurePins: () => engine.ensurePins(),
    preview: (a) => engine.preview(a.kind, a.workspaceId),
    undo: () => engine.undo(),
    snapshot: (a) => engine.takeSnapshot(a.label),
    restoreSnapshot: (a) => engine.restoreSnapshot(a.id),
    deleteSnapshot: async (a) => (await chromeStore.deleteSnapshot(a.id), null),
    archiveTabs: (a) => engine.archiveTabs(a.tabIds),
    archiveUngrouped: () => engine.archiveUngrouped(),
    restoreArchived: (a) => engine.restoreArchived(a.ids),
    dedupe: () => engine.dedupe(),
    collapseAll: async () => (await engine.collapseAll(), null),
    mergeWindows: () => engine.mergeWindows(),
    applyGrouping: (a) => engine.applyGrouping(a.groups),
    newWorkspaceFromWindow: (a) => engine.newWorkspaceFromWindow(a.name, a.icon),
    moveTabToWorkspace: async (a) => (await engine.moveTabToWorkspace(a.tabId, a.workspaceId), null),
    allowHost: async (a) => {
      const allow = ((await chrome.storage.session.get('allow')).allow ?? {}) as Record<string, number>;
      allow[a.host] = Date.now() + a.minutes * 60_000;
      await chrome.storage.session.set({ allow });
      return null;
    },
  };

  chrome.runtime.onMessage.addListener((msg: RpcRequest, sender, sendResponse: (r: RpcResponse) => void) => {
    if (!msg || typeof msg.rpc !== 'string' || !(msg.rpc in handlers)) return false;
    if (sender.id !== chrome.runtime.id) return false;
    const handler = handlers[msg.rpc] as (a: unknown) => Promise<unknown>;
    handler(msg.args ?? {})
      .then((result) => sendResponse({ ok: true, result } as RpcResponse))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
});
