import { useEffect } from "react";

import { Gallery } from "./dev/Gallery";
import { ToastProvider } from "./shared/ui/ToastProvider";
import { usePreferencesStore } from "./slices/preferences/state";

export function App() {
  const load = usePreferencesStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ToastProvider>
      <Gallery />
    </ToastProvider>
  );
}
