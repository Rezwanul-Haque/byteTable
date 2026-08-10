// React binding for the i18n runtime: subscribe a component to locale changes.
//
// `t` itself is a plain module function, so a component that calls it directly
// would keep its stale text until something else re-rendered it. Reading the
// locale version through useSyncExternalStore is what makes a language switch
// repaint the tree in place — no remount, so open tabs, grid scroll positions
// and terminal sessions all survive it.

import { useSyncExternalStore } from "react";

import { getLocale, getLocaleVersion, subscribe, t, type LocaleId } from ".";

/** The translate function, re-rendering this component when the locale changes. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLocaleVersion, getLocaleVersion);
  return t;
}

/** The active locale id, re-rendering this component when it changes. */
export function useLocale(): LocaleId {
  useSyncExternalStore(subscribe, getLocaleVersion, getLocaleVersion);
  return getLocale();
}
