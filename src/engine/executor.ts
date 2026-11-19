import type { GroupRef, Op, TabRef } from '../core/plan';
import type { LiveGroup, LiveTab } from '../core/types';
import type { BrowserApi } from './api';

export interface ExecuteResult {
  /** Plan refs → real tab / group ids. */
  refs: Map<string, number>;
  errors: string[];
}

export interface ExecuteHooks {
  /** Persist tabs into the archive before they are closed. */
  archive(tabs: LiveTab[], groups: LiveGroup[]): Promise<void>;
}

/**
 * Applies plan ops in order. Each op is best-effort: a tab the user closed mid-way just yields an
 * error entry, and the rest of the plan still runs.
 */
export async function execute(api: BrowserApi, windowId: number, ops: Op[], hooks: ExecuteHooks): Promise<ExecuteResult> {
  const refs = new Map<string, number>();
  const errors: string[] = [];
  const tab = (r: TabRef): number | undefined => (typeof r === 'number' ? r : refs.get(r));
  const group = (r: GroupRef): number | undefined => (typeof r === 'number' ? r : refs.get(r));

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'ungroup':
          await api.ungroupTabs(op.tabs);
          break;
        case 'unpin':
          await api.updateTab(op.tab, { pinned: false });
          break;
        case 'pin':
          await api.ungroupTabs([op.tab]).catch(() => undefined);
          await api.updateTab(op.tab, { pinned: true });
          await api.moveTabs([op.tab], { index: op.index });
          break;
        case 'move':
          await api.moveTabs([op.tab], { index: op.index });
          break;
        case 'create': {
          const url = op.lazy ? api.placeholderUrl(op.url, op.title) : op.url;
          const id = await api.createTab({ windowId, url, pinned: op.pinned, index: op.index, active: op.active });
          refs.set(op.ref, id);
          break;
        }
        case 'group': {
          const ids = op.tabs.map(tab).filter((x): x is number => x !== undefined);
          if (ids.length === 0) break;
          const existing = group(op.group);
          const gid = await api.groupTabs(ids, existing !== undefined ? { groupId: existing } : { windowId });
          if (typeof op.group === 'string') refs.set(op.group, gid);
          await api.updateGroup(gid, { title: op.title, color: op.color });
          break;
        }
        case 'updateGroup': {
          const gid = group(op.group);
          if (gid === undefined) break;
          const { title, color, collapsed } = op;
          await api.updateGroup(gid, { ...(title !== undefined && { title }), ...(color && { color }), ...(collapsed !== undefined && { collapsed }) });
          break;
        }
        case 'orderGroup': {
          const gid = group(op.group);
          const ids = op.tabs.map(tab).filter((x): x is number => x !== undefined);
          if (gid === undefined) break;
          // Moving a tab to an index inside its own group's range keeps it in the group.
          for (let k = 0; k < ids.length; k++) {
            const win = await api.getWindow(windowId);
            const start = win.tabs.findIndex((t) => t.groupId === gid);
            const cur = win.tabs.find((t) => t.id === ids[k]);
            if (start === -1 || !cur || cur.groupId !== gid || cur.index === start + k) continue;
            await api.moveTabs([cur.id], { index: start + k });
          }
          break;
        }
        case 'orderBlocks': {
          // Lay blocks out left to right after the pinned strip. Everything left of the cursor is
          // already placed, so each move is leftwards and never lands inside another group.
          let cursor = (await api.getWindow(windowId)).tabs.filter((t) => t.pinned).length;
          for (const b of op.blocks) {
            const win = await api.getWindow(windowId);
            if ('group' in b) {
              const gid = group(b.group);
              const members = win.tabs.filter((t) => t.groupId === gid);
              if (gid === undefined || members.length === 0) continue;
              if (members[0]!.index !== cursor) await api.moveGroup(gid, { windowId, index: cursor });
              cursor += members.length;
            } else {
              const id = tab(b.tab);
              const cur = win.tabs.find((t) => t.id === id);
              if (!cur) continue;
              if (cur.index !== cursor) await api.moveTabs([cur.id], { index: cursor });
              cursor += 1;
            }
          }
          break;
        }
        case 'archive': {
          const win = await api.getWindow(windowId);
          const set = new Set(op.tabs);
          await hooks.archive(win.tabs.filter((t) => set.has(t.id)), win.groups);
          await removeTabs(api, op.tabs);
          break;
        }
        case 'close':
          await removeTabs(api, op.tabs);
          break;
        case 'activate': {
          const id = tab(op.tab);
          if (id !== undefined) await api.updateTab(id, { active: true });
          break;
        }
      }
    } catch (e) {
      errors.push(`${op.op}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { refs, errors };
}

/** chrome.tabs.remove rejects the whole batch if one id is gone; fall back to one by one. */
export async function removeTabs(api: BrowserApi, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await api.removeTabs(ids);
  } catch {
    for (const id of ids) await api.removeTabs([id]).catch(() => undefined);
  }
}
