/**
 * The reconciler. Given the live state of one window and a declarative target, produce an ordered
 * list of operations that converges the window to the target while reusing every tab it can.
 *
 * Properties the tests hold this to:
 *  - idempotent: planning again against the result yields no ops
 *  - tabs that match a spec are reused, never reopened (keeps logins, drafts, scroll position)
 *  - pinned order is exactly the target order
 *  - creations happen before closures, so a window is never emptied (which would close it)
 */
import { isArchivable, isNewTabUrl, normalizeUrl, specMatcher, exactMatcher } from './match';
import { NO_GROUP } from './types';
import type { GroupColor, LeftoverPolicy, LiveTab, LiveWindow, TabSpec } from './types';

export interface TargetTab extends TabSpec {
  /** Match by exact URL instead of the default path scope. Used for restored sessions. */
  exact?: boolean;
  title?: string;
  /** Open as a lightweight placeholder that loads when first focused. */
  lazy?: boolean;
}

export interface TargetGroup {
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabs: TargetTab[];
}

export type Activation = { kind: 'newtab' } | { kind: 'keep' } | { kind: 'url'; url: string };

export interface Target {
  pins: TargetTab[];
  groups: TargetGroup[];
  /** Ungrouped, unpinned tabs that must exist. */
  loose: TargetTab[];
  leftoverUngrouped: LeftoverPolicy;
  leftoverGroups: LeftoverPolicy;
  /** Leave pinned tabs that aren't in `pins` pinned (after the target pins) instead of treating them as leftovers. */
  keepExtraPins?: boolean;
  /** Collapse every group left in the window (otherwise each target group's own flag decides). */
  collapseGroups: boolean;
  activate: Activation;
  dedupe: boolean;
  /** Also restore the order of tabs inside each target group (sessions, snapshots). */
  ordered?: boolean;
  /** With `ordered`: the order of groups and loose tabs after the pins (indexes into groups / loose). */
  sequence?: ({ group: number } | { loose: number })[];
}

/** An existing tab id, or the ref of a tab this plan creates. */
export type TabRef = number | string;
/** An existing group id, or the ref of a group this plan creates. */
export type GroupRef = number | string;

export type Op =
  | { op: 'ungroup'; tabs: number[] }
  | { op: 'unpin'; tab: number }
  | { op: 'pin'; tab: number; index: number }
  | { op: 'move'; tab: number; index: number }
  | { op: 'create'; ref: string; url: string; title?: string; pinned: boolean; index?: number; lazy: boolean; active: boolean }
  | { op: 'group'; tabs: TabRef[]; group: GroupRef; title: string; color: GroupColor }
  | { op: 'updateGroup'; group: GroupRef; title?: string; color?: GroupColor; collapsed?: boolean }
  | { op: 'orderGroup'; group: GroupRef; tabs: TabRef[] }
  | { op: 'orderBlocks'; blocks: ({ group: GroupRef } | { tab: TabRef })[] }
  | { op: 'archive'; tabs: number[] }
  | { op: 'close'; tabs: number[] }
  | { op: 'activate'; tab: TabRef };

export interface PlanSummary {
  reused: number;
  created: number;
  moved: number;
  grouped: number;
  archived: number;
  closed: number;
}

export interface Plan {
  ops: Op[];
  summary: PlanSummary;
}

export function isNoop(p: Plan): boolean {
  return p.ops.length === 0;
}

type Pref = (t: LiveTab) => number; // < 0 = not eligible, higher = better

export function plan(win: LiveWindow, target: Target): Plan {
  const tabs = [...win.tabs].sort((a, b) => a.index - b.index);
  const claimed = new Map<number, 'pin' | 'group' | 'loose' | 'activate'>();
  const tabGroupOf = new Map<TabRef, GroupRef>(); // final group of each claimed / created tab
  let seq = 0;
  const newRef = () => `t${seq++}`;
  const summary: PlanSummary = { reused: 0, created: 0, moved: 0, grouped: 0, archived: 0, closed: 0 };

  // Which live groups are "the same" as a target group (by title, case-insensitive).
  const groupOfTarget = new Map<number, number>(); // target index → live group id
  const claimedGroups = new Set<number>();
  target.groups.forEach((g, gi) => {
    const key = g.title.trim().toLowerCase();
    if (!key) return;
    const live = win.groups.find((lg) => !claimedGroups.has(lg.id) && lg.title.trim().toLowerCase() === key);
    if (live) {
      groupOfTarget.set(gi, live.id);
      claimedGroups.add(live.id);
    }
  });
  const leftoverPolicyOf = (t: LiveTab): LeftoverPolicy => {
    if (t.groupId === NO_GROUP) return t.pinned && target.keepExtraPins ? 'keep' : target.leftoverUngrouped;
    return target.leftoverGroups;
  };
  // A tab whose group is going away anyway may be taken by a spec.
  const inDoomedGroup = (t: LiveTab) =>
    t.groupId !== NO_GROUP && !claimedGroups.has(t.groupId) && target.leftoverGroups !== 'keep';

  const pick = (spec: TargetTab, pref: Pref): LiveTab | undefined => {
    const m = specMatcher(spec, spec.exact);
    let best: LiveTab | undefined;
    let bestScore = -Infinity;
    for (const t of tabs) {
      if (claimed.has(t.id) || !m(t.url)) continue;
      const p = pref(t);
      if (p < 0) continue;
      const score = p * 10 + (t.active ? 1 : 0);
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  };

  // ---- pins
  const prefPin: Pref = (t) => (t.pinned ? 3 : t.groupId === NO_GROUP ? 2 : inDoomedGroup(t) ? 1 : -1);
  const pinRefs: (LiveTab | { spec: TargetTab; ref: string })[] = target.pins.map((spec) => {
    const t = pick(spec, prefPin);
    if (t) {
      claimed.set(t.id, 'pin');
      summary.reused++;
      return t;
    }
    return { spec, ref: newRef() };
  });

  // ---- groups
  const groupPhase: Op[] = [];
  const collapsePhase: Op[] = [];
  const groupRefOf: (GroupRef | undefined)[] = [];
  let groupsDirty = false;
  target.groups.forEach((g, gi) => {
    const liveId = groupOfTarget.get(gi);
    const liveGroup = liveId === undefined ? undefined : win.groups.find((x) => x.id === liveId);
    const pref: Pref = (t) =>
      liveId !== undefined && t.groupId === liveId
        ? 4
        : t.groupId === NO_GROUP && !t.pinned
          ? 3
          : t.groupId === NO_GROUP
            ? 2
            : inDoomedGroup(t)
              ? 1
              : -1;
    const gref: GroupRef = liveId ?? `g${gi}`;
    const toAdd: TabRef[] = [];
    const order: TabRef[] = [];
    const liveIndexes: number[] = [];
    let members = 0;
    for (const spec of g.tabs) {
      const t = pick(spec, pref);
      if (t) {
        claimed.set(t.id, 'group');
        summary.reused++;
        tabGroupOf.set(t.id, gref);
        members++;
        order.push(t.id);
        liveIndexes.push(t.index);
        if (t.groupId !== liveId) toAdd.push(t.id);
      } else {
        const ref = newRef();
        groupPhase.push(createOp(ref, spec, false));
        summary.created++;
        tabGroupOf.set(ref, gref);
        members++;
        order.push(ref);
        toAdd.push(ref);
      }
    }
    if (toAdd.length > 0) {
      groupPhase.push({ op: 'group', tabs: toAdd, group: gref, title: g.title, color: g.color });
      summary.grouped += toAdd.length;
    } else if (liveGroup && (liveGroup.color !== g.color || liveGroup.title !== g.title)) {
      groupPhase.push({ op: 'updateGroup', group: gref, title: g.title, color: g.color });
    }
    const inOrder = toAdd.length === 0 && liveIndexes.every((v, i) => i === 0 || v > liveIndexes[i - 1]!);
    if (target.ordered && order.length > 1 && !inOrder) groupPhase.push({ op: 'orderGroup', group: gref, tabs: order });
    if (toAdd.length > 0 || !inOrder) groupsDirty = true;
    if (members === 0 && liveId === undefined) return; // empty group spec: nothing to create
    groupRefOf[gi] = gref;
    const wantCollapsed = target.collapseGroups || g.collapsed;
    if (liveGroup ? liveGroup.collapsed !== wantCollapsed : wantCollapsed) {
      collapsePhase.push({ op: 'updateGroup', group: gref, collapsed: wantCollapsed });
    }
  });

  // ---- loose tabs
  const loosePhase: Op[] = [];
  const ungroupIds: number[] = [];
  const prefLoose: Pref = (t) =>
    t.groupId === NO_GROUP && !t.pinned ? 3 : t.groupId === NO_GROUP ? 2 : inDoomedGroup(t) ? 1 : -1;
  const looseRefOf: TabRef[] = [];
  for (const spec of target.loose) {
    const t = pick(spec, prefLoose);
    if (t) {
      claimed.set(t.id, 'loose');
      summary.reused++;
      looseRefOf.push(t.id);
      if (t.groupId !== NO_GROUP) ungroupIds.push(t.id);
    } else {
      const ref = newRef();
      loosePhase.push(createOp(ref, spec, false));
      looseRefOf.push(ref);
      summary.created++;
    }
  }

  // ---- order of groups and loose tabs (restores only)
  const orderPhase: Op[] = [];
  if (target.ordered && target.sequence) {
    const blocks = target.sequence
      .map((b) => ('group' in b ? (groupRefOf[b.group] !== undefined ? { group: groupRefOf[b.group]! } : null) : looseRefOf[b.loose] !== undefined ? { tab: looseRefOf[b.loose]! } : null))
      .filter((b): b is { group: GroupRef } | { tab: TabRef } => b !== null);
    const start = (b: { group: GroupRef } | { tab: TabRef }): number | undefined => {
      if ('group' in b) return typeof b.group === 'number' ? tabs.find((t) => t.groupId === b.group)?.index : undefined;
      if (typeof b.tab !== 'number' || ungroupIds.includes(b.tab)) return undefined;
      return tabs.find((t) => t.id === b.tab)?.index;
    };
    const starts = blocks.map(start);
    const inPlace = !groupsDirty && starts.every((v, i) => v !== undefined && (i === 0 || v > starts[i - 1]!));
    if (blocks.length > 1 && !inPlace) orderPhase.push({ op: 'orderBlocks', blocks });
  }

  // ---- activation target
  let activateRef: TabRef | undefined;
  const activationPhase: Op[] = [];
  if (target.activate.kind === 'url') {
    const url = target.activate.url;
    const exact = exactMatcher(url);
    // Prefer something we're keeping or creating; never open a duplicate just to focus it.
    const created = [...groupPhase, ...loosePhase].find(
      (o): o is Extract<Op, { op: 'create' }> => o.op === 'create' && exact(o.url),
    );
    const existing = tabs.find((t) => claimed.has(t.id) && exact(t.url)) ?? tabs.find((t) => exact(t.url));
    if (created) {
      created.lazy = false;
      activateRef = created.ref;
    } else if (existing) {
      if (!claimed.has(existing.id)) claimed.set(existing.id, 'activate');
      activateRef = existing.id;
    }
  } else if (target.activate.kind === 'newtab') {
    const blank = tabs.find((t) => !claimed.has(t.id) && !t.pinned && t.groupId === NO_GROUP && isNewTabUrl(t.url));
    if (blank) {
      claimed.set(blank.id, 'activate');
      activateRef = blank.id;
    } else {
      const ref = newRef();
      activationPhase.push({ op: 'create', ref, url: 'chrome://newtab/', pinned: false, lazy: false, active: true });
      summary.created++;
      activateRef = ref;
    }
  }

  // ---- leftovers
  const kept: LiveTab[] = [];
  const toArchive: number[] = [];
  const toClose: number[] = [];
  for (const t of tabs) {
    if (claimed.has(t.id)) continue;
    let policy = leftoverPolicyOf(t);
    if (policy === 'archive' && !isArchivable(t.url)) policy = 'close';
    if (policy === 'keep') kept.push(t);
    else if (policy === 'archive') toArchive.push(t.id);
    else toClose.push(t.id);
  }

  if (target.dedupe) {
    const seen = new Set<string>();
    for (const t of tabs) if (claimed.has(t.id)) seen.add(normalizeUrl(t.url));
    for (const o of [...groupPhase, ...loosePhase]) if (o.op === 'create') seen.add(normalizeUrl(o.url));
    for (const p of pinRefs) if ('ref' in p) seen.add(normalizeUrl(p.spec.url));
    // Visit the active tab first so it is the copy that survives.
    const ordered = [...kept].sort((a, b) => Number(b.active) - Number(a.active));
    for (const t of ordered) {
      if (isNewTabUrl(t.url)) continue;
      const n = normalizeUrl(t.url);
      if (seen.has(n)) {
        toClose.push(t.id);
        kept.splice(kept.indexOf(t), 1);
      } else seen.add(n);
    }
  }

  // Never leave the window empty: closing its last tab would close the window itself.
  const willCreate = pinRefs.some((p) => 'ref' in p) || groupPhase.length + loosePhase.length + activationPhase.length > 0;
  if (claimed.size === 0 && kept.length === 0 && !willCreate) {
    const ref = newRef();
    activationPhase.push({ op: 'create', ref, url: 'chrome://newtab/', pinned: false, lazy: false, active: true });
    summary.created++;
    activateRef = ref;
  }

  // ---- unpin: pinned tabs that survive but are no longer pins
  const doomed = new Set([...toArchive, ...toClose]);
  const unpinPhase: Op[] = [];
  for (const t of tabs) {
    if (!t.pinned || doomed.has(t.id) || claimed.get(t.id) === 'pin') continue;
    if (!claimed.has(t.id) && target.keepExtraPins) continue;
    unpinPhase.push({ op: 'unpin', tab: t.id });
  }

  // ---- pin ordering: simulate the pinned strip and only move what is out of place
  const pinPhase: Op[] = [];
  const unpinned = new Set(unpinPhase.map((o) => (o as { tab: number }).tab));
  const strip: TabRef[] = tabs.filter((t) => t.pinned && !unpinned.has(t.id)).map((t) => t.id);
  pinRefs.forEach((p, i) => {
    if ('ref' in p) {
      pinPhase.push(createOp(p.ref, p.spec, true, i));
      summary.created++;
      strip.splice(i, 0, p.ref);
      return;
    }
    if (!p.pinned) {
      pinPhase.push({ op: 'pin', tab: p.id, index: i });
      summary.moved++;
      strip.splice(i, 0, p.id);
      return;
    }
    if (strip[i] === p.id) return;
    strip.splice(strip.indexOf(p.id), 1);
    strip.splice(i, 0, p.id);
    pinPhase.push({ op: 'move', tab: p.id, index: i });
    summary.moved++;
  });

  // ---- collapse leftover groups we keep, but never the group holding the tab we focus
  if (target.collapseGroups) {
    const keptGroups = new Set(kept.map((t) => t.groupId).filter((g) => g !== NO_GROUP && !claimedGroups.has(g)));
    for (const g of win.groups) {
      if (keptGroups.has(g.id) && !g.collapsed) collapsePhase.push({ op: 'updateGroup', group: g.id, collapsed: true });
    }
  }
  const activeGroup = activateRef === undefined ? undefined : tabGroupOf.get(activateRef) ?? liveGroupOf(tabs, activateRef);
  const collapseOps = collapsePhase.filter((o) => !(o.op === 'updateGroup' && o.collapsed && o.group === activeGroup));

  summary.archived = toArchive.length;
  summary.closed = toClose.length;

  const activeNow = tabs.find((t) => t.active)?.id;
  const ops: Op[] = [
    ...(ungroupIds.length ? [{ op: 'ungroup', tabs: ungroupIds } as Op] : []),
    ...unpinPhase,
    ...pinPhase,
    ...groupPhase,
    ...loosePhase,
    ...activationPhase,
    ...(toArchive.length ? [{ op: 'archive', tabs: toArchive } as Op] : []),
    ...(toClose.length ? [{ op: 'close', tabs: toClose } as Op] : []),
    ...orderPhase,
    ...(activateRef !== undefined && activateRef !== activeNow && !activationPhase.some((o) => o.op === 'create' && o.ref === activateRef)
      ? [{ op: 'activate', tab: activateRef } as Op]
      : []),
    ...collapseOps,
  ];
  return { ops, summary };
}

function liveGroupOf(tabs: LiveTab[], ref: TabRef): number | undefined {
  if (typeof ref !== 'number') return undefined;
  const g = tabs.find((t) => t.id === ref)?.groupId;
  return g === NO_GROUP ? undefined : g;
}

function createOp(ref: string, spec: TargetTab, pinned: boolean, index?: number): Op {
  return {
    op: 'create',
    ref,
    url: spec.url,
    title: spec.title,
    pinned,
    index,
    lazy: !pinned && !!spec.lazy,
    active: false,
  };
}
