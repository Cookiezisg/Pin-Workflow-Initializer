/** Side panel: the window, workspace switcher, archive and timeline. Looks and behaves like Chrome's own side panels. */
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
  displayHost, Favicon, Highlight, Icon, Menu, summaryText, timeAgo, useAction, useAppData, useCurrentWindow, useToast, type AppData,
  type ShowToast,
} from '../../ui/kit';
import './panel.css';

type View = 'now' | 'archive' | 'timeline';
type Action = ReturnType<typeof useAction>;

function App() {
  const data = useAppData();
  const win = useCurrentWindow();
  const [view, setView] = useState<View>('now');
  const [toastEl, toast] = useToast();
  const action = useAction(toast);

  if (!data) return null;
  return (
    <div class="panel">
      <Header data={data} action={action} />
      <nav class="tabs" role="tablist">
        {(['now', 'archive', 'timeline'] as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} class="tab" onClick={() => setView(v)}>
            {{ now: t('Window'), archive: t('Archive'), timeline: t('Timeline') }[v]}
          </button>
        ))}
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

// ---------------------------------------------------------------- header: workspace picker + Initialize

function Header({ data, action }: { data: AppData; action: Action }) {
  const ws = data.active;
  const switchTo = (w: Workspace) =>
    void action.run(`ws:${w.id}`, () => call('switchTo', { workspaceId: w.id }), (r) => t('Switched to {0}', w.name) + ' · ' + summaryText(r.summary), true);
  const initialize = () => void action.run('apply', () => call('apply', {}), (r) => summaryText(r.summary), true);
  return (
    <header class="header">
      <Menu
        align="left"
        label={t('Workspaces')}
        trigger={(open, isOpen) => (
          <button class="ws-picker" onClick={open} aria-expanded={isOpen} disabled={!!action.busy}>
            {ws && <span class={`dot bg-g g-${ws.color}`} />}
            <span class="ellipsis">{ws?.name ?? t('Workspaces')}</span>
            <Icon name="chevronDown" size={18} />
          </button>
        )}
        items={[
          ...data.workspaces.map((w) => ({
            label: w.name,
            lead: <span class={`dot bg-g g-${w.color}`} />,
            onSelect: () => (w.id === ws?.id ? initialize() : switchTo(w)),
          })),
          'divider' as const,
          {
            label: t('Save window as new workspace'),
            icon: 'plus',
            onSelect: () =>
              void action.run('new-ws', () => call('newWorkspaceFromWindow', { name: t('Workspace {0}', data.workspaces.length + 1) }), (w) => t('Created {0}', w.name)),
          },
          { label: t('Manage workspaces'), icon: 'settings', onSelect: () => void chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#workspaces') }) },
        ]}
      />
      <span class="grow" />
      <button class="btn primary sm" disabled={!!action.busy} onClick={initialize} title={t('Pins, groups and clean-up')}>
        {action.busy === 'apply' || action.busy?.startsWith('ws:') ? <span class="spinner" /> : null}
        {t('Initialize')}
      </button>
    </header>
  );
}

// ---------------------------------------------------------------- Window view

function NowView({ data, win, action, toast }: { data: AppData; win: LiveWindow | null; action: Action; toast: ShowToast }) {
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
      if (groups.length === 0) toast(t('AI found nothing worth grouping'));
      else setSuggestion(groups);
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

  if (!win || !ws) return null;
  const pinned = win.tabs.filter((tb) => tb.pinned);
  const ungrouped = win.tabs.filter((tb) => !tb.pinned && tb.groupId === NO_GROUP);
  const groups = win.groups
    .map((g) => ({ g, tabs: win.tabs.filter((tb) => tb.groupId === g.id) }))
    .sort((a, b) => (a.tabs[0]?.index ?? 0) - (b.tabs[0]?.index ?? 0));
  const busy = action.busy;

  return (
    <div class="now">
      <div class="toolbar">
        <span class="faint small grow">
          {t(win.tabs.length === 1 ? '1 tab' : '{0} tabs', win.tabs.length)}
          {win.groups.length > 0 && ` · ${t(win.groups.length === 1 ? '1 group' : '{0} groups', win.groups.length)}`}
        </span>
        <button class="btn icon sm" title={t('Undo')} disabled={!!busy} onClick={() => void action.run('undo', () => call('undo'), (r) => (r.message === 'nothing' ? t('Nothing to undo') : t('Undone')))}>
          <Icon name="undo" />
        </button>
        <Menu
          label={t('More actions')}
          trigger={(open) => (
            <button class="btn icon sm" title={t('More actions')} onClick={open}>
              <Icon name="more" />
            </button>
          )}
          items={[
            { label: t('Preview'), icon: 'eye', onSelect: () => void action.run('preview', () => call('preview', { kind: 'apply' })).then((p) => p && setPreview(p)) },
            ...(aiOn ? [{ label: t('Where was I?'), icon: 'wand', onSelect: () => void recap() }] : []),
            'divider' as const,
            { label: t('Close duplicate tabs'), icon: 'dup', onSelect: () => void action.run('dedupe', () => call('dedupe'), (r) => summaryText(r.summary), true) },
            { label: t('Collapse all groups'), icon: 'collapse', onSelect: () => void action.run('collapse', () => call('collapseAll'), () => t('Done')) },
            { label: t('Merge all windows'), icon: 'merge', onSelect: () => void action.run('merge', () => call('mergeWindows'), () => t('Done'), true) },
            { label: t('Take snapshot'), icon: 'camera', onSelect: () => void action.run('snap', () => call('snapshot', {}), () => t('Snapshot saved')) },
            'divider' as const,
            { label: t('Settings'), icon: 'settings', onSelect: () => void chrome.runtime.openOptionsPage() },
          ]}
        />
      </div>

      {busy === 'ai-summary' && <div class="note faint">{t('Thinking…')}</div>}
      {summary && (
        <section class="note">
          <div class="row note-head">
            <span class="grow muted small">{t('Where was I?')}</span>
            <button class="btn icon sm" title={t('Close')} onClick={() => setSummary(null)}>
              <Icon name="x" />
            </button>
          </div>
          <p>{summary.summary}</p>
          {summary.threads.length > 0 && (
            <ul>
              {summary.threads.map((th) => (
                <li key={th}>{th}</li>
              ))}
            </ul>
          )}
          <p class="muted">{t('Next')}: {summary.nextStep}</p>
        </section>
      )}

      {preview && (
        <PlanPreview
          plan={preview}
          win={win}
          onClose={() => setPreview(null)}
          onRun={() => {
            setPreview(null);
            void action.run('apply', () => call('apply', {}), (r) => summaryText(r.summary), true);
          }}
        />
      )}

      {pinned.length > 0 && (
        <section>
          <div class="label">{t('Pinned')}</div>
          <div class="pins">
            {pinned.map((tb) => (
              <button key={tb.id} class="pin" aria-current={tb.active} title={tb.title} onClick={() => void chrome.tabs.update(tb.id, { active: true })}>
                <Favicon url={tb.url} />
              </button>
            ))}
          </div>
        </section>
      )}

      {groups.map(({ g, tabs }) => (
        <section key={g.id}>
          <div class={`list-row group-head g-${g.color}`} onClick={() => void chrome.tabGroups.update(g.id, { collapsed: !g.collapsed })}>
            <span class={g.title ? 'chip' : 'chip empty-title'}>{g.title}</span>
            <span class="faint small grow">{tabs.length}</span>
            <Icon name={g.collapsed ? 'chevron' : 'chevronDown'} class="faint" />
          </div>
          {!g.collapsed && tabs.map((tb) => <TabRow key={tb.id} tab={tb} data={data} action={action} />)}
        </section>
      ))}

      <section>
        <div class="label row">
          <span class="grow">{groups.length > 0 || pinned.length > 0 ? t('Other tabs') : t('Tabs')}</span>
          {aiOn && ungrouped.length >= 2 && !suggestion && (
            <button class="btn ghost sm" disabled={!!busy} onClick={() => void smartGroup()}>
              {busy === 'ai-group' && <span class="spinner" />}
              {t('Smart group')}
            </button>
          )}
          {ungrouped.length > 0 && (
            <button class="btn ghost sm" disabled={!!busy} onClick={() => void action.run('archive', () => call('archiveUngrouped'), (r) => summaryText(r.summary), true)}>
              {t('Archive all')}
            </button>
          )}
        </div>
        {suggestion && (
          <GroupSuggestion
            groups={suggestion}
            win={win}
            onCancel={() => setSuggestion(null)}
            onApply={(gs) => {
              setSuggestion(null);
              void action.run('ai-apply', () => call('applyGrouping', { groups: gs }), (r) => summaryText(r.summary), true);
            }}
          />
        )}
        {ungrouped.length === 0 && <div class="empty small">{t('No other tabs')}</div>}
        {!suggestion && ungrouped.map((tb) => <TabRow key={tb.id} tab={tb} data={data} action={action} />)}
      </section>
    </div>
  );
}

function TabRow({ tab, data, action }: { tab: LiveTab; data: AppData; action: Action }) {
  const others = data.workspaces.filter((w) => w.id !== data.active?.id);
  return (
    <div class="list-row tabrow" aria-current={tab.active} onClick={() => void chrome.tabs.update(tab.id, { active: true })} title={tab.url}>
      <Favicon url={tab.url} />
      <span class="grow ellipsis">{tab.title || displayHost(tab.url)}</span>
      <span class="row-actions hover-only" onClick={(e) => e.stopPropagation()}>
        {others.length > 0 && (
          <Menu
            label={t('Move to workspace')}
            trigger={(open) => (
              <button class="btn icon sm" title={t('Move to workspace')} onClick={open}>
                <Icon name="send" />
              </button>
            )}
            items={[
              { heading: t('Move to workspace') },
              ...others.map((w) => ({
                label: w.name,
                lead: <span class={`dot bg-g g-${w.color}`} />,
                onSelect: () => void action.run('send', () => call('moveTabToWorkspace', { tabId: tab.id, workspaceId: w.id }), () => t('Moved to {0}', w.name)),
              })),
            ]}
          />
        )}
        <button class="btn icon sm" title={t('Archive')} onClick={() => void action.run('archive-tab', () => call('archiveTabs', { tabIds: [tab.id] }), () => t('Archived'), true)}>
          <Icon name="archive" />
        </button>
        <button class="btn icon sm" title={t('Close tab')} onClick={() => void chrome.tabs.remove(tab.id)}>
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
    <section class="note">
      <div class="row note-head">
        <span class="grow muted small">{t('Preview')}</span>
        <button class="btn icon sm" title={t('Close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {lines.length === 0 ? (
        <p class="muted">{t('Already in place — nothing would change.')}</p>
      ) : (
        <>
          <ul class="ops">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <div class="row note-actions">
            <button class="btn ghost sm" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button class="btn primary sm" onClick={onRun}>
              {t('Initialize')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function GroupSuggestion({ groups, win, onApply, onCancel }: { groups: SuggestedGroup[]; win: LiveWindow; onApply: (g: SuggestedGroup[]) => void; onCancel: () => void }) {
  const [enabled, setEnabled] = useState(() => groups.map(() => true));
  return (
    <div class="suggest">
      {groups.map((g, i) => (
        <label key={i} class={`list-row sg g-${g.color}`}>
          <input type="checkbox" checked={enabled[i]} onChange={() => setEnabled((e) => e.map((v, j) => (j === i ? !v : v)))} />
          <span class="grow sg-body">
            <span class="chip">{g.title}</span>
            <span class="sg-tabs">
              {g.tabIds.map((id) => {
                const tb = win.tabs.find((x) => x.id === id);
                return tb ? <span key={id} title={tb.title}><Favicon url={tb.url} /></span> : null;
              })}
            </span>
          </span>
        </label>
      ))}
      <div class="row note-actions">
        <button class="btn ghost sm" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button class="btn primary sm" disabled={!enabled.some(Boolean)} onClick={() => onApply(groups.filter((_, i) => enabled[i]))}>
          {t('Create groups')}
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
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!items) return null;
  let lastDay = '';
  return (
    <div class={selected.size ? 'archive selecting' : 'archive'}>
      <div class="searchbox">
        <Icon name="search" size={18} />
        <input class="grow" placeholder={t('Search archive')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        {q && (
          <button class="btn icon sm" title={t('Clear')} onClick={() => setQ('')}>
            <Icon name="x" />
          </button>
        )}
      </div>
      {selected.size > 0 && (
        <div class="toolbar">
          <span class="small muted grow">{t('{0} selected', selected.size)}</span>
          <button class="btn ghost sm" onClick={() => setSelected(new Set())}>{t('Cancel')}</button>
          <button class="btn ghost sm danger" onClick={() => remove([...selected])}>{t('Delete')}</button>
          <button class="btn primary sm" onClick={() => restore([...selected])}>{t('Restore')}</button>
        </div>
      )}
      {items.length === 0 && <div class="empty">{t('Archived tabs appear here')}</div>}
      {items.length > 0 && results.length === 0 && <div class="empty">{t('No matches')}</div>}
      {results.map(({ item: a, hits }) => {
        const day = new Date(a.archivedAt).toDateString();
        const header = !q.trim() && day !== lastDay;
        lastDay = day;
        return (
          <>
            {header && <div class="label">{new Date(a.archivedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>}
            <div key={a.id} class="list-row two-line" onClick={() => (selected.size ? toggle(a.id) : restore([a.id]))} title={t('Restore')}>
              <span class="lead">
                <Favicon url={a.url} />
                <input type="checkbox" checked={selected.has(a.id)} onClick={(e) => (e.stopPropagation(), toggle(a.id))} />
              </span>
              <span class="grow">
                <div class="ellipsis"><Highlight text={a.title} indices={hits.title} /></div>
                <div class="ellipsis small faint">
                  {displayHost(a.url)} · {timeAgo(a.archivedAt)}
                  {a.groupTitle && ` · ${a.groupTitle}`}
                </div>
              </span>
              <span class="row-actions hover-only" onClick={(e) => e.stopPropagation()}>
                <button class="btn icon sm" title={t('Delete')} onClick={() => remove([a.id])}>
                  <Icon name="trash" />
                </button>
              </span>
            </div>
          </>
        );
      })}
      {items.length > 0 && (
        <div class="row footer-actions">
          {confirmClear ? (
            <>
              <span class="small grow">{t('Delete all {0} archived tabs? This can’t be undone.', items.length)}</span>
              <button class="btn ghost sm" onClick={() => setConfirmClear(false)}>{t('Cancel')}</button>
              <button class="btn ghost sm danger" onClick={() => void chromeStore.clearArchive().then(() => { setConfirmClear(false); reload(); })}>
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
  if (!snaps) return null;
  return (
    <div class="timeline">
      <div class="toolbar">
        <span class="grow" />
        <button class="btn ghost sm" onClick={() => void action.run('snap', () => call('snapshot', {}), () => (reload(), t('Snapshot saved')))}>
          {t('Take snapshot')}
        </button>
      </div>
      {snaps.length === 0 && <div class="empty">{t('No snapshots yet')}</div>}
      {snaps.map((s) => {
        const ws = workspaces.find((w) => w.id === s.workspaceId);
        const isOpen = open === s.id;
        return (
          <div key={s.id} class={s.undone ? 'snap undone' : 'snap'}>
            <div class="list-row two-line" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>
              <span class="grow">
                <div class="ellipsis">{s.label ?? ws?.name ?? t(REASON_LABEL[s.reason])}</div>
                <div class="ellipsis small faint" title={new Date(s.createdAt).toLocaleString()}>
                  {t(REASON_LABEL[s.reason])} · {t(s.tabCount === 1 ? '1 tab' : '{0} tabs', s.tabCount)}
                  {s.windows.length > 1 && ` · ${t('{0} windows', s.windows.length)}`} · {timeAgo(s.createdAt)}
                  {s.undone && ` · ${t('undone')}`}
                </div>
              </span>
              <Icon name={isOpen ? 'chevronDown' : 'chevron'} class="faint" />
            </div>
            {isOpen && (
              <div class="snap-detail">
                {s.windows.map((w, wi) => (
                  <div key={wi} class="snap-icons">
                    {w.tabs.slice(0, 60).map((tb, ti) => (
                      <span key={ti} title={tb.title}>
                        <Favicon url={tb.url} />
                      </span>
                    ))}
                    {w.tabs.length > 60 && <span class="faint small">+{w.tabs.length - 60}</span>}
                  </div>
                ))}
                <div class="row note-actions">
                  <button class="btn ghost sm danger" onClick={() => void call('deleteSnapshot', { id: s.id }).then(reload)}>
                    {t('Delete')}
                  </button>
                  <button
                    class="btn primary sm"
                    disabled={!!action.busy}
                    onClick={() => void action.run('restore', () => call('restoreSnapshot', { id: s.id }), (r) => (reload(), summaryText(r.summary)), true)}
                  >
                    {t('Restore')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
