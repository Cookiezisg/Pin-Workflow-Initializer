/** Builders that turn workspaces, sessions and snapshots into planner targets, and live windows into snapshots. */
import { isNewTabUrl, normalizeUrl, specMatcher, unwrapUrl } from './match';
import type { Target, TargetGroup, TargetTab } from './plan';
import { NO_GROUP } from './types';
import type { LiveWindow, Settings, WindowSnap, Workspace } from './types';

/** "Initialize": converge to the workspace's pins and preset groups, deal with clutter per policy. */
export function targetForApply(ws: Workspace, settings: Pick<Settings, 'dedupeOnApply'>): Target {
  return {
    pins: ws.pins.map((p) => ({ url: p.url, match: p.match })),
    groups: ws.groups.map((g) => ({
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      tabs: g.tabs.map((t) => ({ url: t.url, match: t.match })),
    })),
    loose: [],
    leftoverUngrouped: ws.ungrouped,
    leftoverGroups: 'keep',
    collapseGroups: ws.collapseGroups,
    activate: ws.openNewTab ? { kind: 'newtab' } : { kind: 'keep' },
    dedupe: settings.dedupeOnApply,
  };
}

/** Only re-assert pins; touch nothing else. Used on browser start-up and after editing pins. */
export function targetForPins(ws: Workspace): Target {
  return {
    pins: ws.pins.map((p) => ({ url: p.url, match: p.match })),
    groups: [],
    loose: [],
    leftoverUngrouped: 'keep',
    leftoverGroups: 'keep',
    keepExtraPins: true,
    collapseGroups: false,
    activate: { kind: 'keep' },
    dedupe: false,
  };
}

function snapGroups(snap: WindowSnap, lazy: boolean): TargetGroup[] {
  return snap.groups.map((g, gi) => ({
    title: g.title,
    color: g.color,
    collapsed: g.collapsed,
    tabs: snap.tabs
      .filter((t) => t.group === gi && !t.pinned)
      .map((t) => ({ url: t.url, title: t.title, exact: true, lazy: lazy && !t.active })),
  }));
}

/** Order of groups and loose tabs in a snapshot, as indexes into snapGroups / snapLoose. */
function snapSequence(snap: WindowSnap): ({ group: number } | { loose: number })[] {
  const out: ({ group: number } | { loose: number })[] = [];
  const seen = new Set<number>();
  let loose = 0;
  for (const t of snap.tabs) {
    if (t.pinned) continue;
    if (t.group !== null) {
      if (!seen.has(t.group)) out.push({ group: t.group });
      seen.add(t.group);
    } else if (!isNewTabUrl(t.url)) out.push({ loose: loose++ });
  }
  return out;
}

function snapLoose(snap: WindowSnap, lazy: boolean): TargetTab[] {
  return snap.tabs
    .filter((t) => t.group === null && !t.pinned && !isNewTabUrl(t.url))
    .map((t) => ({ url: t.url, title: t.title, exact: true, lazy: lazy && !t.active }));
}

/**
 * Switch the window to `ws`: its pins + whatever was open the last time you left it (its session),
 * merged with its preset groups. Everything else goes — it was saved into the previous workspace's
 * session (and a snapshot) just before.
 */
export function targetForSwitch(ws: Workspace, session: WindowSnap | undefined, settings: Pick<Settings, 'lazyRestore' | 'dedupeOnApply'>): Target {
  const lazy = settings.lazyRestore;
  // A session tab that matches a pin becomes that pin (restoring e.g. the Gmail thread you had open)
  // instead of reopening the pin's URL next to it.
  const pins: TargetTab[] = ws.pins.map((p) => ({ url: p.url, match: p.match }));
  if (session) {
    session = { ...session, tabs: [...session.tabs] };
    for (const p of pins) {
      const m = specMatcher(p);
      const i = session.tabs.findIndex((t) => !t.pinned && m(t.url));
      if (i === -1) continue;
      p.url = session.tabs[i]!.url;
      session.tabs.splice(i, 1);
    }
  }
  const groups = session ? snapGroups(session, lazy) : [];
  for (const preset of ws.groups) {
    const existing = groups.find((g) => g.title.trim().toLowerCase() === preset.title.trim().toLowerCase());
    if (!existing) {
      groups.push({ title: preset.title, color: preset.color, collapsed: preset.collapsed, tabs: preset.tabs.map((t) => ({ ...t })) });
      continue;
    }
    for (const spec of preset.tabs) {
      const m = specMatcher(spec);
      if (!existing.tabs.some((t) => m(t.url))) existing.tabs.push({ url: spec.url, match: spec.match });
    }
  }
  const active = session?.tabs.find((t) => t.active);
  return {
    pins,
    groups,
    loose: session ? snapLoose(session, lazy) : [],
    leftoverUngrouped: 'close',
    leftoverGroups: 'close',
    collapseGroups: ws.collapseGroups,
    activate: active && !isNewTabUrl(active.url) ? { kind: 'url', url: active.url } : { kind: 'newtab' },
    dedupe: settings.dedupeOnApply,
    ordered: true,
    sequence: session ? snapSequence(session) : undefined,
  };
}

/** Put a window back exactly as a snapshot recorded it. */
export function targetForRestore(snap: WindowSnap, lazy: boolean): Target {
  const active = snap.tabs.find((t) => t.active);
  return {
    pins: snap.tabs.filter((t) => t.pinned).map((t) => ({ url: t.url, title: t.title, exact: true })),
    groups: snapGroups(snap, lazy),
    loose: snapLoose(snap, lazy),
    leftoverUngrouped: 'close',
    leftoverGroups: 'close',
    collapseGroups: false,
    activate: active && !isNewTabUrl(active.url) ? { kind: 'url', url: active.url } : { kind: 'newtab' },
    dedupe: false,
    ordered: true,
    sequence: snapSequence(snap),
  };
}

export function snapshotWindow(win: LiveWindow): WindowSnap {
  const tabs = [...win.tabs].sort((a, b) => a.index - b.index);
  const used = win.groups.filter((g) => tabs.some((t) => t.groupId === g.id));
  const index = new Map(used.map((g, i) => [g.id, i]));
  return {
    windowId: win.id,
    focused: win.focused,
    groups: used.map((g) => ({ title: g.title, color: g.color, collapsed: g.collapsed })),
    tabs: tabs.map((t) => ({
      url: unwrapUrl(t.url),
      title: t.title,
      pinned: t.pinned,
      group: t.groupId === NO_GROUP ? null : index.get(t.groupId) ?? null,
      active: t.active,
    })),
  };
}

/** The part of a window that belongs to a workspace's session: everything except pins and blank tabs. */
export function sessionFromWindow(win: LiveWindow): WindowSnap {
  const snap = snapshotWindow(win);
  const tabs = snap.tabs.filter((t) => !t.pinned && !isNewTabUrl(t.url));
  const usedGroups = [...new Set(tabs.map((t) => t.group).filter((g): g is number => g !== null))].sort((a, b) => a - b);
  const remap = new Map(usedGroups.map((g, i) => [g, i]));
  return {
    focused: true,
    groups: usedGroups.map((g) => snap.groups[g]!),
    tabs: tabs.map((t) => ({ ...t, group: t.group === null ? null : remap.get(t.group)! })),
  };
}

export function countTabs(windows: WindowSnap[]): number {
  return windows.reduce((n, w) => n + w.tabs.length, 0);
}

/** Cheap structural fingerprint used to skip redundant automatic snapshots. */
export function fingerprint(windows: WindowSnap[]): string {
  return windows
    .map((w) => w.tabs.map((t) => `${t.pinned ? 'P' : ''}${t.group ?? ''}|${normalizeUrl(t.url)}`).join('\n') + '#' + w.groups.map((g) => g.title).join(','))
    .sort()
    .join('\n--\n');
}
