/**
 * Browser side of sign in.
 *
 * The browser talks to Supabase Auth directly for the credential exchange
 * (password, magic link, invitation and recovery links) and to this
 * application's server for everything else, carrying the access token as a
 * bearer header. The server never sees a password.
 *
 * Boot sequence:
 *   1. GET /api/auth/config. Says whether sign in is on and, if so, which
 *      project to talk to. Public values only.
 *   2. If the URL hash carries a Supabase token (an invitation or recovery
 *      link lands here), remember the link type before the Supabase client
 *      consumes it, because the hash is also this app's router.
 *   3. Create the Supabase client, subscribe to auth state, and when there
 *      is a session ask the server who this is (GET /api/auth/me).
 *
 * The result is one of a handful of states the rest of the app switches on.
 * "off" means the server runs without sign in (a developer machine on the
 * memory port); the app then renders as it always has.
 */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { API_BASE } from "@/lib/queryClient";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setAuthHeaderProvider } from "./queryClient";

export type MembershipScope = "firm" | "client";
export type MembershipRole = "owner" | "manager" | "preparer" | "reviewer" | "client_user" | "read_only";

export interface Membership {
  firmId: string;
  firmSlug: string;
  firmName: string;
  clientId: string | null;
  scope: MembershipScope;
  role: MembershipRole;
}

export interface Me {
  userId: string;
  email: string;
  displayName: string | null;
  memberships: Membership[];
}

export type LinkType = "invite" | "recovery" | "magiclink" | "signup" | null;

export type AuthStatus =
  | "loading"
  /** Server runs without sign in. */
  | "off"
  | "signed-out"
  /** Supabase session exists, server is being asked who this is. */
  | "resolving"
  | "signed-in"
  /** Valid login, but the server does not know this person. */
  | "no-membership"
  /** Login refused by the server: disabled, or the server is unreachable. */
  | "refused";

export interface AuthApi {
  status: AuthStatus;
  session: Session | null;
  me: Me | null;
  /** Why the state is refused or no-membership, for the screen to show. */
  reason: string | null;
  /** The invitation or recovery link that brought the browser here, if any. */
  linkType: LinkType;
  clearLinkType: () => void;
  /** Firm the actor is working in. Chosen among memberships, sent as X-Firm. */
  firm: Membership | null;
  setFirm: (firmId: string) => void;
  canUseFirmPlane: boolean;
  canUsePortalPlane: boolean;
  canManageAccess: boolean;
  signInWithPassword: (email: string, password: string) => Promise<string | null>;
  signInWithMagicLink: (email: string) => Promise<string | null>;
  requestPasswordReset: (email: string) => Promise<string | null>;
  updatePassword: (password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Fresh access token, refreshing if the current one is about to expire. */
  accessToken: () => Promise<string | null>;
  /** fetch with Authorization and X-Firm attached. */
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthApi | null>(null);

interface ConfigResponse {
  configured: boolean;
  supabaseUrl?: string;
  anonKey?: string;
  reason?: string;
  /** Memory port outside production: the server answers as one firm owner. */
  developmentActor?: boolean;
}

/** Read and clear the Supabase link type from the hash before the router sees it. */
function captureLinkType(): LinkType {
  const h = window.location.hash;
  if (!h.includes("access_token=") && !h.includes("error=")) return null;
  const params = new URLSearchParams(h.replace(/^#\/?/, ""));
  const t = params.get("type");
  if (t === "invite" || t === "recovery" || t === "magiclink" || t === "signup") return t;
  return params.get("error") ? null : "magiclink";
}

/**
 * Default firm for a user: the first firm membership the server listed. The
 * choice lives in memory only (this client keeps no web storage), so a user
 * in several firms picks again after a reload. Rare enough to be fine.
 */
function pickFirm(me: Me | null, current: Membership | null): Membership | null {
  if (!me) return null;
  const firms = me.memberships.filter((m) => m.scope === "firm");
  if (firms.length === 0) return null;
  return firms.find((f) => f.firmId === current?.firmId) ?? firms[0];
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<LinkType>(null);
  const [firm, setFirmState] = useState<Membership | null>(null);
  const clientRef = useRef<SupabaseClient | null>(null);

  const resolveMe = useCallback(async (s: Session) => {
    setStatus("resolving");
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { authorization: `Bearer ${s.access_token}` },
      });
      if (res.ok) {
        const body = (await res.json()) as Me;
        setMe(body);
        setFirmState((cur) => pickFirm(body, cur));
        setReason(null);
        setStatus("signed-in");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = body?.error?.code ?? "";
      setMe(null);
      setFirmState(null);
      setReason(body?.error?.message ?? `The server answered ${res.status}.`);
      setStatus(code === "auth.no_user" ? "no-membership" : "refused");
    } catch {
      setMe(null);
      setFirmState(null);
      setReason("The server could not be reached.");
      setStatus("refused");
    }
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      let cfg: ConfigResponse;
      try {
        const res = await fetch(`${API_BASE}/api/auth/config`);
        cfg = (await res.json()) as ConfigResponse;
      } catch {
        if (!cancelled) {
          setReason("The server could not be reached.");
          setStatus("refused");
        }
        return;
      }
      if (cancelled) return;
      if (!cfg.configured || !cfg.supabaseUrl || !cfg.anonKey) {
        if (cfg.developmentActor) {
          // The server supplies the actor (NOTES 221). Ask who that is so the
          // firm header and the memberships are real, then stay in "off".
          try {
            const meRes = await fetch(`${API_BASE}/api/auth/me`);
            if (meRes.ok && !cancelled) {
              const body = (await meRes.json()) as Me;
              setMe(body);
              setFirmState((cur) => pickFirm(body, cur));
            }
          } catch {
            // The screens show the API's own message when a read fails.
          }
        }
        if (!cancelled) setStatus("off");
        return;
      }
      const captured = captureLinkType();
      if (captured) setLinkType(captured);
      const client = createClient(cfg.supabaseUrl, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      clientRef.current = client;
      const { data } = client.auth.onAuthStateChange((_event, s) => {
        setSession(s);
        if (s) void resolveMe(s);
        else {
          setMe(null);
          setFirmState(null);
          setStatus("signed-out");
        }
      });
      unsub = () => data.subscription.unsubscribe();
      const initial = await client.auth.getSession();
      if (cancelled) return;
      if (captured) {
        // The Supabase client has read the tokens out of the hash. Hand the
        // hash back to the router, which otherwise sees a path of tokens.
        window.location.hash = "#/";
      }
      if (initial.data.session) {
        setSession(initial.data.session);
        void resolveMe(initial.data.session);
      } else if (!captured) {
        setStatus("signed-out");
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [resolveMe]);

  const setFirm = useCallback(
    (firmId: string) => {
      const m = me?.memberships.find((x) => x.scope === "firm" && x.firmId === firmId) ?? null;
      if (m) setFirmState(m);
    },
    [me],
  );

  const accessToken = useCallback(async (): Promise<string | null> => {
    const client = clientRef.current;
    if (!client) return null;
    const { data } = await client.auth.getSession();
    const s = data.session;
    if (!s) return null;
    const expiresAt = (s.expires_at ?? 0) * 1000;
    if (expiresAt && expiresAt - Date.now() < 30_000) {
      const r = await client.auth.refreshSession();
      return r.data.session?.access_token ?? null;
    }
    return s.access_token;
  }, []);

  useEffect(() => {
    setAuthHeaderProvider(async () => {
      const token = await accessToken();
      const h: Record<string, string> = {};
      if (token) h.authorization = `Bearer ${token}`;
      if (firm) h["x-firm"] = firm.firmId;
      return h;
    });
  }, [accessToken, firm]);

  const authFetch = useCallback(
    async (input: string, init: RequestInit = {}) => {
      const token = await accessToken();
      const headers = new Headers(init.headers ?? {});
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (firm) headers.set("x-firm", firm.firmId);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return fetch(input.startsWith("/") ? `${API_BASE}${input}` : input, { ...init, headers });
    },
    [accessToken, firm],
  );

  const errText = (e: { message: string } | null): string | null => (e ? e.message : null);

  const api = useMemo<AuthApi>(() => {
    const firmCount = me?.memberships.filter((m) => m.scope === "firm").length ?? 0;
    const clientCount = me?.memberships.filter((m) => m.scope === "client").length ?? 0;
    return {
      status,
      session,
      me,
      reason,
      linkType,
      clearLinkType: () => setLinkType(null),
      firm,
      setFirm,
      canUseFirmPlane: status === "off" || firmCount > 0,
      canUsePortalPlane: status === "off" || firmCount > 0 || clientCount > 0,
      canManageAccess: status === "off" || (firm !== null && (firm.role === "owner" || firm.role === "manager")),
      async signInWithPassword(email, password) {
        const c = clientRef.current;
        if (!c) return "Sign in is not available.";
        const { error } = await c.auth.signInWithPassword({ email, password });
        return errText(error);
      },
      async signInWithMagicLink(email) {
        const c = clientRef.current;
        if (!c) return "Sign in is not available.";
        const { error } = await c.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        return errText(error);
      },
      async requestPasswordReset(email) {
        const c = clientRef.current;
        if (!c) return "Sign in is not available.";
        const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback` });
        return errText(error);
      },
      async updatePassword(password) {
        const c = clientRef.current;
        if (!c) return "Sign in is not available.";
        const { error } = await c.auth.updateUser({ password });
        return errText(error);
      },
      async signOut() {
        const c = clientRef.current;
        if (c) await c.auth.signOut();
        setMe(null);
        setFirmState(null);
        setStatus("signed-out");
      },
      accessToken,
      authFetch,
    };
  }, [status, session, me, reason, linkType, firm, setFirm, accessToken, authFetch]);

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
