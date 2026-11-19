import type { GroupColor, LiveWindow } from '../core/types';

/**
 * The slice of the browser the engine needs. Implemented over chrome.* in production
 * (chrome-api.ts) and by an in-memory simulator in tests (tests/fake-browser.ts).
 */
export interface BrowserApi {
  getWindow(windowId: number): Promise<LiveWindow>;
  /** Normal (non-popup) windows, incognito included and flagged. */
  getAllWindows(): Promise<LiveWindow[]>;
  focusedWindowId(): Promise<number | undefined>;
  createTab(p: { windowId: number; url: string; pinned?: boolean; index?: number; active?: boolean }): Promise<number>;
  updateTab(tabId: number, p: { pinned?: boolean; active?: boolean; url?: string }): Promise<void>;
  moveTabs(tabIds: number[], p: { windowId?: number; index: number }): Promise<void>;
  removeTabs(tabIds: number[]): Promise<void>;
  /** Adds to `groupId`, or creates a new group in `windowId`. Returns the group id. */
  groupTabs(tabIds: number[], p: { groupId?: number; windowId?: number }): Promise<number>;
  ungroupTabs(tabIds: number[]): Promise<void>;
  updateGroup(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void>;
  moveGroup(groupId: number, p: { windowId: number; index: number }): Promise<void>;
  createWindow(p: { focused?: boolean }): Promise<{ windowId: number; tabIds: number[] }>;
  removeWindow(windowId: number): Promise<void>;
  focusWindow(windowId: number): Promise<void>;
  /** URL of the lazy-restore placeholder page for `url`. */
  placeholderUrl(url: string, title?: string): string;
}
