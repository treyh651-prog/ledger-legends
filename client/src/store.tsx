/**
 * Interface state only. Every figure on every screen comes from the API; this
 * store holds the four things the shell needs that are not records: which
 * client is selected, which period the header shows, which plane the person
 * is on, and the theme. Nothing here is persisted and nothing here is data.
 *
 * The selected client is validated by useActiveClient against the API's
 * client list, so a stale id does nothing more than fall back to the first
 * client the firm has.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Plane = "firm" | "portal";
export type Theme = "light" | "dark";

export interface AppApi {
  activeClientId: string;
  period: string;
  plane: Plane;
  theme: Theme;
  setActiveClient: (id: string) => void;
  setPeriod: (p: string) => void;
  setPlane: (p: Plane) => void;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<AppApi | null>(null);

/** The month today falls in, as YYYY-MM. The header's default period. */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeClientId, setActiveClient] = useState("");
  const [period, setPeriod] = useState(currentPeriod);
  const [plane, setPlane] = useState<Plane>("firm");
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const api = useMemo<AppApi>(
    () => ({ activeClientId, period, plane, theme, setActiveClient, setPeriod, setPlane, setTheme }),
    [activeClientId, period, plane, theme],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useApp(): AppApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within AppProvider");
  return v;
}
