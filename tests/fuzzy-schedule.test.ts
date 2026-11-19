import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rank } from '../src/core/fuzzy';
import { dueSchedules, nextRun } from '../src/core/schedule';
import type { Schedule } from '../src/core/types';

describe('fuzzy', () => {
  it('prefers prefix and word-boundary substrings', () => {
    const a = fuzzyMatch('cal', 'Google Calendar')!;
    const b = fuzzyMatch('cal', 'Musical theatre')!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(fuzzyMatch('gcal', 'Google Calendar')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Google Calendar')).toBeNull();
  });
  it('requires every term, possibly across fields', () => {
    const items = [
      { title: 'Pull requests', url: 'https://github.com/acme/pulls' },
      { title: 'Inbox', url: 'https://mail.google.com/' },
    ];
    const r = rank(items, 'github pull', [
      { name: 'title', get: (i) => i.title, weight: 1.2 },
      { name: 'url', get: (i) => i.url },
    ]);
    expect(r.map((x) => x.item.title)).toEqual(['Pull requests']);
    expect(r[0]!.hits.title).toBeDefined();
  });
});

describe('schedules', () => {
  const s: Schedule = { id: 's', enabled: true, workspaceId: 'w', days: [1, 2, 3, 4, 5], time: '09:00' };
  const monday = (h: number, m: number) => new Date(2026, 10, 16, h, m); // 16 Nov 2026 is a Monday
  it('fires within the grace window once per occurrence', () => {
    expect(dueSchedules([s], monday(8, 59), {})).toHaveLength(0);
    const due = dueSchedules([s], monday(9, 3), {});
    expect(due).toHaveLength(1);
    expect(dueSchedules([s], monday(9, 4), { s: due[0]!.key })).toHaveLength(0);
    expect(dueSchedules([s], monday(9, 5), {})).toHaveLength(0);
  });
  it('respects days and computes the next run', () => {
    const saturday = new Date(2026, 10, 21, 9, 1);
    expect(dueSchedules([s], saturday, {})).toHaveLength(0);
    expect(nextRun(s, saturday)!.getDay()).toBe(1);
    expect(nextRun({ ...s, days: [] }, saturday)).toBeNull();
  });
});
