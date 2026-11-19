/** Side panel: live dashboard of the window, workspace switcher, AI, archive and the snapshot timeline. */
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { rank } from '../../core/fuzzy';
import { isNewTabUrl } from '../../core/match';
import type { Op, Plan } from '../../core/plan';
import { NO_GROUP } from '../../core/types';
import type { ArchivedTab, LiveTab, LiveWindow, Snapshot, Workspace } from '../../core/types';
import { chromeStore } from '../../engine/chrome-store';
import { suggestGroups, summarize, type SuggestedGroup, type WorkspaceSummary } from '../../lib/ai';
import { t } from '../../lib/i18n';
import { call } from '../../lib/rpc';
import {
  displayHost, Favicon, Highlight, Icon, summaryText, timeAgo, useAction, useAppData, useCurrentWindow, useToast, type AppData,
} from '../../ui/kit';
import './panel.css';

type View = 'now' | 'archive' | 'timeline';

function App() {
  const data = useAppData();
  const win = useCurrentWindow();
  const [view, setView] = useState<View>('now');
  const [toastEl, toast] = useToast();
  const action = useAction(toast);

  if (!data) return <div class="empty">…</div>;
  return (
    <div class="panel">
      <Switcher data={data} action={action} />
      <nav class="tabs" role="tablist">
        {(['now', 'archive', 'timeline'] as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} class="tab" onClick={() => setView(v)}>
            {{ now: t('Window'), archive: t('Archive'), timeline: t('Timeline') }[v]}
          </button>
        ))}
        <span class="grow" />
        <button class="btn ghost sm icon" title={t('Settings')} onClick={() => chrome.runtime.openOptionsPage()}>
          <Icon name="settings" />
        </button>
      </nav>
      <main class="body">
        {view === 'now' && <NowView data={data} win={win} action={action} toast={toast} />}
        {view === 'archive' && <ArchiveView action={action} />}
        {view === 'timeline' && <TimelineView action={action} />}
      </main>
      {toastEl}
    </div>
  );
}

type Action = ReturnType<typeof useAction>;

function Switcher({ data, action }: { data: AppData; action: Action }) {
  return (
    <header class="switcher">
      {data.workspaces.map((w) => {
        const active = w.id === data.active?.id;
        return (
          <button
            key={w.id}
            class={`ws g-${w.color}`}
            aria-current={active}
            title={active ? t('Re-initialize {0}', w.name) : t('Switch to {0}', w.name)}
            disabled={!!action.busy}
            onClick={() =>
              void action.run(`ws:${w.id}`, () => (active ? call('apply', { workspaceId: w.id }) : call('switchTo', { workspaceId: w.id })), (r) =>
                summaryText(r.summary),
              )
            }
          >
            <span class="ws-icon">{action.busy === `ws:${w.id}` ? <span class="spinner" /> : w.icon}</span>
            <span class="ws-name">{w.name}</span>
          </button>
        );
      })}
    </header>
  );
}

// ---------------------------------------------------------------- Window view

function NowView({ data, win, action, toast }: { data: AppData; win: LiveWindow | null; action: Action; toast: (m: string, k?: 'info' | 'error') => void }) {
  const ws = data.active;
  const [preview, setPreview] = useState<Plan | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestedGroup[] | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const aiOn = data.settings.ai.provider !== 'off';

  const smartGroup = useCallback(async () => {
    if (!win) return;
    const candidates = win.tabs.filter((tb) => !tb.pinned && tb.groupId === NO_GROUP && !isNewTabUrl(tb.url));
    const secrets = await chromeStore.getSecrets();
    const groups = await action.run('ai-group', () => suggestGroups(candidates, data.settings.ai, secrets));
    if (groups) {
      setSuggestion(groups);
      if (groups.length === 0) toast(t('AI found nothing worth grouping'));
    }
  }, [win, data.settings.ai, action, toast]);

  const recap = useCallback(async () => {
    if (!win) return;
    const secrets = await chromeStore.getSecrets();
    const tabs = win.tabs.filter((tb) => !isNewTabUrl(tb.url));
    const s = await action.run('ai-summary', () => summarize(tabs, ws?.name ?? '', data.settings.ai, secrets));
    if (s) setSummary(s);
  }, [win, ws, data.settings.ai, action]);

  // Pick up a task handed over by the command palette.
  useEffect(() => {
    if (!win) return;
    const check = async () => {
      const { panelIntent } = (await chrome.storage.session.get('panelIntent')) as { panelIntent?: { intent: string; at: number } };
      if (!panelIntent || Date.now() - panelIntent.at > 15_000) return;
      await chrome.storage.session.remove('panelIntent');
      if (panelIntent.intent === 'ai-group') void smartGroup();
      if (panelIntent.intent === 'ai-summary') void recap();
    };
    void check();
    const onChange = (c: Record<string, unknown>, area: string) => area === 'session' && 'panelIntent' in c && void check();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [win !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!win || !ws) return <div class="empty">…</div>;
  const pinned = win.tabs.filter((tb) => tb.pinned);
  const ungrouped = win.tabs.filter((tb) => !tb.pinned && tb.groupId === NO_GROUP);
  const groups = win.groups
    .map((g) => ({ g, tabs: win.tabs.filter((tb) => tb.groupId === g.id) }))
    .sort((a, b) => (a.tabs[0]?.index ?? 0) - (b.tabs[0]?.index ?? 0));
  const last = data.state.lastRun;

  return (
    <div class="col" style={{ gap: '12px' }}>
      <section class={`hero g-${ws.color}`}>
        <div class="row">
          <span class="hero-icon">{ws.icon}</span>
          <div class="grow">
            <div class="hero-name">{ws.name}</div>
            <div class="small muted">
              {t('{0} tabs', win.tabs.length)} · {t('{0} groups', win.groups.length)}
              {last && ` · ${t('last run')} ${timeAgo(last.at)}`}
            </div>
          </div>
        </div>
        <div class="row wrap">
          <button class="btn primary" disabled={!!action.busy} onClick={() => void action.run('apply', () => call('apply', {}), (r) => summaryText(r.summary))}>
            {action.busy === 'apply' ? <span class="spinner" /> : <Icon name="play" />} {t('Initialize')}
          </button>
          <button class="btn" disabled={!!action.busy} onClick={() => void action.run('preview', () => call('preview', { kind: 'apply' })).then((p) => p && setPreview(p))}>
            <Icon name="eye" /> {t('Preview')}
          </button>
          <button class="btn" disabled={!!action.busy} onClick={() => void action.run('undo', () => call('undo'), (r) => (r.message === 'nothing' ? t('Nothing to undo') : t('Undone')))}>
            <Icon name="undo" /> {t('Undo')}
          </button>
        </div>
        {preview && <PlanPreview plan={preview} win={win} onClose={() => setPreview(null)} onRun={() => {
          setPreview(null);
          void action.run('apply', () => call('apply', {}), (r) => summaryText(r.summary));
        }} />}
      </section>

      {aiOn ? (
        <section class="card ai">
          <div class="row">
            <Icon name="sparkles" class="accent" />
            <b class="grow">{t('AI')}</b>
            <button class="btn sm" disabled={!!action.busy} onClick={() => void smartGroup()}>
              {action.busy === 'ai-group' ? <span class="spinner" /> : <Icon name="layers" />} {t('Smart group')}
            </button>
            <button class="btn sm" disabled={!!action.busy} onClick={() => void recap()}>
              {action.busy === 'ai-summary' ? <span class="spinner" /> : <Icon name="wand" />} {t('Where was I?')}
            </button>
          </div>
          {summary && (
            <div class="ai-out">
              <p>{summary.summary}</p>
              {summary.threads.length > 0 && (
                <ul>
                  {summary.threads.map((th) => (
                    <li key={th}>{th}</li>
                  ))}
                </ul>
              )}
              <p class="next">
                <b>{t('Next')}:</b> {summary.nextStep}
              </p>
            </div>
          )}
          {suggestion && suggestion.length > 0 && (
            <GroupSuggestion
              groups={suggestion}
              win={win}
              onCancel={() => setSuggestion(null)}
              onApply={(gs) => {
                setSuggestion(null);
                void action.run('ai-apply', () => call('applyGrouping', { groups: gs }), (r) => summaryText(r.summary));
              }}
            />
          )}
        </section>
      ) : (
        <button class="btn ghost ai-off" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#ai') })}>
          <Icon name="sparkles" /> {t('Turn on AI grouping and recaps')}
        </button>
      )}

      {pinned.length > 0 && (
        <section>
          <div class="label">{t('Pinned')}</div>
          <div class="pins">
            {pinned.map((tb) => (
              <button key={tb.id} class="pin" aria-current={tb.active} title={tb.title} onClick={() => void chrome.tabs.update(tb.id, { active: true })}>
                <Favicon url={tb.url} size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {groups.map(({ g, tabs }) => (
        <section key={g.id} class={`group g-${g.color}`}>
          <div class="group-head" onClick={() => void chrome.tabGroups.update(g.id, { collapsed: !g.collapsed })}>
            <Icon name="chevron" class={g.collapsed ? 'chev' : 'chev open'} />
            <span class="group-title grow ellipsis">{g.title || t('Untitled group')}</span>
            <span class="faint small">{tabs.length}</span>
          </div>
          {!g.collapsed && tabs.map((tb) => <TabRow key={tb.id} tab={tb} data={data} action={action} />)}
        </section>
      ))}

      <section>
        <div class="row label">
          <span class="grow">{t('Ungrouped')}</span>
          {ungrouped.length > 0 && (
            <button class="btn ghost sm" onClick={() => void action.run('archive', () => call('archiveUngrouped'), (r) => summaryText(r.summary))}>
              <Icon name="archive" /> {t('Archive all')}
            </button>
          )}
        </div>
        {ungrouped.length === 0 && <div class="faint small pad">{t('Nothing loose. Nice.')}</div>}
        {ungrouped.map((tb) => (
          <TabRow key={tb.id} tab={tb} data={data} action={action} />
        ))}
      </section>
    </div>
  );
}

function TabRow({ tab, data, action }: { tab: LiveTab; data: AppData; action: Action }) {
  const others = data.workspaces.filter((w) => w.id !== data.active?.id);
  return (
    <div class="tabrow" aria-current={tab.active} onClick={() => void chrome.tabs.update(tab.id, { active: true })}>
      <Favicon url={tab.url} />
      <span class="grow ellipsis">{tab.title || displayHost(tab.url)}</span>
      <span class="tab-actions" onClick={(e) => e.stopPropagation()}>
        {others.length > 0 && (
          <select
            class="send"
            title={t('Send to workspace')}
            value=""
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              const target = others.find((w) => w.id === id);
              if (target) void action.run('send', () => call('moveTabToWorkspace', { tabId: tab.id, workspaceId: id }), () => t('Sent to {0}', target.name));
            }}
          >
            <option value="">↗</option>
            {others.map((w) => (
              <option key={w.id} value={w.id}>
                {w.icon} {w.name}
              </option>
            ))}
          </select>
        )}
        <button class="btn ghost sm icon" title={t('Archive')} onClick={() => void call('archiveTabs', { tabIds: [tab.id] })}>
          <Icon name="archive" />
        </button>
        <button class="btn ghost sm icon" title={t('Close tab')} onClick={() => void chrome.tabs.remove(tab.id)}>
          <Icon name="x" />
        </button>
      </span>
    </div>
  );
}

function describeOp(op: Op, win: LiveWindow): string | null {
  const tab = (id: number | string) => (typeof id === 'number' ? win.tabs.find((x) => x.id === id) : undefined);
  const name = (id: number | string) => {
    const x = tab(id);
    return x ? x.title || displayHost(x.url) : t('new tab');
  };
  switch (op.op) {
    case 'create':
      return op.pinned ? t('Open and pin {0}', displayHost(op.url)) : isNewTabUrl(op.url) ? t('Open a fresh tab') : t('Open {0}', displayHost(op.url));
    case 'pin':
      return t('Pin {0}', name(op.tab));
    case 'move':
      return t('Reorder {0}', name(op.tab));
    case 'unpin':
      return t('Unpin {0}', name(op.tab));
    case 'group':
      return t('Group {0} tabs into “{1}”', op.tabs.length, op.title);
    case 'archive':
      return t('Archive {0} tabs', op.tabs.length);
    case 'close':
      return t('Close {0} tabs', op.tabs.length);
    case 'updateGroup':
      return op.collapsed ? t('Collapse a group') : op.collapsed === false ? t('Expand a group') : t('Restyle a group');
    case 'ungroup':
      return t('Ungroup {0} tabs', op.tabs.length);
    default:
      return null;
  }
}

function PlanPreview({ plan, win, onClose, onRun }: { plan: Plan; win: LiveWindow; onClose: () => void; onRun: () => void }) {
  const lines = plan.ops.map((o) => describeOp(o, win)).filter((x): x is string => !!x);
  return (
    <div class="preview">
      <div class="row">
        <b class="grow">{t('Dry run')}</b>
        <button class="btn ghost sm icon" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {lines.length === 0 ? (
        <div class="muted small">{t('Already in place — nothing would change.')}</div>
      ) : (
        <>
          <ol class="ops">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
          <div class="row">
            <span class="small muted grow">{summaryText(plan.summary)}</span>
            <button class="btn primary sm" onClick={onRun}>
              {t('Run it')}
            </button>
          </div>
        </>
      )}
      <div class="small faint">{t('Other windows are handled per the workspace policy.')}</div>
    </div>
  );
}

function GroupSuggestion({ groups, win, onApply, onCancel }: { groups: SuggestedGroup[]; win: LiveWindow; onApply: (g: SuggestedGroup[]) => void; onCancel: () => void }) {
  const [enabled, setEnabled] = useState(() => groups.map(() => true));
  return (
    <div class="suggest">
      {groups.map((g, i) => (
        <label key={i} class={`sg g-${g.color}`}>
          <input type="checkbox" checked={enabled[i]} onChange={() => setEnabled((e) => e.map((v, j) => (j === i ? !v : v)))} />
          <span class="dot bg-g" />
          <span class="grow">
            <b>{g.title}</b>
            <span class="faint small"> · {g.tabIds.length}</span>
            <div class="sg-tabs">
              {g.tabIds.map((id) => {
                const tb = win.tabs.find((x) => x.id === id);
                return tb ? <Favicon key={id} url={tb.url} size={14} /> : null;
              })}
            </div>
          </span>
        </label>
      ))}
      <div class="row">
        <span class="grow" />
        <button class="btn sm" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button class="btn primary sm" onClick={() => onApply(groups.filter((_, i) => enabled[i]))}>
          {t('Apply grouping')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Archive

function ArchiveView({ action }: { action: Action }) {
  const [items, setItems] = useState<ArchivedTab[] | null>(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const reload = () => void chromeStore.listArchived().then(setItems);
  useEffect(reload, []);

  const results = useMemo(() => {
    if (!items) return [];
    if (!q.trim()) return items.slice(0, 300).map((item) => ({ item, hits: {} as Record<string, number[]> }));
    return rank(items, q, [
      { name: 'title', get: (a) => a.title, weight: 1.2 },
      { name: 'url', get: (a) => a.url, weight: 0.7 },
      { name: 'group', get: (a) => a.groupTitle ?? '', weight: 0.8 },
    ]).slice(0, 300);
  }, [items, q]);

  const restore = (ids: string[]) =>
    void action.run('restore', () => call('restoreArchived', { ids }), (n) => {
      reload();
      setSelected(new Set());
      return t('{0} restored', n);
    });
  const remove = (ids: string[]) =>
    void action.run('delete', () => chromeStore.takeArchived(ids), () => {
      reload();
      setSelected(new Set());
      return t('Deleted');
    });

  if (!items) return <div class="empty">…</div>;
  let lastDay = '';
  return (
    <div class="col">
      <div class="searchbox">
        <Icon name="search" />
        <input class="grow" placeholder={t('Search {0} archived tabs…', items.length)} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      {selected.size > 0 && (
        <div class="row">
          <span class="small muted grow">{t('{0} selected', selected.size)}</span>
          <button class="btn sm" onClick={() => remove([...selected])}>
            <Icon name="trash" /> {t('Delete')}
          </button>
          <button class="btn primary sm" onClick={() => restore([...selected])}>
            <Icon name="restore" /> {t('Restore')}
          </button>
        </div>
      )}
      {items.length === 0 && <div class="empty">{t('Archived tabs land here: from clean-ups, idle tabs and closed windows. Nothing is ever lost.')}</div>}
      <div>
        {results.map(({ item: a, hits }) => {
          const day = new Date(a.archivedAt).toDateString();
          const header = !q.trim() && day !== lastDay;
          lastDay = day;
          return (
            <>
              {header && <div class="label">{new Date(a.archivedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
              <div key={a.id} class="tabrow" onClick={() => restore([a.id])} title={a.url}>
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected((s) => {
                      const n = new Set(s);
                      if (n.has(a.id)) n.delete(a.id);
                      else n.add(a.id);
                      return n;
                    });
                  }}
                />
                <Favicon url={a.url} />
                <span class="grow ellipsis">
                  <Highlight text={a.title} indices={hits.title} />
                  <span class="faint small"> · {displayHost(a.url)}</span>
                </span>
                {a.groupTitle && <span class="badge">{a.groupTitle}</span>}
                <span class="faint small nowrap">{timeAgo(a.archivedAt)}</span>
              </div>
            </>
          );
        })}
      </div>
      {items.length > 0 && (
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          {confirmClear ? (
            <>
              <span class="small danger">{t('Delete all {0} archived tabs?', items.length)}</span>
              <button class="btn sm" onClick={() => setConfirmClear(false)}>{t('Cancel')}</button>
              <button class="btn sm danger" onClick={() => void chromeStore.clearArchive().then(() => { setConfirmClear(false); reload(); })}>
                {t('Delete all')}
              </button>
            </>
          ) : (
            <button class="btn ghost sm" onClick={() => setConfirmClear(true)}>
              {t('Clear archive')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Timeline

const REASON_LABEL: Record<Snapshot['reason'], string> = {
  apply: 'Initialize', switch: 'Switch', undo: 'Before undo', restore: 'Before restore', manual: 'Manual', auto: 'Auto', ai: 'AI grouping', archive: 'Archive', merge: 'Merge',
};

function TimelineView({ action }: { action: Action }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const reload = () => void chromeStore.listSnapshots().then(setSnaps);
  useEffect(() => {
    reload();
    void chromeStore.getWorkspaces().then(setWorkspaces);
  }, []);
  if (!snaps) return <div class="empty">…</div>;
  return (
    <div class="col">
      <div class="row">
        <span class="small muted grow">{t('Every change is snapshotted first. Restore any moment.')}</span>
        <button class="btn sm" onClick={() => void action.run('snap', () => call('snapshot', {}), () => (reload(), t('Snapshot saved')))}>
          <Icon name="camera" /> {t('Snapshot')}
        </button>
      </div>
      {snaps.length === 0 && <div class="empty">{t('No snapshots yet.')}</div>}
      <ol class="timeline">
        {snaps.map((s) => {
          const ws = workspaces.find((w) => w.id === s.workspaceId);
          return (
            <li key={s.id} class={s.undone ? 'undone' : ''}>
              <div class="row" onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span class={`badge r-${s.reason}`}>{t(REASON_LABEL[s.reason])}</span>
                <span class="grow ellipsis">{s.label ?? (ws ? `${ws.icon} ${ws.name}` : '')}</span>
                <span class="faint small nowrap" title={new Date(s.createdAt).toLocaleString()}>
                  {timeAgo(s.createdAt)}
                </span>
              </div>
              <div class="small faint">
                {t('{0} tabs', s.tabCount)}
                {s.windows.length > 1 && ` · ${t('{0} windows', s.windows.length)}`}
                {s.undone && ` · ${t('undone')}`}
              </div>
              {open === s.id && (
                <div class="snap-detail">
                  {s.windows.map((w, wi) => (
                    <div key={wi} class="snap-win">
                      <div class="faint small">{t('Window {0}', wi + 1)}{w.focused ? ` · ${t('focused')}` : ''}</div>
                      <div class="snap-icons">
                        {w.tabs.slice(0, 60).map((tb, ti) => (
                          <span key={ti} title={tb.title} class={tb.pinned ? 'pinned' : ''}>
                            <Favicon url={tb.url} size={14} />
                          </span>
                        ))}
                        {w.tabs.length > 60 && <span class="faint small">+{w.tabs.length - 60}</span>}
                      </div>
                    </div>
                  ))}
                  <div class="row">
                    <button class="btn ghost sm danger" onClick={() => void call('deleteSnapshot', { id: s.id }).then(reload)}>
                      <Icon name="trash" /> {t('Delete')}
                    </button>
                    <span class="grow" />
                    <button
                      class="btn primary sm"
                      disabled={!!action.busy}
                      onClick={() => void action.run('restore', () => call('restoreSnapshot', { id: s.id }), (r) => (reload(), summaryText(r.summary)))}
                    >
                      <Icon name="restore" /> {t('Restore this moment')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
