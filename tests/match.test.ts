import { describe, expect, it } from 'vitest';
import { compilePattern, domainMatcher, isNewTabUrl, normalizeUrl, ruleMatcher, scopeMatcher, unwrapUrl } from '../src/core/match';

const PH = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/suspended.html?url=' + encodeURIComponent('https://example.com/a?b=1') + '&title=x';

describe('scopeMatcher', () => {
  it('treats a deep URL as its directory scope', () => {
    const gmail = scopeMatcher('https://mail.google.com/mail/u/0/#inbox');
    expect(gmail('https://mail.google.com/mail/u/0/#inbox/FMfcgz')).toBe(true);
    expect(gmail('https://mail.google.com/mail/u/1/#inbox')).toBe(false);
    const cal = scopeMatcher('https://calendar.google.com/calendar/u/0/r');
    expect(cal('https://calendar.google.com/calendar/u/0/r/week/2026/11/19')).toBe(true);
  });
  it('keeps single-segment paths narrow', () => {
    const notif = scopeMatcher('https://github.com/notifications');
    expect(notif('https://github.com/notifications?query=is:unread')).toBe(true);
    expect(notif('https://github.com/notifications/beta')).toBe(true);
    expect(notif('https://github.com/notificationsX')).toBe(false);
    expect(notif('https://github.com/anthropics')).toBe(false);
  });
  it('treats a root URL as the whole site', () => {
    const m = scopeMatcher('https://news.ycombinator.com/');
    expect(m('https://news.ycombinator.com/item?id=1')).toBe(true);
    expect(m('https://ycombinator.com/')).toBe(false);
  });
  it('sees through lazy placeholders', () => {
    expect(scopeMatcher('https://example.com/a')(PH)).toBe(true);
  });
  it('falls back to exact for non-web URLs', () => {
    expect(scopeMatcher('chrome://settings/')('chrome://settings/')).toBe(true);
    expect(scopeMatcher('chrome://settings/')('chrome://history/')).toBe(false);
  });
});

describe('patterns', () => {
  it('globs default to any scheme', () => {
    const m = compilePattern('github.com/*/pulls')!;
    expect(m('https://github.com/acme/pulls')).toBe(true);
    expect(m('https://github.com/acme/issues')).toBe(false);
  });
  it('supports /regex/flags and rejects invalid ones', () => {
    expect(compilePattern('/jira\\.\\w+\\.com/i')!('https://JIRA.acme.com/browse/X-1')).toBe(true);
    expect(compilePattern('/([/')).toBeNull();
  });
  it('domain matches subdomains but not lookalikes', () => {
    const m = domainMatcher('youtube.com')!;
    expect(m('https://www.youtube.com/watch?v=1')).toBe(true);
    expect(m('https://notyoutube.com/')).toBe(false);
    expect(ruleMatcher('regex', '^https://x\\.com/')!('https://x.com/home')).toBe(true);
  });
});

describe('url helpers', () => {
  it('normalizes', () => {
    expect(normalizeUrl('https://Example.com/a/')).toBe('https://example.com/a');
    expect(normalizeUrl(PH)).toBe('https://example.com/a?b=1');
    expect(unwrapUrl(PH)).toBe('https://example.com/a?b=1');
  });
  it('recognises new tab pages', () => {
    expect(isNewTabUrl('chrome://newtab/')).toBe(true);
    expect(isNewTabUrl('chrome://newtab')).toBe(true);
    expect(isNewTabUrl('https://google.com/')).toBe(false);
  });
});
