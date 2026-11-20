/**
 * Command palette (the toolbar popup, ⌥⇧K). One fuzzy list over workspaces, actions, every open tab
 * and the archive. Prefixes narrow it: ">" actions, "@" workspaces, "#" archive.
 */
import { render, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { rank } from '../../core/fuzzy';
import { unwrapUrl } from '../../core/match';
import type { ArchivedTab } from '../../core/types';
import { chromeStore } from '../../engine/chrome-store';
import { t } from '../../lib/i18n';
import { call } from '../../lib/rpc';
import { displayHost, Favicon, Highlight, Icon, Kbd, summaryText, timeAgo, useAppData, useToast } from '../../ui/kit';
import './palette.css';

type Kind = 'workspace' | 'action' | 'tab' | 'archived';

interface Item {
  id: string;
  kind: Kind;
  title: string;
  subtitle: string;
  icon: JSX.Element;
  keywords?: string;
  hint?: string;
  /** Returns a message to flash before closing, or false to keep the palette open. */
  run: (e: { shift: boolean }) => Promise<string | false | void>;
  secondary?: { label: string; run: () => Promise<void> };
  rank?: number;
}

const close = () => window.close();

let currentWindowId: number = chrome.windows.WINDOW_ID_CURRENT;
void chrome.windows.getCurrent().then((w) => (currentWindowId = w.id ?? currentWindowId));

/** Open the side panel and leave it a task to pick up (AI runs there). */
async function openPanelWith(intent?: string) {
  // sidePanel.open must be called while the user gesture is still live: before any await.
  const opening = chrome.sidePanel.open({ windowId: currentWindowId });
  if (intent) await chrome.storage.session.set({ panelIntent: { intent, at: Date.now() } });
  await opening;
}

function Palette() {
  const data = useAppData();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [archive, setArchive] = useState<ArchivedTab[]>([]);
  const [busy, setBusy] = useState(false);
  const [toastEl, toast] = useToast();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void chrome.tabs.query({}).then((all) => setTabs(all.filter((x) => !x.incognito)));
    void chromeStore.listArchived().then(setArchive);
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const { workspaces, active } = data;
    const ws: Item[] = workspaces.map((w, i) => {
      const isActive = w.id === active?.id;
      return {
        id: `ws:${w.id}`,
        kind: 'workspace',
        title: isActive ? t('Re-initialize {0}', w.name) : t('Switch to {0}', w.name),
        subtitle: isActive ? t('Current workspace · pins, groups and clean-up') : t(w.pins.length === 1 ? '1 pin' : '{0} pins', w.pins.length),
        keywords: w.name,
        icon: <span class={`dot bg-g g-${w.color}`} />,
        hint: i < 9 ? `⌘${i + 1}` : undefined,
        run: async ({ shift }) => {
          const r = isActive || shift ? await call('apply', { workspaceId: w.id }) : await call('switchTo', { workspaceId: w.id });
          return summaryText(r.summary);
        },
      };
    });
    const action = (id: string, title: string, subtitle: string, icon: string, run: Item['run'], keywords = ''): Item => ({
      id: `a:${id}`, kind: 'action', title, subtitle, icon: <Icon name={icon} />, run, keywords,
    });
    const ai = data.settings.ai.provider !== 'off';
    const actions: Item[] = [
      action('undo', t('Undo last action'), t('Restore the browser to before the last change'), 'undo', async () => {
        const r = await call('undo');
        return r.message === 'nothing' ? t('Nothing to undo') : t('Undone');
      }, 'revert back'),
      action('archive', t('Archive ungrouped tabs'), t('Close them into the searchable archive'), 'archive', async () => summaryText((await call('archiveUngrouped')).summary), 'clean tidy close'),
      action('dedupe', t('Close duplicate tabs'), t('Keep one copy of each page'), 'dup', async () => summaryText((await call('dedupe')).summary), 'duplicates dedupe'),
      action('collapse', t('Collapse all groups'), t('Fold every tab group except the current one'), 'collapse', async () => (await call('collapseAll'), t('Done'))),
      action('merge', t('Merge all windows'), t('Pull every window into this one, keeping groups'), 'merge', async () => (await call('mergeWindows'), t('Done')), 'windows combine'),
      action('snapshot', t('Take snapshot'), t('Save the whole browser to the timeline'), 'camera', async () => (await call('snapshot', {}), t('Snapshot saved')), 'save backup checkpoint'),
      action('new-ws', t('Save window as new workspace'), t('Pins become its pins, the rest its session'), 'plus', async () => {
        const name = query.replace(/^[>@#]\s*/, '').trim();
        const w = await call('newWorkspaceFromWindow', { name: name && !/^(save|new)/i.test(name) ? name : t('Workspace {0}', data.workspaces.length + 1) });
        return t('Created {0}', w.name);
      }, 'create capture'),
      ...(ai
        ? [
            action('ai-group', t('Smart group with AI'), t('Let AI sort ungrouped tabs into groups'), 'sparkles', async () => (await openPanelWith('ai-group'), close(), false), 'organize organise ai'),
            action('ai-summary', t('Where was I?'), t('AI summary of this window'), 'wand', async () => (await openPanelWith('ai-summary'), close(), false), 'summary summarize recap ai'),
          ]
        : []),
      action('panel', t('Open dashboard'), t('Side panel with workspaces, archive and timeline'), 'panel', async () => (await openPanelWith(), close(), false), 'side panel timeline'),
      action('settings', t('Settings'), t('Workspaces, rules, schedules, AI'), 'settings', async () => (await chrome.runtime.openOptionsPage(), false), 'options preferences'),
    ];
    const tabItems: Item[] = tabs
      .filter((x) => x.id !== undefined)
      .map((x) => ({
        id: `t:${x.id}`,
        kind: 'tab' as const,
        title: x.title || x.url || '',
        subtitle: displayHost(x.url ?? ''),
        keywords: unwrapUrl(x.url ?? ''),
        icon: <Favicon url={x.url ?? ''} />,
        rank: (x as { lastAccessed?: number }).lastAccessed ?? 0,
        run: async () => {
          await chrome.tabs.update(x.id!, { active: true });
          await chrome.windows.update(x.windowId, { focused: true });
          close();
          return false as const;
        },
        secondary: {
          label: t('Close tab'),
          run: async () => {
            await chrome.tabs.remove(x.id!);
            setTabs((ts) => ts.filter((y) => y.id !== x.id));
          },
        },
      }));
    const archived: Item[] = archive.map((a) => ({
      id: `r:${a.id}`,
      kind: 'archived' as const,
      title: a.title,
      subtitle: `${displayHost(a.url)} · ${t('archived')} ${timeAgo(a.archivedAt)}`,
      keywords: a.url,
      icon: <Favicon url={a.url} />,
      run: async () => (await call('restoreArchived', { ids: [a.id] }), close(), false),
    }));
    return [...ws, ...actions, ...tabItems, ...archived];
  }, [data, tabs, archive, query]);

  const results = useMemo(() => {
    const m = /^([>@#])\s*(.*)$/.exec(query);
    const prefix = m?.[1];
    const q = (m ? m[2] : query)!.trim();
    let pool = items;
    if (prefix === '>') pool = items.filter((i) => i.kind === 'action');
    if (prefix === '@') pool = items.filter((i) => i.kind === 'workspace');
    if (prefix === '#') pool = items.filter((i) => i.kind === 'archived');
    if (!q) {
      if (prefix) return pool.slice(0, 60).map((item) => ({ item, hits: {} as Record<string, number[]> }));
      const recent = pool.filter((i) => i.kind === 'tab').sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(1, 9);
      return [...pool.filter((i) => i.kind === 'workspace'), ...recent].map((item) => ({ item, hits: {} as Record<string, number[]> }));
    }
    const kindBoost: Record<Kind, number> = { workspace: 1.25, action: 1.15, tab: 1, archived: 0.8 };
    const ranked = rank(pool, q, [
      { name: 'title', get: (i) => i.title, weight: 1.2 },
      { name: 'subtitle', get: (i) => i.subtitle, weight: 0.6 },
      { name: 'keywords', get: (i) => i.keywords ?? '', weight: 0.7 },
    ])
      .map((r) => ({ ...r, score: r.score * kindBoost[r.item.kind] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    // Show results in sections (like Chrome's Tab search); the section holding the best match comes first.
    const best = new Map<Kind, number>();
    for (const r of ranked) best.set(r.item.kind, Math.max(best.get(r.item.kind) ?? 0, r.score));
    return ranked.sort((a, b) => best.get(b.item.kind)! - best.get(a.item.kind)! || b.score - a.score);
  }, [items, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const exec = async (item: Item, shift = false) => {
    setBusy(true);
    try {
      const msg = await item.run({ shift });
      if (msg === false) return;
      toast(msg || t('Done'));
      setTimeout(close, 700);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const n = results.length;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setSel((s) => (s + 1) % Math.max(n, 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setSel((s) => (s - 1 + n) % Math.max(n, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[sel];
      if (r && !busy) void exec(r.item, e.shiftKey);
    } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
      const r = results[sel];
      if (r?.item.secondary) {
        e.preventDefault();
        void r.item.secondary.run();
      }
    } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const w = items.filter((i) => i.kind === 'workspace')[Number(e.key) - 1];
      if (w) {
        e.preventDefault();
        void exec(w);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  };

  const sections: Record<Kind, string> = { workspace: t('Workspaces'), action: t('Actions'), tab: query.trim() ? t('Open tabs') : t('Recent tabs'), archived: t('Archive') };
  let lastKind: Kind | undefined;

  return (
    <div class="palette" onKeyDown={onKey}>
      <div class="search">
        <Icon name="search" class="search-icon" />
        <input
          ref={inputRef}
          class="q"
          placeholder={t('Search tabs, workspaces and actions')}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          spellcheck={false}
          autoFocus
        />
        {busy && <span class="spinner" />}
      </div>
      <div class="list" ref={listRef} role="listbox">
        {results.length === 0 && <div class="empty">{t('No matches')}</div>}
        {results.map((r, i) => {
          const header = r.item.kind !== lastKind;
          lastKind = r.item.kind;
          return (
            <>
              {header && <div class="section">{sections[r.item.kind]}</div>}
              <div
                key={r.item.id}
                class="item"
                role="option"
                aria-selected={i === sel}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={(e) => void exec(r.item, e.shiftKey)}
              >
                <span class="ico">{r.item.icon}</span>
                <span class="grow">
                  <div class="title ellipsis">
                    <Highlight text={r.item.title} indices={r.hits.title} />
                  </div>
                  <div class="sub ellipsis">
                    <Highlight text={r.item.subtitle} indices={r.hits.subtitle} />
                  </div>
                </span>
                {r.item.hint && <Kbd>{r.item.hint}</Kbd>}
              </div>
            </>
          );
        })}
      </div>
      {toastEl}
    </div>
  );
}

render(<Palette />, document.getElementById('app')!);
