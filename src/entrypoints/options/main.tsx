/** Settings: workspaces, rules, automation, AI, general and data. Every change autosaves. */
import { render, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { defaultSettings, defaultWorkspaces, newWorkspace, parseImport, pin, type ExportBundle } from '../../core/defaults';
import { uid } from '../../core/ids';
import { compilePattern, isArchivable, unwrapUrl } from '../../core/match';
import { evaluateRules, isValidRule } from '../../core/rules';
import { nextRun } from '../../core/schedule';
import type { AiProvider, GroupSpec, LeftoverPolicy, OtherWindowsPolicy, Rule, RuleAction, Schedule, Secrets, Settings, Workspace } from '../../core/types';
import { chromeStore, saveSecrets } from '../../engine/chrome-store';
import { builtinAvailability, requiredOrigins, suggestGroups } from '../../lib/ai';
import { t } from '../../lib/i18n';
import { call } from '../../lib/rpc';
import { ColorPicker, Favicon, Icon, Kbd, Menu, summaryText, Toggle, useAction, useAppData, useToast, type AppData, type ShowToast } from '../../ui/kit';
import './options.css';

type Section = 'workspaces' | 'rules' | 'automation' | 'ai' | 'general' | 'data';
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'workspaces', label: 'Workspaces', icon: 'workspaces' },
  { id: 'rules', label: 'Rules', icon: 'rule' },
  { id: 'automation', label: 'Automation', icon: 'clock' },
  { id: 'ai', label: 'AI', icon: 'ai' },
  { id: 'general', label: 'General', icon: 'general' },
  { id: 'data', label: 'Data', icon: 'data' },
];

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [hash, (h) => (location.hash = h)];
}

/** Debounced persistence with a "Saved" indicator. */
function useSaver() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timers = useRef(new Map<string, number>());
  const save = (key: string, fn: () => Promise<void>, delay = 350) => {
    window.clearTimeout(timers.current.get(key));
    setState('saving');
    timers.current.set(
      key,
      window.setTimeout(async () => {
        try {
          await fn();
          setState('saved');
        } catch {
          setState('error');
        }
      }, delay),
    );
  };
  return { state, save };
}
type Saver = ReturnType<typeof useSaver>;

function App() {
  const data = useAppData();
  const [hash, setHash] = useHash();
  const saver = useSaver();
  const [toastEl, toast] = useToast();
  const section = (SECTIONS.find((s) => hash.startsWith(s.id))?.id ?? 'workspaces') as Section;
  const banner = hash === 'welcome' ? 'welcome' : hash === 'upgraded' ? 'upgraded' : null;

  if (!data) return null;
  return (
    <div class="layout">
      <header class="topbar">
        <img src="/icon-32.png" width={24} height={24} alt="" />
        <span class="topbar-title">Pin Workflow</span>
        <span class="grow" />
        {saver.state === 'error' && <span class="small danger">{t('Could not save')}</span>}
      </header>
      <aside class="nav">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} class="nav-item" aria-current={section === s.id}>
            <Icon name={s.icon} /> {t(s.label)}
          </a>
        ))}
      </aside>
      <main class="content">
        {banner && <Banner kind={banner} onClose={() => setHash('workspaces')} />}
        {section === 'workspaces' && <WorkspacesSection data={data} saver={saver} toast={toast} />}
        {section === 'rules' && <RulesSection data={data} saver={saver} />}
        {section === 'automation' && <AutomationSection data={data} saver={saver} />}
        {section === 'ai' && <AiSection data={data} saver={saver} toast={toast} />}
        {section === 'general' && <GeneralSection data={data} saver={saver} />}
        {section === 'data' && <DataSection data={data} toast={toast} />}
      </main>
      {toastEl}
    </div>
  );
}

function Banner({ kind, onClose }: { kind: 'welcome' | 'upgraded'; onClose: () => void }) {
  return (
    <div class="card banner">
      <div class="banner-title">{kind === 'welcome' ? t('Welcome to Pin Workflow') : t('Pin Workflow 2.0 is here')}</div>
      <p class="muted">
        {kind === 'welcome'
          ? t('Press {0} to initialize your workspace, {1} for the command palette. Everything is undoable.', '⌥⇧C', '⌥⇧K')
          : t('Your pinned sites moved into the “Main” workspace. Initializing no longer destroys tabs: they are archived and every run can be undone.')}
      </p>
      <div class="row" style={{ justifyContent: 'flex-end' }}>
        <button class="btn" onClick={onClose}>
          {t('Got it')}
        </button>
      </div>
    </div>
  );
}

/** A titled card of setting rows, like chrome://settings. */
function Card({ title, children }: { title?: string; children: ComponentChildren }) {
  return (
    <>
      {title && <h2 class="card-title">{title}</h2>}
      <div class="card settings-card">{children}</div>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="setting-row">
      <div class="grow">
        <div>{label}</div>
        {hint && <div class="small muted">{hint}</div>}
      </div>
      <div class="control">{children}</div>
    </div>
  );
}

function SwitchField({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Field label={label} hint={hint}>
      <Toggle checked={value} onChange={onChange} label={label} />
    </Field>
  );
}

function urlValid(u: string): boolean {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Workspaces

function WorkspacesSection({ data, saver, toast }: { data: AppData; saver: Saver; toast: ShowToast }) {
  const [list, setList] = useState<Workspace[]>(data.workspaces);
  const [hash, setHash] = useHash();
  const selId = hash.startsWith('workspaces/') ? hash.slice('workspaces/'.length) : null;
  const action = useAction(toast);
  // Follow external changes (e.g. a workspace created from the palette) unless we're mid-edit.
  useEffect(() => {
    if (saver.state !== 'saving') setList(data.workspaces);
  }, [data.workspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (next: Workspace[]) => {
    setList(next);
    saver.save('workspaces', () => chromeStore.saveWorkspaces(next));
  };
  const sel = selId ? list.find((w) => w.id === selId) : undefined;
  const update = (patch: Partial<Workspace>) => sel && persist(list.map((w) => (w.id === sel.id ? { ...w, ...patch } : w)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const [w] = next.splice(i, 1);
    next.splice(i + d, 0, w!);
    persist(next);
  };

  if (sel) {
    return (
      <WorkspaceEditor
        key={sel.id}
        ws={sel}
        isActive={sel.id === data.active?.id}
        canDelete={list.length > 1}
        onBack={() => setHash('workspaces')}
        onChange={update}
        onDelete={() => {
          persist(list.filter((w) => w.id !== sel.id));
          setHash('workspaces');
        }}
        onApply={() =>
          void action.run('apply', () => (sel.id === data.active?.id ? call('apply', { workspaceId: sel.id }) : call('switchTo', { workspaceId: sel.id })), (r) =>
            summaryText(r.summary),
          )
        }
        busy={!!action.busy}
      />
    );
  }

  return (
    <div class="section">
      <h1>{t('Workspaces')}</h1>
      <div class="card settings-card">
        {list.map((w, i) => (
          <a key={w.id} class="setting-row link-row" href={`#workspaces/${w.id}`}>
            <span class={`dot bg-g g-${w.color}`} />
            <div class="grow">
              <div class="ellipsis">{w.name}</div>
              <div class="small muted">
                {w.id === data.active?.id ? `${t('Current')} · ` : ''}
                {t(w.pins.length === 1 ? '1 pin' : '{0} pins', w.pins.length)}
                {w.groups.length > 0 && ` · ${t(w.groups.length === 1 ? '1 group' : '{0} groups', w.groups.length)}`}
              </div>
            </div>
            <span class="hover-only row" onClick={(e) => (e.preventDefault(), e.stopPropagation())}>
              <button class="btn icon sm" disabled={i === 0} onClick={() => move(i, -1)} title={t('Move up')}>
                <Icon name="up" />
              </button>
              <button class="btn icon sm" disabled={i === list.length - 1} onClick={() => move(i, 1)} title={t('Move down')}>
                <Icon name="down" />
              </button>
            </span>
            <Icon name="chevron" class="faint" />
          </a>
        ))}
        <div class="setting-row">
          <button
            class="btn"
            onClick={() => {
              const w = newWorkspace({ name: t('Workspace {0}', list.length + 1) });
              persist([...list, w]);
              setHash(`workspaces/${w.id}`);
            }}
          >
            {t('Add workspace')}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceEditor(props: {
  ws: Workspace; isActive: boolean; canDelete: boolean; busy: boolean;
  onBack: () => void; onChange: (p: Partial<Workspace>) => void; onDelete: () => void; onApply: () => void;
}) {
  const { ws, onChange } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<number | null>(null);
  useEffect(() => void chromeStore.getSession(ws.id).then((s) => setSessionInfo(s ? s.tabs.length : 0)), [ws.id]);

  const setPins = (pins: Workspace['pins']) => onChange({ pins });
  const addCurrentPins = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true, pinned: true });
    const existing = new Set(ws.pins.map((p) => p.url));
    const add = tabs.map((x) => unwrapUrl(x.url ?? '')).filter((u) => isArchivable(u) && !existing.has(u));
    setPins([...ws.pins, ...add.map((u) => pin(u))]);
  };

  return (
    <div class="section">
      <div class="subpage-head">
        <button class="btn icon" onClick={props.onBack} title={t('Back')}>
          <Icon name="back" />
        </button>
        <h1 class="grow ellipsis">{ws.name || t('Workspace')}</h1>
        <button class="btn primary" disabled={props.busy} onClick={props.onApply}>
          {props.isActive ? t('Initialize now') : t('Switch to it')}
        </button>
      </div>

      <div class="card settings-card">
        <Field label={t('Name')}>
          <input class="input wide" value={ws.name} maxLength={60} onInput={(e) => onChange({ name: (e.target as HTMLInputElement).value })} aria-label={t('Name')} />
        </Field>
        <Field label={t('Color')}>
          <ColorPicker value={ws.color} onChange={(color) => onChange({ color })} />
        </Field>
      </div>

      <Card title={t('Pinned tabs')}>
        {ws.pins.map((p, i) => (
          <PinRow
            key={p.id}
            url={p.url}
            match={p.match}
            first={i === 0}
            last={i === ws.pins.length - 1}
            onChange={(patch) => setPins(ws.pins.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))}
            onMove={(d) => {
              const next = [...ws.pins];
              next.splice(i, 1);
              next.splice(i + d, 0, p);
              setPins(next);
            }}
            onRemove={() => setPins(ws.pins.filter((x) => x.id !== p.id))}
          />
        ))}
        <div class="setting-row">
          <button class="btn" onClick={() => setPins([...ws.pins, pin('https://')])}>
            {t('Add pin')}
          </button>
          <button class="btn ghost" onClick={() => void addCurrentPins()}>
            {t('Add this window’s pinned tabs')}
          </button>
        </div>
      </Card>

      <Card title={t('Tab groups')}>
        {ws.groups.map((g) => (
          <GroupEditor
            key={g.id}
            group={g}
            onChange={(patch) => onChange({ groups: ws.groups.map((x) => (x.id === g.id ? { ...x, ...patch } : x)) })}
            onRemove={() => onChange({ groups: ws.groups.filter((x) => x.id !== g.id) })}
          />
        ))}
        <div class="setting-row">
          <button class="btn" onClick={() => onChange({ groups: [...ws.groups, { id: uid(), title: t('New group'), color: 'blue', collapsed: true, tabs: [] }] })}>
            {t('Add group')}
          </button>
        </div>
      </Card>

      <Card title={t('When initializing')}>
        <Field label={t('Loose tabs')} hint={t('Ungrouped tabs that aren’t pins')}>
          <select class="select" value={ws.ungrouped} onChange={(e) => onChange({ ungrouped: (e.target as HTMLSelectElement).value as LeftoverPolicy })}>
            <option value="archive">{t('Archive them (recoverable)')}</option>
            <option value="keep">{t('Keep them')}</option>
            <option value="close">{t('Close them')}</option>
          </select>
        </Field>
        <Field label={t('Other windows')}>
          <select class="select" value={ws.otherWindows} onChange={(e) => onChange({ otherWindows: (e.target as HTMLSelectElement).value as OtherWindowsPolicy })}>
            <option value="keep">{t('Leave them alone')}</option>
            <option value="merge">{t('Merge into this window')}</option>
            <option value="archive">{t('Archive and close them')}</option>
            <option value="close">{t('Close them')}</option>
          </select>
        </Field>
        <SwitchField label={t('Collapse groups')} value={ws.collapseGroups} onChange={(v) => onChange({ collapseGroups: v })} />
        <SwitchField label={t('Finish on a fresh new tab')} value={ws.openNewTab} onChange={(v) => onChange({ openNewTab: v })} />
      </Card>

      <Card title={t('Session')}>
        <Field label={t('Remembered tabs')} hint={t('Restored when you switch back to this workspace')}>
          <div class="row">
            <span class="muted">{sessionInfo === null ? '' : t(sessionInfo === 1 ? '1 tab' : '{0} tabs', sessionInfo)}</span>
            {!!sessionInfo && (
              <button class="btn" onClick={() => void chromeStore.setSession(ws.id, undefined).then(() => setSessionInfo(0))}>
                {t('Forget')}
              </button>
            )}
          </div>
        </Field>
      </Card>

      <div class="card settings-card">
        {confirmDelete ? (
          <div class="setting-row">
            <span class="grow">{t('Delete “{0}” and its remembered tabs?', ws.name)}</span>
            <button class="btn ghost" onClick={() => setConfirmDelete(false)}>
              {t('Cancel')}
            </button>
            <button class="btn danger" onClick={props.onDelete}>
              {t('Delete')}
            </button>
          </div>
        ) : (
          <Field label={t('Delete workspace')}>
            <button class="btn danger" disabled={!props.canDelete} onClick={() => setConfirmDelete(true)}>
              {t('Delete')}
            </button>
          </Field>
        )}
      </div>
    </div>
  );
}

function PinRow(props: {
  url: string; match?: string; first: boolean; last: boolean;
  onChange: (p: { url?: string; match?: string }) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const [advanced, setAdvanced] = useState(!!props.match);
  const valid = urlValid(props.url);
  const matchValid = !props.match || compilePattern(props.match) !== null;
  return (
    <div class="setting-row col-row">
      <div class="row">
        {valid ? <Favicon url={props.url} /> : <span class="favicon" />}
        <input class={`input mono grow ${valid ? '' : 'invalid'}`} value={props.url} placeholder="https://" onInput={(e) => props.onChange({ url: (e.target as HTMLInputElement).value.trim() })} />
        <Menu
          label={t('More actions')}
          trigger={(open) => (
            <button class="btn icon sm" title={t('More actions')} onClick={open}>
              <Icon name="more" />
            </button>
          )}
          items={[
            { label: t('Move up'), icon: 'up', disabled: props.first, onSelect: () => props.onMove(-1) },
            { label: t('Move down'), icon: 'down', disabled: props.last, onSelect: () => props.onMove(1) },
            { label: advanced ? t('Hide custom matching') : t('Custom matching'), icon: 'rule', onSelect: () => setAdvanced(!advanced) },
            { label: t('Remove'), icon: 'trash', onSelect: props.onRemove },
          ]}
        />
      </div>
      {advanced && (
        <div class="row indent">
          <input
            class={`input mono grow ${matchValid ? '' : 'invalid'}`}
            value={props.match ?? ''}
            placeholder={t('e.g. *://mail.google.com/*  or  /regex/')}
            onInput={(e) => props.onChange({ match: (e.target as HTMLInputElement).value || undefined })}
          />
        </div>
      )}
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove }: { group: GroupSpec; onChange: (p: Partial<GroupSpec>) => void; onRemove: () => void }) {
  return (
    <div class={`setting-row col-row g-${group.color}`}>
      <div class="row">
        <input class="input grow" value={group.title} onInput={(e) => onChange({ title: (e.target as HTMLInputElement).value })} aria-label={t('Group title')} />
        <button class="btn icon sm" onClick={onRemove} title={t('Remove')}>
          <Icon name="trash" />
        </button>
      </div>
      <ColorPicker value={group.color} onChange={(color) => onChange({ color })} />
      {group.tabs.map((tb, i) => (
        <div key={i} class="row">
          <input
            class={`input mono grow ${urlValid(tb.url) ? '' : 'invalid'}`}
            value={tb.url}
            onInput={(e) => onChange({ tabs: group.tabs.map((x, j) => (j === i ? { ...x, url: (e.target as HTMLInputElement).value.trim() } : x)) })}
          />
          <button class="btn icon sm" title={t('Remove')} onClick={() => onChange({ tabs: group.tabs.filter((_, j) => j !== i) })}>
            <Icon name="x" />
          </button>
        </div>
      ))}
      <div class="row">
        <button class="btn ghost sm" onClick={() => onChange({ tabs: [...group.tabs, { url: 'https://' }] })}>
          {t('Add tab')}
        </button>
        <span class="grow" />
        <span class="muted">{t('Start collapsed')}</span>
        <Toggle checked={group.collapsed} onChange={(collapsed) => onChange({ collapsed })} label={t('Start collapsed')} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Rules

function useSettingsEditor(data: AppData, saver: Saver): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useState(data.settings);
  const update = (p: Partial<Settings>) => {
    const next = { ...s, ...p };
    setS(next);
    saver.save('settings', () => chromeStore.saveSettings(next));
  };
  return [s, update];
}

function RulesSection({ data, saver }: { data: AppData; saver: Saver }) {
  const [s, update] = useSettingsEditor(data, saver);
  const [testUrl, setTestUrl] = useState('');
  const setRules = (rules: Rule[]) => update({ rules });
  const hit = useMemo(() => (testUrl ? evaluateRules(s.rules, data.active?.id, testUrl) : undefined), [testUrl, s.rules, data.active?.id]);

  return (
    <div class="section">
      <h1>{t('Rules')}</h1>
      <div class="card settings-card">
        <div class="setting-row">
          <div class="searchfield grow">
            <Icon name="search" size={18} />
            <input class="grow" placeholder={t('Test a URL')} value={testUrl} onInput={(e) => setTestUrl((e.target as HTMLInputElement).value)} />
          </div>
          {testUrl && (
            <span class="small muted nowrap">
              {hit ? t('Rule {0} matches', s.rules.indexOf(hit.rule) + 1) : t('No rule matches')}
            </span>
          )}
        </div>
      </div>
      <Card title={t('Rules run in order; the first match wins')}>
        {s.rules.map((r, i) => (
          <RuleRow
            key={r.id}
            n={i + 1}
            rule={r}
            workspaces={data.workspaces}
            highlight={hit?.rule.id === r.id}
            onChange={(p) => setRules(s.rules.map((x) => (x.id === r.id ? { ...x, ...p } : x)))}
            onRemove={() => setRules(s.rules.filter((x) => x.id !== r.id))}
          />
        ))}
        <div class="setting-row">
          <button
            class="btn"
            onClick={() => setRules([...s.rules, { id: uid(), enabled: true, kind: 'domain', pattern: '', action: { type: 'group', title: t('New group'), color: 'blue' }, workspaceIds: [] }])}
          >
            {t('Add rule')}
          </button>
        </div>
      </Card>
    </div>
  );
}

function RuleRow({ n, rule, workspaces, highlight, onChange, onRemove }: {
  n: number; rule: Rule; workspaces: Workspace[]; highlight: boolean; onChange: (p: Partial<Rule>) => void; onRemove: () => void;
}) {
  const valid = !rule.pattern || isValidRule(rule);
  const setAction = (type: RuleAction['type']) =>
    onChange({ action: type === 'group' ? { type, title: rule.action.type === 'group' ? rule.action.title : t('New group'), color: 'blue' } : { type } });
  return (
    <div class={`setting-row col-row rule ${highlight ? 'hit' : ''} ${rule.enabled ? '' : 'disabled'}`}>
      <div class="row">
        <span class="muted rule-n">{n}</span>
        <select class="select" value={rule.kind} onChange={(e) => onChange({ kind: (e.target as HTMLSelectElement).value as Rule['kind'] })}>
          <option value="domain">{t('Domain')}</option>
          <option value="glob">{t('URL pattern')}</option>
          <option value="regex">{t('Regex')}</option>
        </select>
        <input
          class={`input mono grow ${valid ? '' : 'invalid'}`}
          value={rule.pattern}
          placeholder={rule.kind === 'domain' ? 'github.com' : rule.kind === 'glob' ? '*://github.com/*/pull/*' : '^https://(www\\.)?youtube\\.com/'}
          onInput={(e) => onChange({ pattern: (e.target as HTMLInputElement).value })}
        />
        <Toggle checked={rule.enabled} onChange={(enabled) => onChange({ enabled })} label={t('Enabled')} />
        <button class="btn icon sm" onClick={onRemove} title={t('Remove')}>
          <Icon name="trash" />
        </button>
      </div>
      <div class="row wrap indent">
        <select class="select" value={rule.action.type} onChange={(e) => setAction((e.target as HTMLSelectElement).value as RuleAction['type'])}>
          <option value="group">{t('Put in group')}</option>
          <option value="pin">{t('Pin it')}</option>
          <option value="block">{t('Block it')}</option>
        </select>
        {rule.action.type === 'group' && (
          <>
            <input
              class="input"
              value={rule.action.title}
              onInput={(e) => onChange({ action: { ...(rule.action as Extract<RuleAction, { type: 'group' }>), title: (e.target as HTMLInputElement).value } })}
            />
            <ColorPicker value={rule.action.color} onChange={(color) => onChange({ action: { ...(rule.action as Extract<RuleAction, { type: 'group' }>), color } })} />
          </>
        )}
      </div>
      <div class="row wrap indent">
        <button class="choice" aria-pressed={rule.workspaceIds.length === 0} onClick={() => onChange({ workspaceIds: [] })}>
          {t('All workspaces')}
        </button>
        {workspaces.map((w) => {
          const on = rule.workspaceIds.includes(w.id);
          return (
            <button
              key={w.id}
              class="choice"
              aria-pressed={on}
              onClick={() => onChange({ workspaceIds: on ? rule.workspaceIds.filter((x) => x !== w.id) : [...rule.workspaceIds, w.id] })}
            >
              {w.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Automation

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d: number) => new Date(2026, 10, 15 + d).toLocaleDateString(undefined, { weekday: 'short' }); // 15 Nov 2026 = Sunday

function AutomationSection({ data, saver }: { data: AppData; saver: Saver }) {
  const [s, update] = useSettingsEditor(data, saver);
  const setSchedules = (schedules: Schedule[]) => update({ schedules });
  return (
    <div class="section">
      <h1>{t('Automation')}</h1>
      <Card title={t('Schedules')}>
        {s.schedules.map((sc) => {
          const next = nextRun(sc, new Date());
          const patch = (p: Partial<Schedule>) => setSchedules(s.schedules.map((x) => (x.id === sc.id ? { ...x, ...p } : x)));
          return (
            <div key={sc.id} class="setting-row col-row">
              <div class="row">
                <select class="select" value={sc.workspaceId} onChange={(e) => patch({ workspaceId: (e.target as HTMLSelectElement).value })}>
                  {data.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <input type="time" class="input" value={sc.time} onInput={(e) => patch({ time: (e.target as HTMLInputElement).value || '09:00' })} />
                <span class="small muted grow">{next ? t('next: {0}', next.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : t('never')}</span>
                <Toggle checked={sc.enabled} onChange={(enabled) => patch({ enabled })} label={t('Enabled')} />
                <button class="btn icon sm" title={t('Remove')} onClick={() => setSchedules(s.schedules.filter((x) => x.id !== sc.id))}>
                  <Icon name="trash" />
                </button>
              </div>
              <div class="row days">
                {DAYS.map((d) => (
                  <button key={d} class="choice" aria-pressed={sc.days.includes(d)} onClick={() => patch({ days: sc.days.includes(d) ? sc.days.filter((x) => x !== d) : [...sc.days, d] })}>
                    {dayName(d)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div class="setting-row">
          <button
            class="btn"
            onClick={() => setSchedules([...s.schedules, { id: uid(), enabled: true, workspaceId: data.workspaces[0]!.id, days: [1, 2, 3, 4, 5], time: '09:00' }])}
          >
            {t('Add schedule')}
          </button>
        </div>
      </Card>

      <Card title={t('Tidying')}>
        <Field label={t('Archive idle tabs after')} hint={t('Unpinned tabs you haven’t looked at. 0 = off.')}>
          <div class="row">
            <input type="number" min={0} step={30} class="input num" value={s.idleArchiveMinutes} onInput={(e) => update({ idleArchiveMinutes: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
            <span class="muted">{t('minutes')}</span>
          </div>
        </Field>
        <SwitchField label={t('Spare grouped tabs from idle archiving')} value={s.idleArchiveSkipGrouped} onChange={(v) => update({ idleArchiveSkipGrouped: v })} />
        <SwitchField label={t('Close duplicates when initializing')} value={s.dedupeOnApply} onChange={(v) => update({ dedupeOnApply: v })} />
        <SwitchField label={t('Jump to an already-open tab instead of opening a duplicate')} hint={t('Applies to tabs opened in the last few seconds')} value={s.dedupeLive} onChange={(v) => update({ dedupeLive: v })} />
      </Card>

      <Card title={t('Sessions & safety')}>
        <SwitchField label={t('Lazy restore')} hint={t('Restored tabs load only when you open them. Saves memory when switching.')} value={s.lazyRestore} onChange={(v) => update({ lazyRestore: v })} />
        <SwitchField label={t('Re-pin on browser start')} value={s.pinsOnStartup} onChange={(v) => update({ pinsOnStartup: v })} />
        <Field label={t('Background snapshot every')} hint={t('Only when something changed. 0 = off.')}>
          <div class="row">
            <input type="number" min={0} class="input num" value={s.autoSnapshotMinutes} onInput={(e) => update({ autoSnapshotMinutes: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
            <span class="muted">{t('minutes')}</span>
          </div>
        </Field>
        <Field label={t('Keep snapshots')}>
          <input type="number" min={5} max={1000} class="input num" value={s.snapshotLimit} onInput={(e) => update({ snapshotLimit: Math.min(1000, Math.max(5, Number((e.target as HTMLInputElement).value) || 100)) })} />
        </Field>
        <Field label={t('Keep archived tabs')}>
          <input type="number" min={50} max={50000} step={500} class="input num" value={s.archiveLimit} onInput={(e) => update({ archiveLimit: Math.min(50000, Math.max(50, Number((e.target as HTMLInputElement).value) || 5000)) })} />
        </Field>
        <SwitchField label={t('Notifications')} hint={t('For scheduled switches and idle archiving')} value={s.notifications} onChange={(v) => update({ notifications: v })} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- AI

function AiSection({ data, saver, toast }: { data: AppData; saver: Saver; toast: ShowToast }) {
  const [s, update] = useSettingsEditor(data, saver);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [builtin, setBuiltin] = useState<string>('…');
  const [granted, setGranted] = useState(true);
  const action = useAction(toast);
  useEffect(() => {
    void chromeStore.getSecrets().then(setSecrets);
    void builtinAvailability().then(setBuiltin);
  }, []);
  const origins = requiredOrigins(s.ai);
  useEffect(() => {
    if (origins.length === 0) return setGranted(true);
    void chrome.permissions.contains({ origins }).then(setGranted);
  }, [origins.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const setAi = (p: Partial<Settings['ai']>) => update({ ai: { ...s.ai, ...p } });
  const setSecret = (p: Partial<Secrets>) => {
    const next = { ...secrets, ...p };
    setSecrets(next);
    saver.save('secrets', () => saveSecrets(next));
  };
  const grant = () => void chrome.permissions.request({ origins }).then(setGranted);
  const choose = (provider: AiProvider) => {
    const needed = requiredOrigins({ ...s.ai, provider });
    // Ask while we still hold the click's user gesture.
    if (needed.length) void chrome.permissions.request({ origins: needed }).then(setGranted);
    setAi({ provider });
  };
  const test = () =>
    void action.run(
      'test',
      async () => {
        const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((x) => x.id !== undefined && isArchivable(x.url ?? ''));
        const sample = tabs.length >= 4 ? tabs : [
          { id: 1, title: 'Pull request #42 · acme/api', url: 'https://github.com/acme/api/pull/42' },
          { id: 2, title: 'CI run failed · acme/api', url: 'https://github.com/acme/api/actions/runs/1' },
          { id: 3, title: 'Cheap flights to Tokyo', url: 'https://flights.example/tokyo' },
          { id: 4, title: 'Kyoto hotels', url: 'https://hotels.example/kyoto' },
        ];
        return suggestGroups(sample.map((x) => ({ id: x.id!, title: x.title ?? '', url: x.url ?? '' })), s.ai, await chromeStore.getSecrets());
      },
      (groups) => t('It works: {0}', groups.map((g) => g.title).join(', ') || t('no groups suggested')),
    );

  const providers: { id: AiProvider; title: string; desc: string }[] = [
    { id: 'off', title: t('Off'), desc: t('No AI features.') },
    { id: 'deepseek', title: 'DeepSeek', desc: t('Cheap and good with Chinese. Uses your DeepSeek API key; tab titles and URLs are sent to DeepSeek.') },
    { id: 'builtin', title: t('Chrome built-in'), desc: t('On-device Gemini Nano. Free and private; quality is basic. Status: {0}', builtin) },
    { id: 'anthropic', title: 'Claude', desc: t('Best results. Uses your Anthropic API key; tab titles and URLs are sent to Anthropic.') },
    { id: 'openai', title: t('OpenAI-compatible'), desc: t('OpenAI, or a local model via Ollama / LM Studio.') },
  ];

  return (
    <div class="section">
      <h1>{t('AI')}</h1>
      <Card title={t('Smart grouping and “Where was I?”')}>
        {providers.map((p) => (
          <label key={p.id} class="setting-row radio-row">
            <input type="radio" name="provider" checked={s.ai.provider === p.id} onChange={() => choose(p.id)} />
            <div class="grow">
              <div>{p.title}</div>
              <div class="small muted">{p.desc}</div>
            </div>
          </label>
        ))}
      </Card>

      {s.ai.provider !== 'off' && (
        <div class="card settings-card">
          {s.ai.provider === 'deepseek' && (
            <>
              <Field label={t('API key')} hint={t('Stored only on this device, never synced.')}>
                <input type="password" class="input mono wide" value={secrets.deepseekKey ?? ''} placeholder="sk-…" autoComplete="off" onInput={(e) => setSecret({ deepseekKey: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
              <Field label={t('Model')}>
                <input class="input mono wide" value={s.ai.deepseekModel} onInput={(e) => setAi({ deepseekModel: (e.target as HTMLInputElement).value.trim() })} list="deepseek-models" />
                <datalist id="deepseek-models">
                  <option value="deepseek-flash" />
                  <option value="deepseek-v4-pro" />
                </datalist>
              </Field>
            </>
          )}
          {s.ai.provider === 'anthropic' && (
            <>
              <Field label={t('API key')} hint={t('Stored only on this device, never synced.')}>
                <input type="password" class="input mono wide" value={secrets.anthropicKey ?? ''} placeholder="sk-ant-…" autoComplete="off" onInput={(e) => setSecret({ anthropicKey: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
              <Field label={t('Model')}>
                <input class="input mono wide" value={s.ai.anthropicModel} onInput={(e) => setAi({ anthropicModel: (e.target as HTMLInputElement).value.trim() })} list="claude-models" />
                <datalist id="claude-models">
                  <option value="claude-opus-5-5" />
                  <option value="claude-sonnet-5-5" />
                  <option value="claude-haiku-5-5" />
                </datalist>
              </Field>
            </>
          )}
          {s.ai.provider === 'openai' && (
            <>
              <Field label={t('Base URL')} hint={t('For Ollama: http://localhost:11434/v1')}>
                <input class="input mono wide" value={s.ai.openaiBaseUrl} onInput={(e) => setAi({ openaiBaseUrl: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
              <Field label={t('API key')} hint={t('Stored only on this device, never synced.')}>
                <input type="password" class="input mono wide" value={secrets.openaiKey ?? ''} autoComplete="off" onInput={(e) => setSecret({ openaiKey: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
              <Field label={t('Model')}>
                <input class="input mono wide" value={s.ai.openaiModel} onInput={(e) => setAi({ openaiModel: (e.target as HTMLInputElement).value.trim() })} />
              </Field>
            </>
          )}
          <SwitchField label={t('Strip query strings')} hint={t('Send only site and path, never ?tokens=… or #fragments.')} value={s.ai.stripQuery} onChange={(v) => setAi({ stripQuery: v })} />
          <Field label={granted ? t('Try it on this window') : t('Network access is needed to reach the provider')}>
            {granted ? (
              <button class="btn" disabled={!!action.busy} onClick={test}>
                {action.busy && <span class="spinner" />}
                {t('Test')}
              </button>
            ) : (
              <button class="btn" onClick={grant}>
                {t('Allow')}
              </button>
            )}
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- General

function GeneralSection({ data, saver }: { data: AppData; saver: Saver }) {
  const [s, update] = useSettingsEditor(data, saver);
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  useEffect(() => void chrome.commands.getAll().then(setCommands), []);
  return (
    <div class="section">
      <h1>{t('General')}</h1>
      <div class="card settings-card">
        <Field label={t('Language')}>
          <select class="select" value={s.locale} onChange={(e) => update({ locale: (e.target as HTMLSelectElement).value as Settings['locale'] })}>
            <option value="auto">{t('Same as browser')}</option>
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </Field>
        <Field label={t('Theme')}>
          <select class="select" value={s.theme} onChange={(e) => update({ theme: (e.target as HTMLSelectElement).value as Settings['theme'] })}>
            <option value="auto">{t('System')}</option>
            <option value="light">{t('Light')}</option>
            <option value="dark">{t('Dark')}</option>
          </select>
        </Field>
      </div>
      <Card title={t('Keyboard shortcuts')}>
        {commands.map((c) => (
          <div key={c.name} class="setting-row">
            <span class="grow">{c.name === '_execute_action' ? t('Open command palette') : c.description}</span>
            {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : <span class="muted">{t('not set')}</span>}
          </div>
        ))}
        <a class="setting-row link-row" href="chrome://extensions/shortcuts" onClick={(e) => (e.preventDefault(), void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))}>
          <span class="grow">{t('Change shortcuts')}</span>
          <Icon name="open" class="faint" />
        </a>
      </Card>
      <p class="small muted version">Pin Workflow {chrome.runtime.getManifest().version}</p>
    </div>
  );
}

// ---------------------------------------------------------------- Data

function DataSection({ data, toast }: { data: AppData; toast: ShowToast }) {
  const [usage, setUsage] = useState<{ sync: number; local: number } | null>(null);
  const [pending, setPending] = useState<{ workspaces: Workspace[]; settings: Settings } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void Promise.all([chrome.storage.sync.getBytesInUse(null), chrome.storage.local.getBytesInUse(null)]).then(([sync, local]) => setUsage({ sync, local }));
  }, []);

  const exportAll = () => {
    const bundle: ExportBundle = { format: 'pin-workflow-initializer', version: 2, exportedAt: new Date().toISOString(), workspaces: data.workspaces, settings: data.settings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pin-workflow-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPending(parseImport(await f.text()));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  const replaceAll = async (workspaces: Workspace[], settings: Settings) => {
    await chromeStore.saveWorkspaces(workspaces);
    await chromeStore.saveSettings(settings);
    await chromeStore.patchState({ activeWorkspaceId: workspaces[0]!.id });
  };

  return (
    <div class="section">
      <h1>{t('Data')}</h1>
      <div class="card settings-card">
        <Field label={t('Export')} hint={t('Workspaces, rules, schedules and settings. API keys are never exported.')}>
          <button class="btn" onClick={exportAll}>
            {t('Download')}
          </button>
        </Field>
        <Field label={t('Import')} hint={t('Replaces your workspaces and settings.')}>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile((e.target as HTMLInputElement).files?.[0])} />
          <button class="btn" onClick={() => fileRef.current?.click()}>
            {t('Choose file')}
          </button>
        </Field>
        {pending && (
          <div class="setting-row">
            <span class="grow">{t('Import {0} workspaces and replace the current ones?', pending.workspaces.length)}</span>
            <button class="btn ghost" onClick={() => setPending(null)}>
              {t('Cancel')}
            </button>
            <button class="btn primary" onClick={() => void replaceAll(pending.workspaces, pending.settings).then(() => (setPending(null), toast(t('Imported'))))}>
              {t('Import')}
            </button>
          </div>
        )}
        <Field label={t('Storage')}>
          <span class="muted">
            {usage ? t('Synced: {0} KB of 100 KB · Local: {1} KB', (usage.sync / 1024).toFixed(1), (usage.local / 1024).toFixed(1)) : ''}
          </span>
        </Field>
      </div>
      <div class="card settings-card">
        {confirmReset ? (
          <div class="setting-row">
            <span class="grow">{t('Reset all workspaces, rules and settings to defaults? Archive and timeline are kept.')}</span>
            <button class="btn ghost" onClick={() => setConfirmReset(false)}>
              {t('Cancel')}
            </button>
            <button
              class="btn danger"
              onClick={() => {
                const ws = defaultWorkspaces();
                void replaceAll(ws, defaultSettings(ws)).then(() => (setConfirmReset(false), toast(t('Reset done'))));
              }}
            >
              {t('Reset')}
            </button>
          </div>
        ) : (
          <Field label={t('Reset settings')} hint={t('Restore workspaces, rules and settings to their defaults')}>
            <button class="btn" onClick={() => setConfirmReset(true)}>
              {t('Reset')}
            </button>
          </Field>
        )}
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
