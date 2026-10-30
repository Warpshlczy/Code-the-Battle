import { useSyncExternalStore } from 'react';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'code-the-battle.lang';

function readInitial(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* localStorage can be unavailable in private modes. */
  }
  return 'en';
}

let current: Lang = typeof window === 'undefined' ? 'en' : readInitial();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Keep the document language in sync for screen readers and browser translation. */
function applyDocumentLang(lang: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

applyDocumentLang(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  applyDocumentLang(lang);
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* The switch still works without persistence. */
  }
  for (const fn of listeners) fn();
}

export function toggleLang(): void {
  setLang(current === 'en' ? 'zh' : 'en');
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export type Translate = (zh: string, en: string) => string;

/** Returns a render-time translator; calling it subscribes the component to language changes. */
export function useT(): Translate {
  const lang = useLang();
  return (zh, en) => (lang === 'zh' ? zh : en);
}

export function pick(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en;
}
