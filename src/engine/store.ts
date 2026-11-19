import type { PlanSummary } from '../core/plan';
import type { ArchivedTab, Secrets, Settings, Snapshot, WindowSnap, Workspace } from '../core/types';

export interface RunReport {
  at: number;
  action: string;
  workspaceId?: string;
  summary?: PlanSummary;
  errors: string[];
  snapshotId?: string;
  message?: string;
}

export interface AppState {
  activeWorkspaceId?: string;
  /** schedule id → occurrence key that already fired */
  lastFired: Record<string, string>;
  lastFingerprint?: string;
  lastRun?: RunReport;
}

/** Persistence used by the engine. chrome-store.ts in production, MemoryStore in tests. */
export interface Store {
  getWorkspaces(): Promise<Workspace[]>;
  saveWorkspaces(list: Workspace[]): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  getSecrets(): Promise<Secrets>;
  getState(): Promise<AppState>;
  patchState(p: Partial<AppState>): Promise<void>;
  getSession(workspaceId: string): Promise<WindowSnap | undefined>;
  setSession(workspaceId: string, s: WindowSnap | undefined): Promise<void>;
  addSnapshot(s: Snapshot): Promise<void>;
  /** Newest first. */
  listSnapshots(): Promise<Snapshot[]>;
  getSnapshot(id: string): Promise<Snapshot | undefined>;
  patchSnapshot(id: string, p: Partial<Snapshot>): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;
  pruneSnapshots(limit: number): Promise<void>;
  addArchived(list: ArchivedTab[]): Promise<void>;
  /** Newest first. */
  listArchived(): Promise<ArchivedTab[]>;
  /** Remove and return. */
  takeArchived(ids: string[]): Promise<ArchivedTab[]>;
  clearArchive(): Promise<void>;
  pruneArchive(limit: number): Promise<void>;
}
