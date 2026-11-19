import type { Schedule } from './types';

/** How late a schedule may still fire (the service worker / alarms can be delayed). */
export const GRACE_MINUTES = 5;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Schedules that should fire at `now` and haven't fired for this occurrence yet. */
export function dueSchedules(schedules: Schedule[], now: Date, lastFired: Record<string, string>): { schedule: Schedule; key: string }[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: { schedule: Schedule; key: string }[] = [];
  for (const s of schedules) {
    if (!s.enabled || !s.workspaceId || !s.days.includes(now.getDay())) continue;
    const delta = nowMin - minutesOf(s.time);
    if (delta < 0 || delta >= GRACE_MINUTES) continue;
    const key = `${dayKey(now)} ${s.time}`;
    if (lastFired[s.id] === key) continue;
    out.push({ schedule: s, key });
  }
  // If two schedules collide, the later one in the list wins (it runs last).
  return out;
}

/** Next time `s` fires after `now`, or null if it never will. */
export function nextRun(s: Schedule, now: Date): Date | null {
  if (!s.enabled || s.days.length === 0) return null;
  const target = minutesOf(s.time);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, Math.floor(target / 60), target % 60);
    if (d > now && s.days.includes(d.getDay())) return d;
  }
  return null;
}
