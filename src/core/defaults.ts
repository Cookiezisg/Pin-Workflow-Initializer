import { uid } from './ids';
import { GROUP_COLORS } from './types';
import type {
  AiSettings, GroupColor, GroupSpec, LeftoverPolicy, MatchKind, OtherWindowsPolicy, PinSpec, Rule, RuleAction, Schedule,
  Settings, TabSpec, Workspace,
} from './types';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export const V1_DEFAULT_URLS = [
  'https://mail.google.com/mail/u/0/#inbox',
  'https://calendar.google.com/calendar/u/0/r',
  'https://drive.google.com/drive/u/0/my-drive',
];

export function defaultAi(): AiSettings {
  return {
    provider: 'off',
    anthropicModel: DEFAULT_ANTHROPIC_MODEL,
    deepseekModel: DEFAULT_DEEPSEEK_MODEL,
    openaiBaseUrl: DEFAULT_OPENAI_BASE,
    openaiModel: DEFAULT_OPENAI_MODEL,
    stripQuery: true,
  };
}

export function newWorkspace(partial: Partial<Workspace> = {}): Workspace {
  return {
    id: uid(),
    name: 'Workspace',
    icon: '🗂️',
    color: 'blue',
    pins: [],
    groups: [],
    ungrouped: 'archive',
    otherWindows: 'keep',
    collapseGroups: true,
    openNewTab: true,
    ...partial,
  };
}

export function pin(url: string, match?: string): PinSpec {
  return { id: uid(), url, ...(match ? { match } : {}) };
}

export function defaultWorkspaces(): Workspace[] {
  return [
    newWorkspace({
      name: 'Work',
      icon: '💼',
      color: 'blue',
      pins: V1_DEFAULT_URLS.map((u) => pin(u)),
      otherWindows: 'archive',
    }),
    newWorkspace({ name: 'Focus', icon: '🎯', color: 'purple', otherWindows: 'archive' }),
  ];
}

export function defaultSettings(workspaces: Workspace[] = []): Settings {
  const focus = workspaces.find((w) => w.name === 'Focus');
  const rules: Rule[] = focus
    ? [
        {
          id: uid(),
          enabled: true,
          kind: 'regex',
          pattern: '^https?://([^/]*\\.)?(x|twitter|youtube|reddit|weibo|bilibili|douyin)\\.com/',
          action: { type: 'block' },
          workspaceIds: [focus.id],
        },
      ]
    : [];
  return {
    version: 2,
    rules,
    schedules: [],
    dedupeLive: false,
    dedupeOnApply: true,
    idleArchiveMinutes: 0,
    idleArchiveSkipGrouped: true,
    lazyRestore: true,
    pinsOnStartup: true,
    autoSnapshotMinutes: 30,
    snapshotLimit: 100,
    archiveLimit: 5000,
    notifications: true,
    locale: 'auto',
    theme: 'auto',
    ai: defaultAi(),
  };
}

/** v1 stored a flat `pinnedUrls` list and nuked everything else on every press. */
export function migrateV1(pinnedUrls: unknown): Workspace {
  const urls = Array.isArray(pinnedUrls) ? pinnedUrls.filter((u): u is string => typeof u === 'string' && u.trim() !== '') : [];
  return newWorkspace({
    name: 'Main',
    icon: '📌',
    pins: (urls.length ? urls : V1_DEFAULT_URLS).map((u) => pin(u.trim())),
    // v1 closed other windows and ungrouped tabs; v2 keeps the habit but makes it recoverable.
    ungrouped: 'archive',
    otherWindows: 'archive',
  });
}

// ---------------------------------------------------------------------------
// Sanitisers for imported / stored data. Unknown input in, well-formed model out.

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const color = (v: unknown, d: GroupColor = 'grey'): GroupColor => oneOf(v, GROUP_COLORS, d);

function tabSpec(v: unknown): TabSpec | null {
  const o = obj(v);
  const url = str(o.url).trim();
  if (!url) return null;
  const match = str(o.match).trim();
  return match ? { url, match } : { url };
}

export function sanitizeWorkspace(v: unknown): Workspace {
  const o = obj(v);
  return {
    id: str(o.id) || uid(),
    name: str(o.name, 'Workspace').slice(0, 60) || 'Workspace',
    icon: str(o.icon, '🗂️').slice(0, 8) || '🗂️',
    color: color(o.color, 'blue'),
    pins: arr(o.pins)
      .map((p) => {
        const s = tabSpec(p);
        return s ? ({ id: str(obj(p).id) || uid(), ...s } as PinSpec) : null;
      })
      .filter((p): p is PinSpec => p !== null),
    groups: arr(o.groups).map((g): GroupSpec => {
      const go = obj(g);
      return {
        id: str(go.id) || uid(),
        title: str(go.title).slice(0, 80),
        color: color(go.color),
        collapsed: bool(go.collapsed, false),
        tabs: arr(go.tabs).map(tabSpec).filter((t): t is TabSpec => t !== null),
      };
    }),
    ungrouped: oneOf<LeftoverPolicy>(o.ungrouped, ['keep', 'archive', 'close'], 'archive'),
    otherWindows: oneOf<OtherWindowsPolicy>(o.otherWindows, ['keep', 'merge', 'archive', 'close'], 'keep'),
    collapseGroups: bool(o.collapseGroups, true),
    openNewTab: bool(o.openNewTab, true),
  };
}

function ruleAction(v: unknown): RuleAction {
  const o = obj(v);
  if (o.type === 'pin') return { type: 'pin' };
  if (o.type === 'block') return { type: 'block' };
  return { type: 'group', title: str(o.title, 'Group').slice(0, 80), color: color(o.color) };
}

export function sanitizeSettings(v: unknown): Settings {
  const o = obj(v);
  const d = defaultSettings();
  const ai = obj(o.ai);
  return {
    version: 2,
    rules: arr(o.rules).map(
      (r): Rule => {
        const ro = obj(r);
        return {
          id: str(ro.id) || uid(),
          enabled: bool(ro.enabled, true),
          kind: oneOf<MatchKind>(ro.kind, ['domain', 'glob', 'regex'], 'domain'),
          pattern: str(ro.pattern),
          action: ruleAction(ro.action),
          workspaceIds: arr(ro.workspaceIds).filter((x): x is string => typeof x === 'string'),
        };
      },
    ),
    schedules: arr(o.schedules).map(
      (s): Schedule => {
        const so = obj(s);
        const time = str(so.time, '09:00');
        return {
          id: str(so.id) || uid(),
          enabled: bool(so.enabled, true),
          workspaceId: str(so.workspaceId),
          days: arr(so.days).filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6),
          time: /^\d{2}:\d{2}$/.test(time) ? time : '09:00',
        };
      },
    ),
    dedupeLive: bool(o.dedupeLive, d.dedupeLive),
    dedupeOnApply: bool(o.dedupeOnApply, d.dedupeOnApply),
    idleArchiveMinutes: num(o.idleArchiveMinutes, d.idleArchiveMinutes, 0, 60 * 24 * 30),
    idleArchiveSkipGrouped: bool(o.idleArchiveSkipGrouped, d.idleArchiveSkipGrouped),
    lazyRestore: bool(o.lazyRestore, d.lazyRestore),
    pinsOnStartup: bool(o.pinsOnStartup, d.pinsOnStartup),
    autoSnapshotMinutes: num(o.autoSnapshotMinutes, d.autoSnapshotMinutes, 0, 60 * 24),
    snapshotLimit: num(o.snapshotLimit, d.snapshotLimit, 5, 1000),
    archiveLimit: num(o.archiveLimit, d.archiveLimit, 50, 50000),
    notifications: bool(o.notifications, d.notifications),
    locale: oneOf(o.locale, ['auto', 'en', 'zh'] as const, 'auto'),
    theme: oneOf(o.theme, ['auto', 'light', 'dark'] as const, 'auto'),
    ai: {
      provider: oneOf(ai.provider, ['off', 'builtin', 'deepseek', 'anthropic', 'openai'] as const, 'off'),
      anthropicModel: str(ai.anthropicModel) || DEFAULT_ANTHROPIC_MODEL,
      deepseekModel: str(ai.deepseekModel) || DEFAULT_DEEPSEEK_MODEL,
      openaiBaseUrl: str(ai.openaiBaseUrl) || DEFAULT_OPENAI_BASE,
      openaiModel: str(ai.openaiModel) || DEFAULT_OPENAI_MODEL,
      stripQuery: bool(ai.stripQuery, true),
    },
  };
}

export interface ExportBundle {
  format: 'pin-workflow-initializer';
  version: 2;
  exportedAt: string;
  workspaces: Workspace[];
  settings: Settings;
}

export function parseImport(text: string): { workspaces: Workspace[]; settings: Settings } {
  const data = obj(JSON.parse(text));
  if (data.format !== 'pin-workflow-initializer') throw new Error('Not a Pin Workflow Initializer export');
  const workspaces = arr(data.workspaces).map(sanitizeWorkspace);
  if (workspaces.length === 0) throw new Error('Export contains no workspaces');
  return { workspaces, settings: sanitizeSettings(data.settings) };
}
