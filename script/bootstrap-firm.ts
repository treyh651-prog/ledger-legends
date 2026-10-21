/**
 * Bootstrap the first firm and its owner.
 *
 * Invitations need a signed in firm owner to issue them, and there is no
 * owner before the first one. This script is the way in. It runs where the
 * environment carries DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * and APP_ORIGIN, creates the auth user through the admin API (which sends
 * the invitation email), and writes the firm, the user row and an owner
 * membership. Idempotent: run it twice and the second run finds everything
 * and says so.
 *
 *   npx tsx script/bootstrap-firm.ts --firm "Ledger Legends" --slug ledger-legends \
 *       --email owner@example.com --name "Owner Name"
 *
 * The owner membership has granted_by set to the owner's own user id. Doc 05
 * asks that every membership record who granted it, and for the first
 * membership in a firm the only honest answer is the person themselves.
 *
 * Reads environment values, never prints them.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { closePool, getPool } from "../server/db/pool";
import { createSupabaseAuthAdmin, readAuthAdminEnv } from "../server/auth/auth-admin";
import { readAppOrigin } from "../server/auth/setup";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      firm: { type: "string" },
      slug: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
    },
  });
  const firmName = values.firm?.trim();
  const slug = values.slug?.trim().toLowerCase();
  const email = values.email?.trim().toLowerCase();
  const displayName = values.name?.trim() || null;
  if (!firmName || !slug || !email) {
    throw new Error("usage: --firm <name> --slug <slug> --email <owner email> [--name <display name>]");
  }
  if (!SLUG.test(slug)) throw new Error("slug must be lowercase letters, digits and hyphens");
  if (!EMAIL.test(email)) throw new Error("email does not look like an address");

  const adminEnv = readAuthAdminEnv();
  if (!adminEnv) throw new Error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const appOrigin = readAppOrigin();
  if (!appOrigin) throw new Error("set APP_ORIGIN to where the browser loads the app");

  const admin = createSupabaseAuthAdmin(adminEnv);
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Firm
    const firmRows = await client.query<{ id: string; name: string }>(`select id, name from tenancy.firms where slug = $1`, [slug]);
    let firmId: string;
    if (firmRows.rows[0]) {
      firmId = firmRows.rows[0].id;
      console.log(`firm ${slug} exists (${firmRows.rows[0].name}), reusing`);
    } else {
      const ins = await client.query<{ id: string }>(`insert into tenancy.firms (name, slug) values ($1, $2) returning id`, [firmName, slug]);
      firmId = ins.rows[0].id;
      console.log(`firm ${slug} created`);
    }

    // User. Look in tenancy first so an existing owner is not re-invited.
    const userRows = await client.query<{ id: string; auth_subject: string; disabled_at: string | null }>(
      `select id, auth_subject, disabled_at from tenancy.users where lower(email) = $1`,
      [email],
    );
    let userId: string;
    if (userRows.rows[0]) {
      if (userRows.rows[0].disabled_at) throw new Error(`the user for ${email} is disabled; re-enable it before bootstrapping`);
      userId = userRows.rows[0].id;
      console.log(`user ${email} exists in tenancy, reusing`);
    } else {
      const invited = await admin.inviteByEmail(email, { redirectTo: `${appOrigin}/auth/callback`, displayName });
      console.log(invited.existed ? `${email} already had a login; no email sent, they can use a magic link` : `invitation email sent to ${email}`);
      const ins = await client.query<{ id: string }>(
        `insert into tenancy.users (auth_subject, email, display_name)
         values ($1, $2, $3)
         on conflict (auth_subject) do update set email = excluded.email
         returning id`,
        [invited.authSubject, email, displayName],
      );
      userId = ins.rows[0].id;
      console.log(`tenancy user created`);
    }

    // Owner membership
    const mem = await client.query<{ id: string }>(
      `select id from tenancy.memberships
        where user_id = $1 and firm_id = $2 and scope = 'firm' and role = 'owner' and revoked_at is null`,
      [userId, firmId],
    );
    if (mem.rows[0]) {
      console.log(`owner membership exists, nothing to do`);
    } else {
      await client.query(
        `insert into tenancy.memberships (user_id, firm_id, client_id, scope, role, granted_by)
         values ($1, $2, null, 'firm', 'owner', $1)`,
        [userId, firmId],
      );
      console.log(`owner membership created`);
    }
    console.log(`done. firm_id=${firmId} user_id=${userId}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
