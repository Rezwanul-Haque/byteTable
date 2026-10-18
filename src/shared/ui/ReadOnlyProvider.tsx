// Provider for the read-only-workspace flag. Mounted once in `App.tsx` around
// the active workspace shell; see readOnlyContext.ts for why this is a context.

import type { ReactNode } from "react";

import { ReadOnlyContext } from "./readOnlyContext";

export function ReadOnlyProvider({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}) {
  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}
