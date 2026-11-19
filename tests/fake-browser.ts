/**
 * In-memory simulation of Chrome's tab strip rules, faithful enough to catch ordering bugs:
 *  - pinned tabs always occupy the front of the strip
 *  - pinned tabs cannot be grouped; pinning a grouped tab ungroups it
 *  - a group's tabs are contiguous; empty groups disappear
 *  - closing the last tab of a window closes the window
 */
import type { BrowserApi } from '../src/engine/api';
import type { GroupColor, LiveWindow } from '../src/core/types';
import { NO_GROUP } from '../src/core/types';

interface FTab {
  id: number;
  url: string;
  title: string;
  pinned: boolean;
  groupId: number;
  active: boolean;
  lastAccessed: number;
  audible?: boolean;
}
interface FGroup {
  id: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}
interface FWindow {
  id: number;
  incognito: boolean;
  tabs: FTab[];
  groups: Map<number, FGroup>;
}

export interface SeedTab {
  url: string;
  title?: string;
  pinned?: boolean;
  group?: string; // group title
  active?: boolean;
  lastAccessed?: number;
}

export class FakeBrowser implements BrowserApi {
  windows = new Map<number, FWindow>();
  focused: number | undefined;
  private nextId = 1;
  calls: string[] = [];
  now = 1_000_000;

  addWindow(seed: SeedTab[], opts: { focused?: boolean; incognito?: boolean; groups?: Record<string, { color?: GroupColor; collapsed?: boolean }> } = {}): number {
    const win: FWindow = { id: this.nextId++, incognito: !!opts.incognito, tabs: [], groups: new Map() };
    const byTitle = new Map<string, number>();
    for (const s of seed) {
      let groupId = NO_GROUP;
      if (s.group !== undefined) {
        if (!byTitle.has(s.group)) {
          const id = this.nextId++;
          const meta = opts.groups?.[s.group];
          win.groups.set(id, { id, title: s.group, color: meta?.color ?? 'grey', collapsed: meta?.collapsed ?? false });
          byTitle.set(s.group, id);
        }
        groupId = byTitle.get(s.group)!;
      }
      win.tabs.push({
        id: this.nextId++,
        url: s.url,
        title: s.title ?? s.url,
        pinned: !!s.pinned,
        groupId,
        active: !!s.active,
        lastAccessed: s.lastAccessed ?? this.now,
      });
    }
    if (!win.tabs.some((t) => t.active) && win.tabs.length) win.tabs[win.tabs.length - 1]!.active = true;
    this.windows.set(win.id, win);
    if (opts.focused || this.focused === undefined) this.focused = win.id;
    return win.id;
  }

  // ---- helpers
  private findTab(id: number): { win: FWindow; tab: FTab; index: number } {
    for (const win of this.windows.values()) {
      const index = win.tabs.findIndex((t) => t.id === id);
      if (index !== -1) return { win, tab: win.tabs[index]!, index };
    }
    throw new Error(`No tab with id: ${id}.`);
  }
  private findGroup(id: number): { win: FWindow; group: FGroup } {
    for (const win of this.windows.values()) {
      const group = win.groups.get(id);
      if (group) return { win, group };
    }
    throw new Error(`No group with id: ${id}.`);
  }
  private pinnedCount(win: FWindow): number {
    return win.tabs.filter((t) => t.pinned).length;
  }
  private gc(win: FWindow): void {
    for (const g of [...win.groups.keys()]) if (!win.tabs.some((t) => t.groupId === g)) win.groups.delete(g);
    if (win.tabs.length === 0) {
      this.windows.delete(win.id);
      if (this.focused === win.id) this.focused = this.windows.keys().next().value;
    } else if (!win.tabs.some((t) => t.active)) {
      win.tabs[win.tabs.length - 1]!.active = true;
    }
  }
  private insert(win: FWindow, tab: FTab, index: number): void {
    const pc = this.pinnedCount(win);
    const i = tab.pinned ? Math.min(Math.max(index, 0), pc) : Math.min(Math.max(index, pc), win.tabs.length);
    win.tabs.splice(i, 0, tab);
  }
  /** Invariant checks; tests call this after every scenario. */
  assertInvariants(): void {
    for (const win of this.windows.values()) {
      const pc = this.pinnedCount(win);
      win.tabs.forEach((t, i) => {
        if (t.pinned && i >= pc) throw new Error(`pinned tab ${t.id} after unpinned`);
        if (t.pinned && t.groupId !== NO_GROUP) throw new Error(`pinned tab ${t.id} in group`);
      });
      for (const g of win.groups.keys()) {
        const idx = win.tabs.map((t, i) => (t.groupId === g ? i : -1)).filter((i) => i >= 0);
        if (idx.length === 0) throw new Error(`empty group ${g}`);
        if (idx[idx.length - 1]! - idx[0]! !== idx.length - 1) throw new Error(`group ${g} not contiguous`);
      }
      if (win.tabs.filter((t) => t.active).length !== 1) throw new Error(`window ${win.id} active count`);
    }
  }

  // ---- BrowserApi
  async getWindow(windowId: number): Promise<LiveWindow> {
    const win = this.windows.get(windowId);
    if (!win) throw new Error(`No window with id: ${windowId}.`);
    return {
      id: win.id,
      focused: this.focused === win.id,
      incognito: win.incognito,
      tabs: win.tabs.map((t, index) => ({ ...t, index })),
      groups: [...win.groups.values()].map((g) => ({ ...g })),
    };
  }
  async getAllWindows(): Promise<LiveWindow[]> {
    return Promise.all([...this.windows.keys()].map((id) => this.getWindow(id)));
  }
  async focusedWindowId(): Promise<number | undefined> {
    return this.focused;
  }
  async createTab(p: { windowId: number; url: string; pinned?: boolean; index?: number; active?: boolean }): Promise<number> {
    this.calls.push(`create ${p.url}${p.pinned ? ' pinned' : ''}`);
    const win = this.windows.get(p.windowId);
    if (!win) throw new Error(`No window with id: ${p.windowId}.`);
    const tab: FTab = { id: this.nextId++, url: p.url, title: p.url, pinned: !!p.pinned, groupId: NO_GROUP, active: false, lastAccessed: this.now };
    this.insert(win, tab, p.index ?? win.tabs.length);
    if (p.active ?? true) {
      win.tabs.forEach((t) => (t.active = false));
      tab.active = true;
    }
    return tab.id;
  }
  async updateTab(tabId: number, p: { pinned?: boolean; active?: boolean; url?: string }): Promise<void> {
    this.calls.push(`update ${tabId} ${JSON.stringify(p)}`);
    const { win, tab, index } = this.findTab(tabId);
    if (p.url !== undefined) tab.url = p.url;
    if (p.pinned !== undefined && p.pinned !== tab.pinned) {
      win.tabs.splice(index, 1);
      tab.pinned = p.pinned;
      if (p.pinned) {
        tab.groupId = NO_GROUP;
        this.insert(win, tab, this.pinnedCount(win));
      } else {
        this.insert(win, tab, this.pinnedCount(win));
      }
      this.gc(win);
    }
    if (p.active) {
      win.tabs.forEach((t) => (t.active = false));
      tab.active = true;
      tab.lastAccessed = this.now;
    }
  }
  async moveTabs(tabIds: number[], p: { windowId?: number; index: number }): Promise<void> {
    this.calls.push(`move ${tabIds.join(',')} -> ${p.index}`);
    let index = p.index;
    for (const id of tabIds) {
      const { win, tab, index: from } = this.findTab(id);
      const dest = p.windowId !== undefined ? this.windows.get(p.windowId)! : win;
      win.tabs.splice(from, 1);
      if (dest !== win) {
        if (tab.groupId !== NO_GROUP) tab.groupId = NO_GROUP;
        if (tab.active) {
          tab.active = false;
        }
      }
      this.insert(dest, tab, index === -1 ? dest.tabs.length : index);
      this.gc(win);
      if (index !== -1) index++;
    }
  }
  async removeTabs(tabIds: number[]): Promise<void> {
    this.calls.push(`remove ${tabIds.join(',')}`);
    for (const id of tabIds) this.findTab(id); // all-or-nothing, like Chrome
    for (const id of tabIds) {
      const { win, index } = this.findTab(id);
      win.tabs.splice(index, 1);
      this.gc(win);
    }
  }
  async groupTabs(tabIds: number[], p: { groupId?: number; windowId?: number }): Promise<number> {
    this.calls.push(`group ${tabIds.join(',')} -> ${p.groupId ?? 'new'}`);
    for (const id of tabIds) if (this.findTab(id).tab.pinned) throw new Error('Cannot group pinned tabs');
    let win: FWindow;
    let gid: number;
    if (p.groupId !== undefined) {
      ({ win } = this.findGroup(p.groupId));
      gid = p.groupId;
    } else {
      win = this.windows.get(p.windowId ?? this.findTab(tabIds[0]!).win.id)!;
      gid = this.nextId++;
      win.groups.set(gid, { id: gid, title: '', color: 'grey', collapsed: false });
    }
    const moving = tabIds.map((id) => this.findTab(id));
    const source = new Set(moving.map((m) => m.win));
    for (const m of moving) m.win.tabs.splice(m.win.tabs.indexOf(m.tab), 1);
    // Insert after the group's last tab, or where the first moved tab was.
    const lastInGroup = win.tabs.map((t) => t.groupId).lastIndexOf(gid);
    let at = lastInGroup !== -1 ? lastInGroup + 1 : Math.min(moving[0]!.index, win.tabs.length);
    // never split another group
    while (at > 0 && at < win.tabs.length && win.tabs[at - 1]!.groupId !== NO_GROUP && win.tabs[at - 1]!.groupId === win.tabs[at]!.groupId && win.tabs[at]!.groupId !== gid) at++;
    at = Math.max(at, this.pinnedCount(win));
    for (const m of moving) {
      m.tab.groupId = gid;
      win.tabs.splice(at++, 0, m.tab);
    }
    for (const w of source) this.gc(w);
    this.gc(win);
    return gid;
  }
  async ungroupTabs(tabIds: number[]): Promise<void> {
    this.calls.push(`ungroup ${tabIds.join(',')}`);
    for (const id of tabIds) {
      const { win, tab, index } = this.findTab(id);
      if (tab.groupId === NO_GROUP) continue;
      const gid = tab.groupId;
      win.tabs.splice(index, 1);
      tab.groupId = NO_GROUP;
      const last = win.tabs.map((t) => t.groupId).lastIndexOf(gid);
      win.tabs.splice(last === -1 ? index : last + 1, 0, tab);
      this.gc(win);
    }
  }
  async updateGroup(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void> {
    this.calls.push(`updateGroup ${groupId} ${JSON.stringify(p)}`);
    const { group } = this.findGroup(groupId);
    Object.assign(group, p);
  }
  async moveGroup(groupId: number, p: { windowId: number; index: number }): Promise<void> {
    const { win, group } = this.findGroup(groupId);
    const dest = this.windows.get(p.windowId)!;
    const tabs = win.tabs.filter((t) => t.groupId === groupId);
    win.tabs = win.tabs.filter((t) => t.groupId !== groupId);
    tabs.forEach((t) => (t.active = false));
    win.groups.delete(groupId);
    dest.groups.set(groupId, group);
    dest.tabs.splice(p.index === -1 ? dest.tabs.length : p.index, 0, ...tabs);
    this.gc(win);
  }
  async createWindow(_p: { focused?: boolean }): Promise<{ windowId: number; tabIds: number[] }> {
    const id = this.addWindow([{ url: 'chrome://newtab/', active: true }], { focused: _p.focused });
    return { windowId: id, tabIds: this.windows.get(id)!.tabs.map((t) => t.id) };
  }
  async removeWindow(windowId: number): Promise<void> {
    this.windows.delete(windowId);
    if (this.focused === windowId) this.focused = this.windows.keys().next().value;
  }
  async focusWindow(windowId: number): Promise<void> {
    this.focused = windowId;
  }
  placeholderUrl(url: string, title?: string): string {
    const q = new URLSearchParams({ url, ...(title ? { title } : {}) });
    return `chrome-extension://abcdefghijklmnopabcdefghijklmnop/suspended.html?${q}`;
  }

  // ---- inspection helpers for tests
  strip(windowId = this.focused!): string[] {
    const win = this.windows.get(windowId)!;
    return win.tabs.map((t) => {
      const g = t.groupId === NO_GROUP ? '' : `[${win.groups.get(t.groupId)!.title}]`;
      return `${t.pinned ? '📌' : ''}${g}${t.url}${t.active ? ' *' : ''}`;
    });
  }
}
