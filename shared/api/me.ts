/**
 * Who is signed in. Mirrors the auth brief's /api/auth/me response so the
 * client has one typed source for it.
 */

import { z } from "zod";
import { idSchema } from "./common";

export const membershipSchema = z.object({
  firmId: idSchema,
  firmSlug: z.string(),
  firmName: z.string(),
  clientId: idSchema.nullable(),
  scope: z.enum(["firm", "client"]),
  role: z.enum(["owner", "manager", "preparer", "reviewer", "client_user", "read_only"]),
});

export const meSchema = z.object({
  userId: idSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  memberships: z.array(membershipSchema),
  /** True when the server supplied the development actor instead of a login. */
  development: z.boolean().optional(),
});
export type Me = z.infer<typeof meSchema>;
