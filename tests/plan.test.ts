import { describe, expect, it } from 'vitest';
import { plan, type Target } from '../src/core/plan';
import { targetForApply, targetForPins, targetForRestore, targetForSwitch, snapshotWindow, sessionFromWindow } from '../src/core/targets';
import { newWorkspace, pin } from '../src/core/defaults';
import { execute } from '../src/engine/executor';
import { FakeBrowser } from './fake-browser';

const GMAIL = 'https://mail.google.com/mail/u/0/#inbox';
const CAL = 'https://calendar.google.com/calendar/u/0/r';
const DRIVE = 'https://drive.google.com/drive/u/0/my-drive';

async function converge(fb: FakeBrowser, target: Target) {
  const winId = fb.focused!;
  const before = await fb.getWindow(winId);
  const p = plan(before, target);
  const archived: string[] = [];
  const res = await execute(fb, winId, p.ops, { archive: async (tabs) => void archived.push(...tabs.map((t) => t.url)) });
  fb.assertInvariants();
  const again = plan(await fb.getWindow(winId), target);
  return { plan: p, res, again, archived };
}

const work = () =>
  newWorkspace({ name: 'Work', pins: [pin(GMAIL), pin(CAL), pin(DRIVE)], ungrouped: 'archive', collapseGroups: true, openNewTab: true });

describe('apply (initialize)', () => {
  it('cleans a messy window, reuses tabs and keeps groups', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([
      { url: 'https://random.example/', pinned: true },
      { url: 'https://a.dev/1', group: 'Dev' },
      { url: 'https://mail.google.com/mail/u/0/#inbox/thread-42' },
      { url: 'https://a.dev/2', group: 'Dev' },
      { url: 'https://c.example/' },
      { url: 'https://d.example/', active: true },
    ]);
    const { plan: p, res, again, archived } = await converge(fb, targetForApply(work(), { dedupeOnApply: true }));
    expect(res.errors).toEqual([]);
    expect(fb.strip()).toEqual([
      '📌https://mail.google.com/mail/u/0/#inbox/thread-42',
      `📌${CAL}`,
      `📌${DRIVE}`,
      '[Dev]https://a.dev/1',
      '[Dev]https://a.dev/2',
      'chrome://newtab/ *',
    ]);
    expect(archived.sort()).toEqual(['https://c.example/', 'https://d.example/', 'https://random.example/']);
    expect(fb.calls.filter((c) => c.includes('create') && c.includes('mail.google'))).toEqual([]);
    expect(p.summary.reused).toBe(1);
    expect([...fb.windows.values()][0]!.groups.values().next().value!.collapsed).toBe(true);
    expect(again.ops).toEqual([]);
  });

  it('only moves pins that are out of order', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([
      { url: DRIVE, pinned: true },
      { url: GMAIL, pinned: true },
      { url: CAL, pinned: true },
      { url: 'chrome://newtab/', active: true },
    ]);
    const { plan: p, again } = await converge(fb, targetForApply(work(), { dedupeOnApply: true }));
    expect(p.ops.every((o) => o.op === 'move')).toBe(true);
    expect(fb.strip().slice(0, 3)).toEqual([`📌${GMAIL}`, `📌${CAL}`, `📌${DRIVE}`]);
    expect(again.ops).toEqual([]);
  });

  it('never closes the window, even when every tab goes', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([{ url: 'https://x.example/' }, { url: 'https://y.example/', active: true }]);
    const ws = newWorkspace({ pins: [], ungrouped: 'close', openNewTab: false });
    await converge(fb, targetForApply(ws, { dedupeOnApply: false }));
    expect(fb.windows.size).toBe(1);
    expect(fb.strip()).toEqual(['chrome://newtab/ *']);
  });

  it('builds preset groups from matching tabs and creates the missing ones', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([{ url: 'https://docs.example/spec' }, { url: 'chrome://newtab/', active: true }]);
    const ws = newWorkspace({
      pins: [],
      ungrouped: 'keep',
      collapseGroups: false,
      groups: [{ id: 'g', title: 'Docs', color: 'green', collapsed: false, tabs: [{ url: 'https://docs.example/spec' }, { url: 'https://wiki.example/' }] }],
    });
    const { again } = await converge(fb, targetForApply(ws, { dedupeOnApply: false }));
    expect(fb.strip()).toEqual(['[Docs]https://docs.example/spec', '[Docs]https://wiki.example/', 'chrome://newtab/ *']);
    const g = [...[...fb.windows.values()][0]!.groups.values()][0]!;
    expect(g.color).toBe('green');
    expect(again.ops).toEqual([]);
  });

  it('dedupes kept tabs, keeping the active copy', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([{ url: 'https://dup.example/' }, { url: 'https://other.example/' }, { url: 'https://dup.example/', active: true }]);
    const ws = newWorkspace({ ungrouped: 'keep', openNewTab: false });
    const { plan: p } = await converge(fb, targetForApply(ws, { dedupeOnApply: true }));
    expect(p.summary.closed).toBe(1);
    expect(fb.strip()).toEqual(['https://other.example/', 'https://dup.example/ *']);
  });

  it('can take a pin out of a group that is going away', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([{ url: GMAIL, group: 'Old' }, { url: 'https://z.example/', group: 'Old', active: true }]);
    const target = { ...targetForApply(newWorkspace({ pins: [pin(GMAIL)] }), { dedupeOnApply: false }), leftoverGroups: 'close' as const };
    const { res } = await converge(fb, target);
    expect(res.errors).toEqual([]);
    expect(fb.strip()).toEqual([`📌${GMAIL}`, 'chrome://newtab/ *']);
  });
});

describe('pins only', () => {
  it('keeps the user’s extra pins after the workspace pins', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([{ url: 'https://mine.example/', pinned: true }, { url: 'https://n.example/', active: true }]);
    const { again } = await converge(fb, targetForPins(work()));
    expect(fb.strip()).toEqual([`📌${GMAIL}`, `📌${CAL}`, `📌${DRIVE}`, '📌https://mine.example/', 'https://n.example/ *']);
    expect(again.ops).toEqual([]);
  });
});

describe('switch & restore', () => {
  it('restores a session lazily and is stable afterwards', async () => {
    const fb = new FakeBrowser();
    // The "research" window we will save as a session.
    fb.addWindow(
      [
        { url: 'https://paper.example/1', group: 'Papers' },
        { url: 'https://paper.example/2', group: 'Papers', active: true },
        { url: 'https://notes.example/' },
      ],
      { groups: { Papers: { color: 'red' } } },
    );
    const session = sessionFromWindow(await fb.getWindow(fb.focused!));

    const fb2 = new FakeBrowser();
    fb2.addWindow([{ url: GMAIL, pinned: true }, { url: 'https://work-stuff.example/', active: true }]);
    const research = newWorkspace({ pins: [pin(GMAIL)], collapseGroups: false });
    const { res, again } = await converge(fb2, targetForSwitch(research, session, { lazyRestore: true, dedupeOnApply: true }));
    expect(res.errors).toEqual([]);
    const strip = fb2.strip();
    expect(strip[0]).toBe(`📌${GMAIL}`);
    expect(strip[1]).toMatch(/^\[Papers\]chrome-extension:.*suspended\.html\?url=https%3A%2F%2Fpaper\.example%2F1/);
    expect(strip[2]).toBe('[Papers]https://paper.example/2 *'); // active tab loads for real
    expect(strip[3]).toMatch(/suspended\.html\?url=https%3A%2F%2Fnotes/);
    expect(strip).toHaveLength(4);
    expect(again.ops).toEqual([]);
  });

  it('round-trips a snapshot after the window was rearranged', async () => {
    const fb = new FakeBrowser();
    fb.addWindow(
      [
        { url: GMAIL, pinned: true },
        { url: 'https://a.example/', group: 'A' },
        { url: 'https://b.example/', group: 'A', active: true },
        { url: 'https://c.example/' },
      ],
      { groups: { A: { color: 'cyan', collapsed: false } } },
    );
    const snap = snapshotWindow(await fb.getWindow(fb.focused!));
    const original = fb.strip();
    // mess it up
    const win = await fb.getWindow(fb.focused!);
    await fb.updateTab(win.tabs[0]!.id, { pinned: false });
    await fb.removeTabs([win.tabs[3]!.id]);
    await fb.createTab({ windowId: win.id, url: 'https://junk.example/', active: true });
    await fb.ungroupTabs([win.tabs[1]!.id]);

    const { again } = await converge(fb, targetForRestore(snap, false));
    expect(fb.strip()).toEqual(original);
    expect(again.ops).toEqual([]);
  });

  it('restores the interleaving of loose tabs and groups', async () => {
    const fb = new FakeBrowser();
    fb.addWindow([
      { url: GMAIL, pinned: true },
      { url: 'https://news.example/' },
      { url: 'https://pr.example/1', group: 'Review' },
      { url: 'https://pr.example/2', group: 'Review' },
      { url: 'https://blog.example/', active: true },
      { url: 'https://w.example/1', group: 'Work' },
    ]);
    const snap = snapshotWindow(await fb.getWindow(fb.focused!));
    const original = fb.strip();
    // Shuffle: move the loose tab to the end and the Work group to the front.
    const win = await fb.getWindow(fb.focused!);
    await fb.moveTabs([win.tabs[1]!.id], { index: -1 });
    await fb.moveGroup(win.groups.find((g) => g.title === 'Work')!.id, { windowId: win.id, index: 1 });
    expect(fb.strip()).not.toEqual(original);

    const { again } = await converge(fb, targetForRestore(snap, false));
    expect(fb.strip()).toEqual(original);
    expect(again.ops).toEqual([]);
  });
});
