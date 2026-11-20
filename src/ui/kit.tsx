/** Shared UI pieces and hooks for every extension page. */
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { hostOf, unwrapUrl } from '../core/match';
import type { GroupColor, LiveWindow, Settings, Workspace } from '../core/types';
import { chromeApi } from '../engine/chrome-api';
import { chromeStore } from '../engine/chrome-store';
import type { AppState } from '../engine/store';
import { setLocale, t } from '../lib/i18n';
import { call } from '../lib/rpc';
import { ICONS } from './icons';
import './styles.css';

// ---------------------------------------------------------------- icons (Material Symbols, the set Chrome uses)

export function Icon({ name, size = 20, class: cls }: { name: string; size?: number; class?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor" class={cls ? `icon ${cls}` : 'icon'} aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
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

/** Makes a non-button element (a list row) behave like a button for keyboard users: Tab reaches it, Enter/Space press it. */
export function pressable(onPress: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
  } as const;
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

export interface ToastAction {
  label: string;
  run: () => void;
}
export type ShowToast = (msg: string, kind?: 'info' | 'error', action?: ToastAction) => void;

/** Chrome-style snackbar: one line, optional action (usually Undo). */
export function useToast(): [JSX.Element | null, ShowToast] {
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error'; id: number; action?: ToastAction } | null>(null);
  const timer = useRef<number>();
  const show = useCallback<ShowToast>((msg, kind = 'info', action) => {
    window.clearTimeout(timer.current);
    setToast({ msg, kind, id: Date.now(), action });
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' || action ? 6000 : 3000);
  }, []);
  const el = toast ? (
    <div class={`toast ${toast.kind === 'error' ? 'error' : ''}`} key={toast.id} role="status">
      <span>{toast.msg}</span>
      {toast.action && (
        <button
          onClick={() => {
            setToast(null);
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
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
export function useAction(toast: ShowToast) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    /** `undoable`: the toast offers Undo, which reverts the snapshot this action took. */
    async <T,>(key: string, fn: () => Promise<T>, done?: (r: T) => string | void, undoable = false): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        const msg = done?.(r);
        if (msg) {
          toast(msg, 'info', undoable ? { label: t('Undo'), run: () => void call('undo').then(() => toast(t('Undone'))) } : undefined);
        }
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

// ---------------------------------------------------------------- menu

export interface MenuItem {
  label: string;
  icon?: string;
  /** Leading element instead of an icon (e.g. a colour dot). */
  lead?: JSX.Element;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A trigger that opens a floating Chrome-style menu. Closes on outside click, Esc or selection. */
export function Menu({ trigger, items, align = 'right', label }: {
  trigger: (open: () => void, isOpen: boolean) => JSX.Element;
  items: (MenuItem | 'divider' | { heading: string })[];
  align?: 'left' | 'right';
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trig = () => ref.current?.firstElementChild as HTMLElement | null;
  // The trigger announces the menu, as Chrome's ⋮ buttons do.
  useEffect(() => {
    trig()?.setAttribute('aria-haspopup', 'menu');
    trig()?.setAttribute('aria-expanded', String(open));
  });
  useEffect(() => {
    if (!open) return setUp(false);
    const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu button:not(:disabled)') ?? [])];
    const close = (refocus: boolean) => {
      setOpen(false);
      if (refocus) trig()?.focus();
    };
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close(false);
    // Keyboard model of a menu: arrows move, Home/End jump, Esc closes and returns focus, Tab leaves.
    const onKey = (e: KeyboardEvent) => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      const go = (n: number) => (e.preventDefault(), list[(n + list.length) % list.length]?.focus());
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close(true));
      else if (e.key === 'Tab') close(false);
      else if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(-1);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    // Open upwards when there is no room below.
    const menu = ref.current?.querySelector<HTMLElement>('.menu');
    const anchor = ref.current?.getBoundingClientRect();
    if (menu && anchor && anchor.bottom + menu.offsetHeight + 8 > innerHeight && anchor.top > innerHeight - anchor.bottom) setUp(true);
    items()[0]?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div class="menu-anchor" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div class={up ? 'menu up' : 'menu'} role="menu" aria-label={label} style={align === 'right' ? { right: 0 } : { left: 0 }}>
          {items.map((it, i) =>
            it === 'divider' ? (
              <div key={i} class="menu-divider" />
            ) : 'heading' in it ? (
              <div key={i} class="menu-label">{it.heading}</div>
            ) : (
              <button
                key={i}
                role="menuitem"
                class={it.danger ? 'danger' : ''}
                disabled={it.disabled}
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  trig()?.focus();
                  it.onSelect();
                }}
              >
                {it.lead ?? (it.icon ? <Icon name={it.icon} /> : null)}
                <span class="grow ellipsis">{it.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
