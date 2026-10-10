// React binding for the i18n runtime: subscribe a component to locale changes.
//
// `t` itself is a plain module function, so a component that calls it directly
// would keep its stale text until something else re-rendered it. Reading the
// locale version through useSyncExternalStore is what makes a language switch
// repaint the tree in place — no remount, so open tabs, grid scroll positions
// and terminal sessions all survive it.

import { useSyncExternalStore } from "react";

import { getLocale, getLocaleVersion, subscribe, t, type LocaleId } from ".";

/**
 * One translate identity per locale, shared by every component.
 *
 * Module-level rather than a `useMemo`: the cache key is the locale version,
 * which the callback never reads, and a dependency array cannot say that. This
 * also means all components hold the SAME function for a given locale, so a
 * child memoised on `t` is not invalidated by its parent re-rendering.
 */
let translator: { version: number; fn: typeof t } = { version: -1, fn: t };
function translatorFor(version: number): typeof t {
  if (translator.version !== version) {
    translator = { version, fn: (key, vars) => t(key, vars) };
  }
  return translator.fn;
}

/**
 * The translate function, re-rendering this component when the locale changes.
 *
 * A NEW identity per locale, deliberately. Returning the module function itself
 * re-renders the component but leaves `t` unusable as a hook dependency: a
 * `useMemo`/`useCallback` that builds translated strings would keep serving the
 * previous language's cache, because its one relevant input never changed. With
 * the identity keyed to the locale, listing `t` says exactly what it looks like
 * it says — and between switches it is stable, so it adds no churn.
 */
export function useT(): typeof t {
  return translatorFor(useSyncExternalStore(subscribe, getLocaleVersion, getLocaleVersion));
}

/** The active locale id, re-rendering this component when it changes. */
export function useLocale(): LocaleId {
  useSyncExternalStore(subscribe, getLocaleVersion, getLocaleVersion);
  return getLocale();
}
