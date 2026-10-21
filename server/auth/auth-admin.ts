/**
 * The small slice of the Supabase Auth admin API the server uses.
 *
 * Kept behind an interface so the invitation logic can be tested with a
 * scripted implementation, and so the service role client is constructed in
 * exactly one place. The service role key never leaves this process and is
 * never logged. @supabase/auth-js is the package supabase-js itself uses for
 * auth; it is declared as a direct dependency so the import does not depend
 * on supabase-js's internal layout.
 */

import { AuthAdminApi } from "@supabase/auth-js";

export interface AuthAdmin {
  /**
   * Create an auth user and send the invitation email. Returns the auth user
   * id. When the email already has an auth user, returns that user's id with
   * `existed: true` and sends nothing: they sign in with a magic link from
   * the login page instead.
   */
  inviteByEmail(email: string, opts: { redirectTo: string; displayName: string | null }): Promise<{ authSubject: string; existed: boolean }>;
  /** Stop the user from refreshing or signing in again. */
  ban(authSubject: string): Promise<void>;
}

export class AuthAdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthAdminError";
  }
}

export function readAuthAdminEnv(env: NodeJS.ProcessEnv = process.env): { supabaseUrl: string; serviceRoleKey: string } | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { supabaseUrl: url, serviceRoleKey: key };
}

export function createSupabaseAuthAdmin(cfg: { supabaseUrl: string; serviceRoleKey: string }): AuthAdmin {
  // The admin API alone, not the whole supabase-js client. The full client
  // constructs a Realtime client on startup, which on Node 20 throws for the
  // missing WebSocket global; this server has no use for Realtime, PostgREST
  // or Storage, so it does not pay for them.
  const admin = new AuthAdminApi({
    url: `${cfg.supabaseUrl}/auth/v1`,
    headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` },
  });

  return {
    async inviteByEmail(email, opts) {
      const invited = await admin.inviteUserByEmail(email, {
        redirectTo: opts.redirectTo,
        data: opts.displayName ? { display_name: opts.displayName } : undefined,
      });
      if (!invited.error) {
        if (!invited.data.user?.id) throw new AuthAdminError("no_user", "invite returned no user");
        return { authSubject: invited.data.user.id, existed: false };
      }
      const code = invited.error.code ?? "";
      if (code !== "email_exists" && code !== "user_already_exists" && invited.error.status !== 422) {
        throw new AuthAdminError(code || "invite_failed", invited.error.message);
      }
      // Already a login. generateLink is the only admin call that returns a
      // user by email without paging through every user. The link it makes
      // is discarded; nothing is sent.
      const found = await admin.generateLink({ type: "magiclink", email });
      if (found.error || !found.data.user?.id) {
        throw new AuthAdminError(found.error?.code ?? "lookup_failed", found.error?.message ?? "could not find the existing login");
      }
      return { authSubject: found.data.user.id, existed: true };
    },

    async ban(authSubject) {
      // GoTrue takes a Go duration. 100 years is as good as forever and
      // avoids a special case for "none".
      const res = await admin.updateUserById(authSubject, { ban_duration: "876600h" });
      if (res.error) throw new AuthAdminError(res.error.code ?? "ban_failed", res.error.message);
    },
  };
}
