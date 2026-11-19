import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zh } from '../src/lib/zh';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

describe('i18n', () => {
  it('has a Chinese translation for every literal t() string', () => {
    const missing = new Set<string>();
    for (const f of files('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        const key = m[1]!.replace(/\\'/g, "'");
        if (!(key in zh)) missing.add(`${key}  (${f})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
  it('keeps placeholders intact', () => {
    for (const [en, cn] of Object.entries(zh)) {
      const ph = (s: string) => (s.match(/\{\d\}/g) ?? []).sort().join();
      expect(ph(cn), en).toBe(ph(en));
    }
  });
});
