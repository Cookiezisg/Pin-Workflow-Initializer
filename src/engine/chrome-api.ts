import type { GroupColor, LiveGroup, LiveTab, LiveWindow } from '../core/types';
import type { BrowserApi } from './api';

function toTab(t: chrome.tabs.Tab): LiveTab {
  return {
    id: t.id!,
    index: t.index,
    url: t.url || t.pendingUrl || '',
    title: t.title ?? '',
    pinned: t.pinned,
    groupId: t.groupId ?? -1,
    active: t.active,
    audible: t.audible,
    lastAccessed: (t as { lastAccessed?: number }).lastAccessed,
    favIconUrl: t.favIconUrl,
  };
}

function toGroup(g: chrome.tabGroups.TabGroup): LiveGroup {
  return { id: g.id, title: g.title ?? '', color: g.color as GroupColor, collapsed: g.collapsed };
}

function toWindow(w: chrome.windows.Window, groups: chrome.tabGroups.TabGroup[]): LiveWindow {
  return {
    id: w.id!,
    focused: w.focused,
    incognito: w.incognito,
    tabs: (w.tabs ?? []).filter((t) => t.id !== undefined).map(toTab).sort((a, b) => a.index - b.index),
    groups: groups.filter((g) => g.windowId === w.id).map(toGroup),
  };
}

type TabIds = [number, ...number[]];

export const chromeApi: BrowserApi = {
  async getWindow(windowId) {
    const [w, groups] = await Promise.all([chrome.windows.get(windowId, { populate: true }), chrome.tabGroups.query({ windowId })]);
    return toWindow(w, groups);
  },
  async getAllWindows() {
    const [wins, groups] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      chrome.tabGroups.query({}),
    ]);
    return wins.map((w) => toWindow(w, groups));
  },
  async focusedWindowId() {
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      return w.id;
    } catch {
      return undefined;
    }
  },
  async createTab(p) {
    const t = await chrome.tabs.create({ windowId: p.windowId, url: p.url, pinned: p.pinned, index: p.index, active: p.active ?? false });
    return t.id!;
  },
  async updateTab(tabId, p) {
    await chrome.tabs.update(tabId, p);
  },
  async moveTabs(tabIds, p) {
    await chrome.tabs.move(tabIds as TabIds, { index: p.index, ...(p.windowId !== undefined && { windowId: p.windowId }) });
  },
  async removeTabs(tabIds) {
    await chrome.tabs.remove(tabIds);
  },
  async groupTabs(tabIds, p) {
    return chrome.tabs.group({
      tabIds: tabIds as TabIds,
      ...(p.groupId !== undefined ? { groupId: p.groupId } : p.windowId !== undefined ? { createProperties: { windowId: p.windowId } } : {}),
    });
  },
  async ungroupTabs(tabIds) {
    await chrome.tabs.ungroup(tabIds as TabIds);
  },
  async updateGroup(groupId, p) {
    await chrome.tabGroups.update(groupId, p as chrome.tabGroups.UpdateProperties);
  },
  async moveGroup(groupId, p) {
    await chrome.tabGroups.move(groupId, p);
  },
  async createWindow(p) {
    const w = await chrome.windows.create({ focused: p.focused ?? false });
    return { windowId: w!.id!, tabIds: (w!.tabs ?? []).map((t) => t.id!) };
  },
  async removeWindow(windowId) {
    await chrome.windows.remove(windowId);
  },
  async focusWindow(windowId) {
    await chrome.windows.update(windowId, { focused: true });
  },
  placeholderUrl(url, title) {
    const q = new URLSearchParams({ url, ...(title ? { title } : {}) });
    return `${chrome.runtime.getURL('/suspended.html')}?${q}`;
  },
};
