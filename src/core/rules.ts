import { ruleMatcher, type Matcher } from './match';
import type { Rule, RuleAction } from './types';

const cache = new Map<string, Matcher | null>();

function matcherFor(rule: Rule): Matcher | null {
  const key = `${rule.kind}\u0000${rule.pattern}`;
  if (!cache.has(key)) {
    if (cache.size > 500) cache.clear();
    cache.set(key, ruleMatcher(rule.kind, rule.pattern));
  }
  return cache.get(key)!;
}

export function ruleApplies(rule: Rule, workspaceId: string | undefined): boolean {
  return rule.enabled && (rule.workspaceIds.length === 0 || (!!workspaceId && rule.workspaceIds.includes(workspaceId)));
}

/** First matching rule wins. */
export function evaluateRules(rules: Rule[], workspaceId: string | undefined, url: string): { rule: Rule; action: RuleAction } | undefined {
  if (!/^https?:/i.test(url)) return undefined;
  for (const rule of rules) {
    if (!ruleApplies(rule, workspaceId)) continue;
    if (matcherFor(rule)?.(url)) return { rule, action: rule.action };
  }
  return undefined;
}

export function isValidRule(rule: Pick<Rule, 'kind' | 'pattern'>): boolean {
  return ruleMatcher(rule.kind, rule.pattern) !== null;
}
