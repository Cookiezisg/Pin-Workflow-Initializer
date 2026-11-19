/** Shared UI pieces and hooks for every extension page. */
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { hostOf, unwrapUrl } from '../core/match';
import type { GroupColor, LiveWindow, Settings, Workspace } from '../core/types';
import { chromeApi } from '../engine/chrome-api';
import { chromeStore } from '../engine/chrome-store';
import type { AppState } from '../engine/store';
import { setLocale, t } from '../lib/i18n';
import './styles.css';

// ---------------------------------------------------------------- icons (inline SVG, 16px, currentColor)

const paths: Record<string, string> = {
  pin: 'M9.5 2.5l4 4-2 1-2.5 2.5.5 3-1.5 1.5-2.5-3.5L2 14.5 1.5 14l3.5-3.5L1.5 8 3 6.5l3 .5L8.5 4.5z',
  play: 'M5 3.5v9l7.5-4.5z',
  undo: 'M6 4L2.5 7.5 6 11M3 7.5h6.5a4 4 0 010 8H8',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
  archive: 'M2 3.5h12v3H2zM3 6.5v6.5h10V6.5M6.5 9h3',
  camera: 'M2 5h3l1-1.5h4L11 5h3v8H2zM8 11.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z',
  sparkles: 'M8 1.5l1.3 3.7L13 6.5l-3.7 1.3L8 11.5 6.7 7.8 3 6.5l3.7-1.3zM12.5 10l.6 1.6 1.4.4-1.4.5-.6 1.5-.5-1.5-1.5-.5 1.5-.4z',
  settings: 'M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM13 8l1.3-1-1-2-1.6.4-1-.9L10.3 3H7.7l-.4 1.5-1 .9L4.7 5l-1 2L5 8l-1.3 1 1 2 1.6-.4 1 .9.4 1.5h2.6l.4-1.5 1-.9 1.6.4 1-2z',
  x: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  up: 'M8 3.5L3.5 8M8 3.5L12.5 8M8 3.5V13',
  down: 'M8 12.5L3.5 8M8 12.5L12.5 8M8 12.5V3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  restore: 'M2.5 8a5.5 5.5 0 105.5-5.5c-1.8 0-3.2.8-4.3 2M3.5 2.5v3h3',
  layers: 'M8 2l6 3.2-6 3.2-6-3.2zM2 8.3l6 3.2 6-3.2M2 11.3l6 3.2 6-3.2',
  merge: 'M4 2.5v3a3 3 0 003 3h2a3 3 0 013 3v2M12 2.5v3a3 3 0 01-3 3M10.5 12l1.5 1.5 1.5-1.5',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  chevron: 'M6 4l4 4-4 4',
  search: 'M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6L14 14',
  clock: 'M8 14a6 6 0 100-12 6 6 0 000 12zM8 4.5V8l2.5 1.5',
  panel: 'M2 3h12v10H2zM10 3v10',
  send: 'M2 8l12-5.5L10 14l-2-4.5zM8 9.5l6-7',
  collapse: 'M4 6l4-3.5L12 6M4 10l4 3.5 4-3.5',
  check: 'M3 8.5l3.5 3.5L13 4.5',
  wand: 'M2.5 13.5l8-8M9 3.5l.5-1.5.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L7.5 4zM12.5 7l.4-1 .4 1 1 .4-1 .4-.4 1-.4-1-1-.4z',
  dup: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7M8 7.5v3M6.5 9h3',
};

export function Icon({ name, size = 16, class: cls }: { name: keyof typeof paths | string; size?: number; class?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class={cls} aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

export function Favicon({ url, size = 16 }: { url: string; size?: number }) {
  const real = unwrapUrl(url);
  const src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(real)}&size=${size * 2}`;
  return <img class="favicon" src={src} width={size} height={size} alt="" loading="lazy" />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" class="toggle" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <span class="kbd">{children}</span>;
}

export const GROUP_SWATCH: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export function ColorPicker({ value, onChange }: { value: GroupColor; onChange: (c: GroupColor) => void }) {
  return (
    <div class="row" style={{ gap: '6px' }}>
      {GROUP_SWATCH.map((c) => (
        <button type="button" key={c} class={`swatch g-${c} bg-g`} aria-pressed={value === c} title={t(c)} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** Highlight matched character positions. */
export function Highlight({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices || indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  const out: JSX.Element[] = [];
  let buf = '';
  let marked = false;
  const flush = (k: number) => {
    if (!buf) return;
    out.push(marked ? <mark key={k}>{buf}</mark> : <span key={k}>{buf}</span>);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== marked) {
      flush(i);
      marked = m;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export function displayHost(url: string): string {
  const h = hostOf(url);
  return h.replace(/^www\./, '') || unwrapUrl(url).replace(/^(\w+):\/\//, '').slice(0, 40);
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return t('just now');
  const m = Math.round(s / 60);
  if (m < 60) return t('{0}m ago', m);
  const h = Math.round(m / 60);
  if (h < 24) return t('{0}h ago', h);
  const d = Math.round(h / 24);
  if (d < 7) return t('{0}d ago', d);
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------- toast

export function useToast(): [JSX.Element | null, (msg: string, kind?: 'info' | 'error') => void] {
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error'; id: number } | null>(null);
  const timer = useRef<number>();
  const show = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    window.clearTimeout(timer.current);
    setToast({ msg, kind, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2400);
  }, []);
  const el = toast ? (
    <div class={`toast ${toast.kind === 'error' ? 'error' : ''}`} key={toast.id} role="status">
      {toast.msg}
    </div>
  ) : null;
  return [el, show];
}

// ---------------------------------------------------------------- data hooks

export interface AppData {
  workspaces: Workspace[];
  settings: Settings;
  state: AppState;
  active: Workspace | undefined;
}

/** Workspaces, settings and runtime state, kept live via storage change events. */
export function useAppData(): AppData | null {
  const [data, setData] = useState<AppData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [workspaces, settings, state] = await Promise.all([chromeStore.getWorkspaces(), chromeStore.getSettings(), chromeStore.getState()]);
      if (!alive) return;
      setLocale(settings.locale);
      applyTheme(settings.theme);
      setData({ workspaces, settings, state, active: workspaces.find((w) => w.id === state.activeWorkspaceId) ?? workspaces[0] });
    };
    void load();
    const onChange = (changes: Record<string, unknown>) => {
      if (Object.keys(changes).some((k) => k === 'settings' || k === 'state' || k.startsWith('ws:') || k.startsWith('overflow:'))) void load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return data;
}

export function applyTheme(theme: Settings['theme']): void {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** The window this page belongs to, kept live via tab events. */
export function useCurrentWindow(): LiveWindow | null {
  const [win, setWin] = useState<LiveWindow | null>(null);
  useEffect(() => {
    let windowId: number | undefined;
    let timer: number | undefined;
    let alive = true;
    const load = async () => {
      windowId ??= (await chrome.windows.getCurrent()).id;
      if (windowId === undefined) return;
      try {
        const w = await chromeApi.getWindow(windowId);
        if (alive) setWin(w);
      } catch {
        /* window closed */
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 80);
    };
    void load();
    const events = [
      chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onActivated,
      chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated,
      chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
    ] as unknown as chrome.events.Event<() => void>[];
    events.forEach((e) => e.addListener(schedule));
    return () => {
      alive = false;
      events.forEach((e) => e.removeListener(schedule));
    };
  }, []);
  return win;
}

/** Run an async action with busy state and a toast on failure. */
export function useAction(toast: (m: string, k?: 'info' | 'error') => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, done?: (r: T) => string | void): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        const msg = done?.(r);
        if (msg) toast(msg);
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

export function summaryText(s: { reused: number; created: number; moved: number; grouped: number; archived: number; closed: number } | undefined): string {
  if (!s) return t('Done');
  const parts = [
    s.created && t('{0} opened', s.created),
    s.reused && t('{0} reused', s.reused),
    s.grouped && t('{0} grouped', s.grouped),
    s.archived && t('{0} archived', s.archived),
    s.closed && t('{0} closed', s.closed),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('Already in place');
}
