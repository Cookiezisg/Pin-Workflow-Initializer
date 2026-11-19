/**
 * Workspace operations. Every mutating entry point is serialised (no interleaving when a shortcut is
 * mashed) and snapshots the browser first, so any of them can be undone.
 */
import { uid } from '../core/ids';
import { t } from '../lib/i18n';
import { isArchivable, isNewTabUrl, unwrapUrl } from '../core/match';
import { plan, type Plan, type Target } from '../core/plan';
import { dueSchedules } from '../core/schedule';
import {
  countTabs, fingerprint, sessionFromWindow, snapshotWindow, targetForApply, targetForPins, targetForRestore, targetForSwitch,
} from '../core/targets';
import { newWorkspace, pin } from '../core/defaults';
import { NO_GROUP } from '../core/types';
import type { ArchivedTab, GroupColor, LiveGroup, LiveTab, LiveWindow, OtherWindowsPolicy, Snapshot, SnapshotReason, WindowSnap, Workspace } from '../core/types';
import type { BrowserApi } from './api';
import { execute, removeTabs } from './executor';
import type { RunReport, Store } from './store';

export interface EngineHooks {
  now?: () => number;
  notify?: (title: string, message: string) => void;
  /** Called whenever the active workspace may have changed. */
  onActiveChange?: (ws: Workspace) => void;
}

const UNDOABLE: SnapshotReason[] = ['apply', 'switch', 'restore', 'ai', 'archive', 'merge'];

export class EngineError extends Error {}

export class Engine {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private api: BrowserApi,
    private store: Store,
    private hooks: EngineHooks = {},
  ) {}

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /** Run `fn` after every previously queued operation has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- reads

  async workspaces(): Promise<{ list: Workspace[]; active: Workspace }> {
    const list = await this.store.getWorkspaces();
    if (list.length === 0) throw new EngineError(t('No workspaces configured'));
    const { activeWorkspaceId } = await this.store.getState();
    return { list, active: list.find((w) => w.id === activeWorkspaceId) ?? list[0]! };
  }

  private async workspace(id?: string): Promise<Workspace> {
    const { list, active } = await this.workspaces();
    if (!id) return active;
    const ws = list.find((w) => w.id === id);
    if (!ws) throw new EngineError(t('Unknown workspace {0}', id));
    return ws;
  }

  private async focusedWindow(): Promise<LiveWindow> {
    const id = await this.api.focusedWindowId();
    if (id === undefined) throw new EngineError(t('No browser window is focused'));
    const win = await this.api.getWindow(id);
    if (win.incognito) throw new EngineError(t('Incognito windows are left alone'));
    return win;
  }

  private async normalWindows(): Promise<LiveWindow[]> {
    return (await this.api.getAllWindows()).filter((w) => !w.incognito);
  }

  /** Dry run: what would applying / switching do to the focused window? */
  async preview(kind: 'apply' | 'switch', workspaceId?: string): Promise<Plan> {
    const [ws, win, settings] = await Promise.all([this.workspace(workspaceId), this.focusedWindow(), this.store.getSettings()]);
    if (kind === 'apply') return plan(win, targetForApply(ws, settings));
    return plan(win, targetForSwitch(ws, await this.store.getSession(ws.id), settings));
  }

  // ---------------------------------------------------------------- snapshots

  private async snapshot(reason: SnapshotReason, label?: string, workspaceId?: string): Promise<Snapshot> {
    const windows = (await this.normalWindows()).map(snapshotWindow);
    const snap: Snapshot = { id: uid(), createdAt: this.now(), reason, label, workspaceId, windows, tabCount: countTabs(windows) };
    await this.store.addSnapshot(snap);
    const settings = await this.store.getSettings();
    await this.store.pruneSnapshots(settings.snapshotLimit);
    await this.store.patchState({ lastFingerprint: fingerprint(windows) });
    return snap;
  }

  takeSnapshot(label?: string): Promise<Snapshot> {
    return this.exclusive(async () => this.snapshot('manual', label, (await this.workspaces()).active.id));
  }

  /** Periodic safety net; skipped when nothing changed since the last snapshot. */
  autoSnapshot(): Promise<Snapshot | undefined> {
    return this.exclusive(async () => {
      const windows = (await this.normalWindows()).map(snapshotWindow);
      if (countTabs(windows) === 0) return undefined;
      const { lastFingerprint } = await this.store.getState();
      if (fingerprint(windows) === lastFingerprint) return undefined;
      return this.snapshot('auto', undefined, (await this.workspaces()).active.id);
    });
  }

  // ---------------------------------------------------------------- core runner

  private archiveHook(reason: ArchivedTab['reason'], workspaceId?: string) {
    return async (tabs: LiveTab[], groups: LiveGroup[]) => {
      const at = this.now();
      const items: ArchivedTab[] = tabs
        .filter((t) => isArchivable(t.url))
        .map((t) => ({
          id: uid(),
          url: unwrapUrl(t.url),
          title: t.title || unwrapUrl(t.url),
          archivedAt: at,
          workspaceId,
          groupTitle: groups.find((g) => g.id === t.groupId)?.title || undefined,
          reason,
        }));
      if (items.length === 0) return;
      await this.store.addArchived(items);
      await this.store.pruneArchive((await this.store.getSettings()).archiveLimit);
    };
  }

  private async converge(
    windowId: number, target: Target, action: string, ws?: Workspace, snapshotId?: string, reason: ArchivedTab['reason'] = 'apply',
  ): Promise<RunReport> {
    const live = await this.api.getWindow(windowId);
    const p = plan(live, target);
    const res = await execute(this.api, windowId, p.ops, { archive: this.archiveHook(reason, ws?.id) });
    return { at: this.now(), action, workspaceId: ws?.id, summary: p.summary, errors: res.errors, snapshotId };
  }

  private async finish(report: RunReport, active?: Workspace): Promise<RunReport> {
    await this.store.patchState({ lastRun: report, ...(active && { activeWorkspaceId: active.id }) });
    if (active) this.hooks.onActiveChange?.(active);
    return report;
  }

  // ---------------------------------------------------------------- workspace actions

  /** "Initialize workflow": converge the focused window to the workspace, tidy everything else. */
  apply(workspaceId?: string): Promise<RunReport> {
    return this.exclusive(async () => {
      const [ws, settings] = await Promise.all([this.workspace(workspaceId), this.store.getSettings()]);
      const win = await this.focusedWindow();
      const snap = await this.snapshot('apply', ws.name, (await this.workspaces()).active.id);
      await this.handleOtherWindows(ws.otherWindows, win.id, ws.id);
      const report = await this.converge(win.id, targetForApply(ws, settings), 'apply', ws, snap.id);
      return this.finish(report, ws);
    });
  }

  /** Save the current window as the active workspace's session, then bring up `workspaceId`'s. */
  switchTo(workspaceId: string): Promise<RunReport> {
    return this.exclusive(() => this.doSwitch(workspaceId));
  }

  private async doSwitch(workspaceId: string): Promise<RunReport> {
    const [{ active: from }, to, settings] = await Promise.all([this.workspaces(), this.workspace(workspaceId), this.store.getSettings()]);
    const win = await this.focusedWindow();
    if (from.id === to.id) {
      const report = await this.converge(win.id, targetForPins(to), 'refresh', to);
      return this.finish(report, to);
    }
    const snap = await this.snapshot('switch', `${from.name} → ${to.name}`, from.id);
    await this.store.setSession(from.id, sessionFromWindow(win));
    const session = await this.store.getSession(to.id);
    const report = await this.converge(win.id, targetForSwitch(to, session, settings), 'switch', to, snap.id);
    return this.finish(report, to);
  }

  /** Cycle to the next workspace in the list. */
  async switchNext(direction: 1 | -1 = 1): Promise<RunReport> {
    const { list, active } = await this.workspaces();
    const i = list.findIndex((w) => w.id === active.id);
    return this.switchTo(list[(i + direction + list.length) % list.length]!.id);
  }

  /** Re-assert the active workspace's pins without touching anything else. */
  ensurePins(): Promise<RunReport> {
    return this.exclusive(async () => {
      const ws = await this.workspace();
      const win = await this.focusedWindow();
      return this.finish(await this.converge(win.id, targetForPins(ws), 'pins', ws), ws);
    });
  }

  private async handleOtherWindows(policy: OtherWindowsPolicy, focusedId: number, workspaceId?: string): Promise<void> {
    if (policy === 'keep') return;
    const others = (await this.normalWindows()).filter((w) => w.id !== focusedId);
    for (const w of others) {
      if (policy === 'merge') {
        await this.mergeInto(w, focusedId);
        continue;
      }
      if (policy === 'archive') {
        await this.archiveHook('window', workspaceId)(w.tabs, w.groups);
      }
      await this.api.removeWindow(w.id).catch(() => undefined);
    }
  }

  private async mergeInto(w: LiveWindow, focusedId: number): Promise<void> {
    for (const g of w.groups) await this.api.moveGroup(g.id, { windowId: focusedId, index: -1 }).catch(() => undefined);
    const rest = w.tabs.filter((t) => t.groupId === NO_GROUP);
    for (const t of rest) if (t.pinned) await this.api.updateTab(t.id, { pinned: false }).catch(() => undefined);
    const movable = rest.filter((t) => !isNewTabUrl(t.url)).map((t) => t.id);
    if (movable.length) await this.api.moveTabs(movable, { windowId: focusedId, index: -1 }).catch(() => undefined);
    // Whatever is left (blank tabs) goes with the window.
    await this.api.removeWindow(w.id).catch(() => undefined);
  }

  mergeWindows(): Promise<RunReport> {
    return this.exclusive(async () => {
      const win = await this.focusedWindow();
      const snap = await this.snapshot('merge', 'Merge windows', (await this.workspaces()).active.id);
      const others = (await this.normalWindows()).filter((w) => w.id !== win.id);
      await this.handleOtherWindows('merge', win.id);
      return this.finish({ at: this.now(), action: 'merge', errors: [], snapshotId: snap.id, message: `${others.length}` });
    });
  }

  // ---------------------------------------------------------------- undo / restore

  undo(): Promise<RunReport> {
    return this.exclusive(async () => {
      const target = (await this.store.listSnapshots()).find((s) => UNDOABLE.includes(s.reason) && !s.undone);
      if (!target) return { at: this.now(), action: 'undo', errors: [], message: 'nothing' };
      await this.snapshot('undo', target.label, (await this.workspaces()).active.id);
      const report = await this.restoreWindows(target);
      await this.store.patchSnapshot(target.id, { undone: true });
      const ws = (await this.store.getWorkspaces()).find((w) => w.id === target.workspaceId);
      return this.finish({ ...report, action: 'undo', snapshotId: target.id }, ws);
    });
  }

  restoreSnapshot(id: string): Promise<RunReport> {
    return this.exclusive(async () => {
      const target = await this.store.getSnapshot(id);
      if (!target) throw new EngineError(t('Snapshot not found'));
      await this.snapshot('restore', target.label ?? new Date(target.createdAt).toLocaleString(), (await this.workspaces()).active.id);
      const report = await this.restoreWindows(target);
      const ws = (await this.store.getWorkspaces()).find((w) => w.id === target.workspaceId);
      return this.finish({ ...report, action: 'restore', snapshotId: id }, ws);
    });
  }

  private async restoreWindows(snap: Snapshot): Promise<RunReport> {
    const settings = await this.store.getSettings();
    const live = await this.normalWindows();
    const focusedId = (await this.focusedWindow()).id;
    const used = new Set<number>();
    const errors: string[] = [];
    const focusedSnap = snap.windows.find((w) => w.focused) ?? snap.windows[0];
    const summary = { reused: 0, created: 0, moved: 0, grouped: 0, archived: 0, closed: 0 };
    const order = focusedSnap ? [focusedSnap, ...snap.windows.filter((w) => w !== focusedSnap)] : [];
    for (const w of order) {
      let windowId: number;
      if (w === focusedSnap) windowId = focusedId;
      else if (w.windowId !== undefined && live.some((l) => l.id === w.windowId) && !used.has(w.windowId)) windowId = w.windowId;
      else windowId = (await this.api.createWindow({ focused: false })).windowId;
      used.add(windowId);
      const r = await this.converge(windowId, targetForRestore(w, settings.lazyRestore), 'restore');
      errors.push(...r.errors);
      for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] += r.summary?.[k] ?? 0;
    }
    await this.api.focusWindow(focusedId).catch(() => undefined);
    return { at: this.now(), action: 'restore', errors, summary };
  }

  // ---------------------------------------------------------------- archive

  archiveTabs(tabIds: number[], reason: ArchivedTab['reason'] = 'manual'): Promise<number> {
    return this.exclusive(async () => {
      const ws = (await this.workspaces()).active;
      const windows = await this.normalWindows();
      const ids = new Set(tabIds);
      let n = 0;
      for (const w of windows) {
        const tabs = w.tabs.filter((t) => ids.has(t.id));
        if (tabs.length === 0) continue;
        if (tabs.length === w.tabs.length) await this.api.createTab({ windowId: w.id, url: 'chrome://newtab/', active: true });
        await this.archiveHook(reason, ws.id)(tabs, w.groups);
        await removeTabs(this.api, tabs.map((t) => t.id));
        n += tabs.length;
      }
      return n;
    });
  }

  /** Archive every ungrouped, unpinned tab in the focused window. */
  archiveUngrouped(): Promise<RunReport> {
    return this.exclusive(async () => {
      const ws = (await this.workspaces()).active;
      const win = await this.focusedWindow();
      const snap = await this.snapshot('archive', 'Archive ungrouped', ws.id);
      const target: Target = {
        pins: [], groups: [], loose: [], leftoverUngrouped: 'archive', leftoverGroups: 'keep', keepExtraPins: true,
        collapseGroups: false, activate: { kind: 'newtab' }, dedupe: false,
      };
      return this.finish(await this.converge(win.id, target, 'archive', ws, snap.id, 'manual'));
    });
  }

  restoreArchived(ids: string[]): Promise<number> {
    return this.exclusive(async () => {
      const items = await this.store.takeArchived(ids);
      const win = await this.focusedWindow();
      for (const [i, item] of items.entries()) {
        await this.api.createTab({ windowId: win.id, url: item.url, active: i === items.length - 1 });
      }
      return items.length;
    });
  }

  /** Archive tabs nobody has looked at for a while. Returns how many went. */
  idleSweep(): Promise<number> {
    return this.exclusive(async () => {
      const settings = await this.store.getSettings();
      if (settings.idleArchiveMinutes <= 0) return 0;
      const cutoff = this.now() - settings.idleArchiveMinutes * 60_000;
      const ws = (await this.workspaces()).active;
      let n = 0;
      for (const w of await this.normalWindows()) {
        const idle = w.tabs.filter(
          (t) =>
            !t.pinned && !t.active && !t.audible && isArchivable(t.url) && t.lastAccessed !== undefined && t.lastAccessed < cutoff &&
            (!settings.idleArchiveSkipGrouped || t.groupId === NO_GROUP),
        );
        if (idle.length === 0 || idle.length === w.tabs.length) continue;
        await this.archiveHook('idle', ws.id)(idle, w.groups);
        await removeTabs(this.api, idle.map((t) => t.id));
        n += idle.length;
      }
      return n;
    });
  }

  // ---------------------------------------------------------------- tidy-ups

  dedupe(): Promise<RunReport> {
    return this.exclusive(async () => {
      const win = await this.focusedWindow();
      const target: Target = {
        pins: [], groups: [], loose: [], leftoverUngrouped: 'keep', leftoverGroups: 'keep', keepExtraPins: true,
        collapseGroups: false, activate: { kind: 'keep' }, dedupe: true,
      };
      return this.finish(await this.converge(win.id, target, 'dedupe'));
    });
  }

  collapseAll(): Promise<void> {
    return this.exclusive(async () => {
      const win = await this.focusedWindow();
      const activeGroup = win.tabs.find((t) => t.active)?.groupId;
      for (const g of win.groups) if (!g.collapsed && g.id !== activeGroup) await this.api.updateGroup(g.id, { collapsed: true });
    });
  }

  /** Apply a grouping (from AI or the UI) to tabs of the focused window. */
  applyGrouping(groups: { title: string; color: GroupColor; tabIds: number[] }[]): Promise<RunReport> {
    return this.exclusive(async () => {
      const win = await this.focusedWindow();
      const snap = await this.snapshot('ai', 'Smart group', (await this.workspaces()).active.id);
      const valid = new Set(win.tabs.filter((t) => !t.pinned).map((t) => t.id));
      const errors: string[] = [];
      let grouped = 0;
      for (const g of groups) {
        const ids = g.tabIds.filter((id) => valid.has(id));
        if (ids.length === 0) continue;
        ids.forEach((id) => valid.delete(id));
        try {
          const existing = win.groups.find((x) => x.title.trim().toLowerCase() === g.title.trim().toLowerCase());
          const gid = await this.api.groupTabs(ids, existing ? { groupId: existing.id } : { windowId: win.id });
          await this.api.updateGroup(gid, { title: g.title, color: g.color });
          grouped += ids.length;
        } catch (e) {
          errors.push(String(e));
        }
      }
      return this.finish({
        at: this.now(), action: 'ai', errors, snapshotId: snap.id,
        summary: { reused: 0, created: 0, moved: 0, grouped, archived: 0, closed: 0 },
      });
    });
  }

  // ---------------------------------------------------------------- workspace management

  /** Capture the focused window as a brand-new workspace (pins become its pins, the rest its session). */
  newWorkspaceFromWindow(name: string, icon = '🗂️'): Promise<Workspace> {
    return this.exclusive(async () => {
      const win = await this.focusedWindow();
      const list = await this.store.getWorkspaces();
      const ws = newWorkspace({
        name,
        icon,
        pins: win.tabs.filter((t) => t.pinned && isArchivable(t.url)).map((t) => pin(unwrapUrl(t.url))),
      });
      await this.store.saveWorkspaces([...list, ws]);
      await this.store.setSession(ws.id, sessionFromWindow(win));
      await this.store.patchState({ activeWorkspaceId: ws.id });
      this.hooks.onActiveChange?.(ws);
      return ws;
    });
  }

  /** Send a tab to another workspace's session (it reappears there on the next switch). */
  moveTabToWorkspace(tabId: number, workspaceId: string): Promise<void> {
    return this.exclusive(async () => {
      const { active } = await this.workspaces();
      if (workspaceId === active.id) return;
      const win = await this.focusedWindow();
      const tab = win.tabs.find((t) => t.id === tabId) ?? (await this.findTab(tabId));
      if (!tab) throw new EngineError(t('Tab not found'));
      const session: WindowSnap = (await this.store.getSession(workspaceId)) ?? { focused: true, tabs: [], groups: [] };
      session.tabs.push({ url: unwrapUrl(tab.url), title: tab.title, pinned: false, group: null, active: false });
      await this.store.setSession(workspaceId, session);
      if (win.tabs.length === 1) await this.api.createTab({ windowId: win.id, url: 'chrome://newtab/', active: true });
      await removeTabs(this.api, [tabId]);
    });
  }

  private async findTab(tabId: number): Promise<LiveTab | undefined> {
    for (const w of await this.normalWindows()) {
      const t = w.tabs.find((x) => x.id === tabId);
      if (t) return t;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- automation

  /** Fire due schedules. Called from a one-minute alarm. */
  async runSchedules(now = new Date(this.now())): Promise<string[]> {
    const [settings, state, list] = await Promise.all([this.store.getSettings(), this.store.getState(), this.store.getWorkspaces()]);
    const due = dueSchedules(settings.schedules, now, state.lastFired);
    const fired: string[] = [];
    for (const { schedule, key } of due) {
      await this.store.patchState({ lastFired: { ...(await this.store.getState()).lastFired, [schedule.id]: key } });
      const ws = list.find((w) => w.id === schedule.workspaceId);
      if (!ws) continue;
      try {
        await this.switchTo(ws.id);
        fired.push(ws.id);
        if (settings.notifications) this.hooks.notify?.(`${ws.icon} ${ws.name}`, `Scheduled switch at ${schedule.time}`);
      } catch (e) {
        // No focused window (browser minimised etc.): skip this occurrence.
        if (!(e instanceof EngineError)) throw e;
      }
    }
    return fired;
  }
}
