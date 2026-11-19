/** Typed request/response between extension pages and the background service worker. */
import type { Plan } from '../core/plan';
import type { GroupColor, Snapshot, Workspace } from '../core/types';
import type { RunReport } from '../engine/store';

export interface RpcMap {
  apply: { args: { workspaceId?: string }; result: RunReport };
  switchTo: { args: { workspaceId: string }; result: RunReport };
  switchNext: { args: { direction: 1 | -1 }; result: RunReport };
  ensurePins: { args: Record<string, never>; result: RunReport };
  preview: { args: { kind: 'apply' | 'switch'; workspaceId?: string }; result: Plan };
  undo: { args: Record<string, never>; result: RunReport };
  snapshot: { args: { label?: string }; result: Snapshot };
  restoreSnapshot: { args: { id: string }; result: RunReport };
  deleteSnapshot: { args: { id: string }; result: null };
  archiveTabs: { args: { tabIds: number[] }; result: number };
  archiveUngrouped: { args: Record<string, never>; result: RunReport };
  restoreArchived: { args: { ids: string[] }; result: number };
  dedupe: { args: Record<string, never>; result: RunReport };
  collapseAll: { args: Record<string, never>; result: null };
  mergeWindows: { args: Record<string, never>; result: RunReport };
  applyGrouping: { args: { groups: { title: string; color: GroupColor; tabIds: number[] }[] }; result: RunReport };
  newWorkspaceFromWindow: { args: { name: string; icon?: string }; result: Workspace };
  moveTabToWorkspace: { args: { tabId: number; workspaceId: string }; result: null };
  allowHost: { args: { host: string; minutes: number }; result: null };
}

export type RpcName = keyof RpcMap;
export interface RpcRequest<K extends RpcName = RpcName> {
  rpc: K;
  args: RpcMap[K]['args'];
}
export type RpcResponse<K extends RpcName = RpcName> = { ok: true; result: RpcMap[K]['result'] } | { ok: false; error: string };

export async function call<K extends RpcName>(rpc: K, ...rest: RpcMap[K]['args'] extends Record<string, never> ? [] : [RpcMap[K]['args']]): Promise<RpcMap[K]['result']> {
  const res = (await chrome.runtime.sendMessage({ rpc, args: rest[0] ?? {} } satisfies RpcRequest<K>)) as RpcResponse<K> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
