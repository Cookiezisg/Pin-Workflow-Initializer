import { describe, expect, it } from 'vitest';
import { migrateV1, newWorkspace, parseImport, pin, sanitizeSettings, sanitizeWorkspace } from '../src/core/defaults';
import { evaluateRules } from '../src/core/rules';
import { Engine } from '../src/engine/engine';
import { MemoryStore } from '../src/engine/memory-store';
import { FakeBrowser } from './fake-browser';

const GMAIL = 'https://mail.google.com/mail/u/0/#inbox';
const JIRA = 'https://jira.example/board';

function setup(seed: Parameters<FakeBrowser['addWindow']>[0], opts: { otherWindows?: 'keep' | 'merge' | 'archive' | 'close' } = {}) {
  const fb = new FakeBrowser();
  fb.addWindow(seed);
  const work = newWorkspace({ name: 'Work', pins: [pin(GMAIL), pin(JIRA)], otherWindows: opts.otherWindows ?? 'keep' });
  const personal = newWorkspace({ name: 'Personal', pins: [pin('https://news.example/')], collapseGroups: false });
  const store = new MemoryStore([work, personal], { lazyRestore: false });
  store.state.activeWorkspaceId = work.id;
  let t = 5_000_000;
  const engine = new Engine(fb, store, { now: () => (t += 1000) });
  return { fb, store, engine, work, personal };
}

describe('engine', () => {
  it('switches back and forth without losing anything', async () => {
    const { fb, engine, store, personal, work } = setup([
      { url: GMAIL, pinned: true },
      { url: JIRA, pinned: true },
      { url: 'https://pr.example/1', group: 'Review' },
      { url: 'https://pr.example/2', group: 'Review' },
      { url: 'https://doc.example/', active: true },
    ]);
    const before = fb.strip();
    await engine.switchTo(personal.id);
    fb.assertInvariants();
    expect(fb.strip()).toEqual(['📌https://news.example/', 'chrome://newtab/ *']);
    expect(store.state.activeWorkspaceId).toBe(personal.id);

    // do some personal browsing, then go back
    await fb.createTab({ windowId: fb.focused!, url: 'https://recipe.example/', active: true });
    await engine.switchTo(work.id);
    fb.assertInvariants();
    expect(fb.strip()).toEqual(before);

    await engine.switchTo(personal.id);
    expect(fb.strip()).toEqual(['📌https://news.example/', 'https://recipe.example/ *']);
  });

  it('undo reverts an apply, including other windows it archived', async () => {
    const { fb, engine, store } = setup(
      [{ url: 'https://a.example/' }, { url: 'https://b.example/', active: true }],
      { otherWindows: 'archive' },
    );
    fb.addWindow([{ url: 'https://other.example/', active: true }]);
    fb.focused = [...fb.windows.keys()][0];
    const before = fb.strip();
    await engine.apply();
    expect(fb.windows.size).toBe(1);
    expect(store.archive.map((a) => a.url).sort()).toEqual(['https://a.example/', 'https://b.example/', 'https://other.example/']);

    const r = await engine.undo();
    fb.assertInvariants();
    expect(r.errors).toEqual([]);
    expect(fb.strip()).toEqual(before);
    expect(fb.windows.size).toBe(2);
    expect((await engine.undo()).message).toBe('nothing');
  });

  it('merges other windows, keeping their groups', async () => {
    const { fb, engine } = setup([{ url: 'https://main.example/', active: true }]);
    fb.addWindow([{ url: 'https://x.example/', group: 'X' }, { url: 'https://y.example/', pinned: true }, { url: 'chrome://newtab/', active: true }]);
    fb.focused = [...fb.windows.keys()][0];
    await engine.mergeWindows();
    fb.assertInvariants();
    expect(fb.windows.size).toBe(1);
    expect(fb.strip()).toEqual(['https://main.example/ *', '[X]https://x.example/', 'https://y.example/']);
  });

  it('serialises concurrent requests', async () => {
    const { fb, engine } = setup([{ url: 'https://a.example/', active: true }]);
    await Promise.all([engine.apply(), engine.apply(), engine.apply()]);
    fb.assertInvariants();
    expect(fb.strip()).toEqual([`📌${GMAIL}`, `📌${JIRA}`, 'chrome://newtab/ *']);
  });

  it('archives idle tabs but never pinned, active or the last tab', async () => {
    const { fb, engine, store } = setup([
      { url: GMAIL, pinned: true, lastAccessed: 0 },
      { url: 'https://old.example/', lastAccessed: 0 },
      { url: 'https://grouped-old.example/', group: 'G', lastAccessed: 0 },
      { url: 'https://fresh.example/', lastAccessed: 10_000_000 },
      { url: 'https://active-old.example/', active: true, lastAccessed: 0 },
    ]);
    store.settings.idleArchiveMinutes = 60;
    expect(await engine.idleSweep()).toBe(1);
    expect(store.archive.map((a) => [a.url, a.reason])).toEqual([['https://old.example/', 'idle']]);
  });

  it('moves a tab into another workspace’s session', async () => {
    const { fb, engine, personal } = setup([{ url: 'https://keep.example/' }, { url: 'https://later.example/', active: true }]);
    const id = (await fb.getWindow(fb.focused!)).tabs[1]!.id;
    await engine.moveTabToWorkspace(id, personal.id);
    expect(fb.strip()).toEqual(['https://keep.example/ *']);
    await engine.switchTo(personal.id);
    expect(fb.strip()).toContain('https://later.example/');
  });

  it('fires schedules once per occurrence', async () => {
    const { engine, store, personal } = setup([{ url: 'https://a.example/', active: true }]);
    store.settings.schedules = [{ id: 's1', enabled: true, workspaceId: personal.id, days: [1], time: '18:00' }];
    const monday1801 = new Date(2026, 10, 16, 18, 1);
    expect(await engine.runSchedules(monday1801)).toEqual([personal.id]);
    expect(await engine.runSchedules(new Date(2026, 10, 16, 18, 2))).toEqual([]);
    expect(store.state.activeWorkspaceId).toBe(personal.id);
  });

  it('creates a workspace from the current window', async () => {
    const { fb, engine, store } = setup([{ url: 'https://p.example/', pinned: true }, { url: 'https://s.example/', group: 'S', active: true }]);
    const ws = await engine.newWorkspaceFromWindow('Captured');
    expect(ws.pins.map((p) => p.url)).toEqual(['https://p.example/']);
    expect(store.sessions.get(ws.id)!.tabs.map((t) => t.url)).toEqual(['https://s.example/']);
    expect(fb.strip()).toHaveLength(2);
  });
});

describe('rules, migration, import', () => {
  it('evaluates rules scoped to workspaces', () => {
    const rules = [
      { id: 'a', enabled: true, kind: 'domain' as const, pattern: 'youtube.com', action: { type: 'block' as const }, workspaceIds: ['focus'] },
      { id: 'b', enabled: true, kind: 'glob' as const, pattern: '*://github.com/*/pull/*', action: { type: 'group' as const, title: 'PRs', color: 'green' as const }, workspaceIds: [] },
    ];
    expect(evaluateRules(rules, 'focus', 'https://www.youtube.com/')?.rule.id).toBe('a');
    expect(evaluateRules(rules, 'work', 'https://www.youtube.com/')).toBeUndefined();
    expect(evaluateRules(rules, 'work', 'https://github.com/acme/pull/3')?.action).toMatchObject({ title: 'PRs' });
    expect(evaluateRules(rules, 'work', 'chrome://settings')).toBeUndefined();
  });

  it('migrates v1 pinned URLs', () => {
    const ws = migrateV1(['https://a.example/', '', 42, 'https://b.example/']);
    expect(ws.pins.map((p) => p.url)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(migrateV1(undefined).pins).toHaveLength(3);
  });

  it('sanitises hostile imports', () => {
    expect(() => parseImport('{"format":"nope"}')).toThrow();
    const { workspaces, settings } = parseImport(
      JSON.stringify({
        format: 'pin-workflow-initializer',
        workspaces: [{ name: 'X', color: 'chartreuse', pins: [{ url: 'https://a/' }, { nope: 1 }], ungrouped: 'explode' }],
        settings: { snapshotLimit: -5, ai: { provider: 'evil' }, schedules: [{ days: [1, 9], time: 'soon' }] },
      }),
    );
    expect(workspaces[0]).toMatchObject({ name: 'X', color: 'blue', ungrouped: 'archive' });
    expect(workspaces[0]!.pins).toHaveLength(1);
    expect(settings.snapshotLimit).toBe(5);
    expect(settings.ai.provider).toBe('off');
    expect(settings.schedules[0]).toMatchObject({ days: [1], time: '09:00' });
    expect(sanitizeWorkspace(null).name).toBe('Workspace');
    expect(sanitizeSettings(undefined).version).toBe(2);
  });
});
