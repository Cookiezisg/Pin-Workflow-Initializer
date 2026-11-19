// Core domain model. Everything in src/core is pure (no chrome.* access) so it can be unit tested.

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** A tab the workspace wants to exist. `match` overrides how existing tabs are recognised as "the same". */
export interface TabSpec {
  url: string;
  /** Glob (`*://mail.google.com/*`) or `/regex/`. Empty = default matching (see match.ts). */
  match?: string;
}

export interface PinSpec extends TabSpec {
  id: string;
}

export interface GroupSpec {
  id: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabs: TabSpec[];
}

/** What to do with tabs that are not part of the target state. */
export type LeftoverPolicy = 'keep' | 'archive' | 'close';
export type OtherWindowsPolicy = 'keep' | 'merge' | 'archive' | 'close';

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  color: GroupColor;
  pins: PinSpec[];
  /** Preset groups that are (re)created whenever the workspace is applied. */
  groups: GroupSpec[];
  /** On "apply": what happens to ungrouped tabs that are not pins. */
  ungrouped: LeftoverPolicy;
  /** On "apply": what happens to other browser windows. */
  otherWindows: OtherWindowsPolicy;
  collapseGroups: boolean;
  openNewTab: boolean;
}

export type MatchKind = 'domain' | 'glob' | 'regex';

export type RuleAction =
  | { type: 'group'; title: string; color: GroupColor }
  | { type: 'pin' }
  | { type: 'block' };

export interface Rule {
  id: string;
  enabled: boolean;
  kind: MatchKind;
  pattern: string;
  action: RuleAction;
  /** Restrict the rule to these workspaces. Empty = all workspaces. */
  workspaceIds: string[];
}

export interface Schedule {
  id: string;
  enabled: boolean;
  workspaceId: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** "HH:MM", 24h, local time */
  time: string;
}

export type AiProvider = 'off' | 'builtin' | 'deepseek' | 'anthropic' | 'openai';

export interface AiSettings {
  provider: AiProvider;
  anthropicModel: string;
  deepseekModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  /** Strip query strings and fragments from URLs before sending them to a model. */
  stripQuery: boolean;
}

export interface Settings {
  version: 2;
  rules: Rule[];
  schedules: Schedule[];
  /** Close a freshly opened tab if the same URL is already open in the window. */
  dedupeLive: boolean;
  /** Close duplicate tabs whenever a workspace is applied. */
  dedupeOnApply: boolean;
  /** 0 disables idle archiving. */
  idleArchiveMinutes: number;
  idleArchiveSkipGrouped: boolean;
  /** Restored session tabs are opened as lightweight placeholders that load on focus. */
  lazyRestore: boolean;
  /** Re-assert the active workspace's pins when the browser starts. */
  pinsOnStartup: boolean;
  /** Take a background snapshot every N minutes (0 = off). */
  autoSnapshotMinutes: number;
  snapshotLimit: number;
  archiveLimit: number;
  notifications: boolean;
  locale: 'auto' | 'en' | 'zh';
  theme: 'auto' | 'light' | 'dark';
  ai: AiSettings;
}

export interface Secrets {
  anthropicKey?: string;
  deepseekKey?: string;
  openaiKey?: string;
}

// ---------------------------------------------------------------------------
// Snapshots, sessions and the archive

export interface TabSnap {
  url: string;
  title: string;
  pinned: boolean;
  /** Index into WindowSnap.groups, or null when ungrouped. */
  group: number | null;
  active: boolean;
}

export interface GroupSnap {
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface WindowSnap {
  windowId?: number;
  focused: boolean;
  tabs: TabSnap[];
  groups: GroupSnap[];
}

export interface Snapshot {
  id: string;
  createdAt: number;
  reason: SnapshotReason;
  label?: string;
  workspaceId?: string;
  windows: WindowSnap[];
  tabCount: number;
  undone?: boolean;
}

export type SnapshotReason = 'apply' | 'switch' | 'undo' | 'restore' | 'manual' | 'auto' | 'ai' | 'archive' | 'merge';

export interface ArchivedTab {
  id: string;
  url: string;
  title: string;
  archivedAt: number;
  workspaceId?: string;
  groupTitle?: string;
  reason: 'manual' | 'idle' | 'apply' | 'window';
}

// ---------------------------------------------------------------------------
// Live browser state as seen by the planner

export interface LiveTab {
  id: number;
  index: number;
  url: string;
  title: string;
  pinned: boolean;
  /** -1 when ungrouped (mirrors chrome.tabGroups.TAB_GROUP_ID_NONE). */
  groupId: number;
  active: boolean;
  audible?: boolean;
  lastAccessed?: number;
  favIconUrl?: string;
}

export interface LiveGroup {
  id: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface LiveWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  tabs: LiveTab[];
  groups: LiveGroup[];
}

export const NO_GROUP = -1;
