import type { MatchKind, TabSpec } from './types';

export type Matcher = (url: string) => boolean;

// Lazy-restore placeholders look like chrome-extension://<32 a-p chars>/suspended.html?url=…
const SUSPENDED_RE = /^chrome-extension:\/\/[a-p]{32}\/suspended\.html\?(.*)$/;

/** If `url` is one of our lazy-restore placeholders, return the real URL it stands for. */
export function unwrapUrl(url: string): string {
  const m = SUSPENDED_RE.exec(url);
  if (!m) return url;
  return new URLSearchParams(m[1]).get('url') ?? url;
}

export function isSuspendedUrl(url: string): boolean {
  return SUSPENDED_RE.test(url);
}

const NEW_TAB_URLS = new Set([
  '',
  'about:blank',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'edge://newtab/',
  'chrome-search://local-ntp/local-ntp.html',
]);

export function isNewTabUrl(url: string): boolean {
  return NEW_TAB_URLS.has(url) || NEW_TAB_URLS.has(url + '/');
}

/** Tabs worth remembering in the archive (real web content, not browser chrome). */
export function isArchivable(url: string): boolean {
  return /^(https?|file|ftp):/i.test(unwrapUrl(url));
}

/** Canonical form used for exact comparisons and de-duplication. */
export function normalizeUrl(url: string): string {
  const raw = unwrapUrl(url);
  try {
    const u = new URL(raw);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
  } catch {
    return raw;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (!/^[a-z*][a-z0-9+.*-]*:/i.test(g)) g = '*://' + g; // "github.com/*" → "*://github.com/*"
  const body = g.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** Compile a user pattern: `/regex/flags` or a glob. Returns null when the pattern is invalid. */
export function compilePattern(pattern: string): Matcher | null {
  const p = pattern.trim();
  if (!p) return null;
  const re = /^\/(.+)\/([a-z]*)$/.exec(p);
  try {
    const rx = re ? new RegExp(re[1]!, re[2]) : globToRegExp(p);
    return (url) => rx.test(unwrapUrl(url));
  } catch {
    return null;
  }
}

export function domainMatcher(domain: string): Matcher | null {
  const d = domain.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return null;
  return (url) => {
    try {
      const host = new URL(unwrapUrl(url)).hostname.toLowerCase();
      return host === d || host.endsWith('.' + d);
    } catch {
      return false;
    }
  };
}

export function ruleMatcher(kind: MatchKind, pattern: string): Matcher | null {
  if (kind === 'domain') return domainMatcher(pattern);
  if (kind === 'regex') return compilePattern(pattern.startsWith('/') ? pattern : `/${pattern}/i`);
  return compilePattern(pattern);
}

export function exactMatcher(specUrl: string): Matcher {
  const target = normalizeUrl(specUrl);
  return (url) => normalizeUrl(url) === target;
}

/**
 * Default matching for pins and preset group tabs: same origin, and the tab's path lives under the
 * spec's "scope". The scope is the path itself for 0–1 segment paths (`/notifications`), otherwise
 * its directory (`/mail/u/0/#inbox` → `/mail/u/0/`). So a pinned Gmail tab that has navigated to a
 * thread is still recognised as the Gmail pin, while `github.com/notifications` doesn't swallow
 * every GitHub tab.
 */
export function scopeMatcher(specUrl: string): Matcher {
  let spec: URL;
  try {
    spec = new URL(specUrl);
  } catch {
    return exactMatcher(specUrl);
  }
  if (spec.protocol !== 'http:' && spec.protocol !== 'https:') return exactMatcher(specUrl);
  const segments = spec.pathname.split('/').filter(Boolean);
  const hasTrailingSlash = spec.pathname.endsWith('/');
  let scope: string;
  if (segments.length <= 1 && !hasTrailingSlash) scope = spec.pathname || '/';
  else if (hasTrailingSlash) scope = spec.pathname;
  else scope = spec.pathname.slice(0, spec.pathname.lastIndexOf('/') + 1);
  const host = spec.host.toLowerCase();
  return (url) => {
    try {
      const u = new URL(unwrapUrl(url));
      if (u.host.toLowerCase() !== host) return false;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (scope.endsWith('/')) return u.pathname.startsWith(scope) || u.pathname + '/' === scope;
      return u.pathname === scope || u.pathname.startsWith(scope + '/');
    } catch {
      return false;
    }
  };
}

export function specMatcher(spec: TabSpec, exact = false): Matcher {
  if (spec.match) {
    const m = compilePattern(spec.match);
    if (m) return m;
  }
  return exact ? exactMatcher(spec.url) : scopeMatcher(spec.url);
}

export function hostOf(url: string): string {
  try {
    return new URL(unwrapUrl(url)).hostname;
  } catch {
    return '';
  }
}
