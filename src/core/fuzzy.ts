/** Small fzf-flavoured matcher: space-separated terms must all match; substrings beat scattered hits. */
export interface FuzzyHit {
  score: number;
  /** Matched character positions, for highlighting. */
  indices: number[];
}

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  return /[^a-z0-9]/i.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
};

function matchTerm(term: string, text: string, lower: string): FuzzyHit | null {
  // 1. contiguous substring: pick the occurrence with the best boundary bonus
  let best: FuzzyHit | null = null;
  for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
    const score = 100 + term.length * 4 + (at === 0 ? 40 : isBoundary(text, at) ? 25 : 0) - Math.min(at, 30) * 0.5;
    if (!best || score > best.score) best = { score, indices: Array.from({ length: term.length }, (_, k) => at + k) };
  }
  if (best) return best;
  // 2. ordered subsequence, preferring boundary characters
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of term) {
    let pos = -1;
    for (let i = from; i < lower.length; i++) {
      if (lower[i] !== ch) continue;
      if (pos === -1) pos = i;
      if (isBoundary(text, i)) {
        pos = i;
        break;
      }
      if (indices.length && i === indices[indices.length - 1]! + 1) break;
    }
    if (pos === -1) return null;
    const prev = indices[indices.length - 1];
    score += 2 + (prev !== undefined && pos === prev + 1 ? 6 : 0) + (isBoundary(text, pos) ? 8 : 0);
    if (prev !== undefined) score -= Math.min(pos - prev - 1, 10) * 0.6;
    indices.push(pos);
    from = pos + 1;
  }
  return { score, indices };
}

export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    const hit = matchTerm(term, text, lower);
    if (!hit) return null;
    score += hit.score;
    hit.indices.forEach((i) => indices.add(i));
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

export interface Ranked<T> {
  item: T;
  score: number;
  /** Highlight positions per field name. */
  hits: Record<string, number[]>;
}

/**
 * Rank items by their best-matching field. Every term has to match somewhere in the item, but terms
 * may be spread over fields ("gh pulls" can match "GitHub" in the title and "/pulls" in the URL).
 */
export function rank<T>(items: T[], query: string, fields: { name: string; get: (t: T) => string; weight?: number }[]): Ranked<T>[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items.map((item) => ({ item, score: 0, hits: {} }));
  const out: Ranked<T>[] = [];
  for (const item of items) {
    let total = 0;
    const hits: Record<string, number[]> = {};
    let ok = true;
    for (const term of terms) {
      let bestScore = -Infinity;
      let bestField = '';
      let bestIdx: number[] = [];
      for (const f of fields) {
        const text = f.get(item);
        const h = matchTerm(term, text, text.toLowerCase());
        if (!h) continue;
        const s = h.score * (f.weight ?? 1);
        if (s > bestScore) {
          bestScore = s;
          bestField = f.name;
          bestIdx = h.indices;
        }
      }
      if (bestScore === -Infinity) {
        ok = false;
        break;
      }
      total += bestScore;
      hits[bestField] = [...(hits[bestField] ?? []), ...bestIdx].sort((a, b) => a - b);
    }
    if (ok) out.push({ item, score: total, hits });
  }
  return out.sort((a, b) => b.score - a.score);
}
