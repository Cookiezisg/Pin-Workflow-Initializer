/**
 * UI strings are written in English inline (`t('Apply')`); zh.ts maps them to Chinese.
 * tests/i18n.test.ts fails if any t('…') string in src/ lacks a translation.
 */
import { zh } from './zh';

let lang: 'en' | 'zh' = detect();

function detect(): 'en' | 'zh' {
  const l = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return l.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLocale(pref: 'auto' | 'en' | 'zh'): void {
  lang = pref === 'auto' ? detect() : pref;
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function currentLocale(): 'en' | 'zh' {
  return lang;
}

export function t(text: string, ...args: (string | number)[]): string {
  const s = lang === 'zh' ? (zh[text] ?? text) : text;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? '')) : s;
}
