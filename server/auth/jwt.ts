/**
 * Supabase access token verification.
 *
 * The browser signs in with Supabase Auth and sends the access token as a
 * bearer header. The server verifies it here before anything else looks at
 * the request. Two verification paths:
 *
 * Asymmetric (the default for Supabase projects with JWT signing keys): the
 * token header names an ES256 or RS256 key id, and the project publishes the
 * public keys at /auth/v1/.well-known/jwks.json. jose fetches and caches that
 * set, so verification is local and the auth server is not on the request
 * path. Key rotation is handled by jose refetching when it sees an unknown
 * kid, bounded by a cooldown.
 *
 * Symmetric (legacy projects still on the HS256 shared secret): the server
 * does not hold the secret, so it asks Supabase Auth to validate the token
 * through the /auth/v1/user endpoint. This puts a network call on every
 * uncached request, which is why the asymmetric path is preferred. The
 * symmetric path is chosen by looking at the token header's alg, not by
 * configuration, so a project that migrates to signing keys needs no change
 * here.
 *
 * Either way the result is the same shape: the subject, the email, and the
 * expiry. Nothing else from the token is trusted. The actor middleware looks
 * the subject up in tenancy.users to decide who this is.
 */

import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";

export interface VerifiedToken {
  subject: string;
  email: string | null;
  expiresAt: Date | null;
  /** How the token was checked. Useful in logs, never shown to the browser. */
  via: "jwks" | "auth-server";
}

export class TokenError extends Error {
  constructor(
    readonly reason: "missing" | "malformed" | "expired" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

export interface TokenVerifierConfig {
  /** Project URL, for example https://abc.supabase.co. No trailing slash. */
  supabaseUrl: string;
  /** Anon key, used only as the apikey header on the legacy auth server path. */
  anonKey: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

interface AuthUserResponse {
  id?: string;
  email?: string | null;
}

export function readSupabaseEnv(env: NodeJS.ProcessEnv = process.env): { supabaseUrl: string; anonKey: string } | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const anon = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anon) return null;
  return { supabaseUrl: url, anonKey: anon };
}

export function createTokenVerifier(config: TokenVerifierConfig): TokenVerifier {
  const issuer = `${config.supabaseUrl}/auth/v1`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    [customFetch]: (url, init) => fetchImpl(url, init as RequestInit),
  });

  async function viaJwks(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated" }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenError("expired", "access token has expired");
      if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new TokenError("invalid", "access token signature did not verify");
      }
      if (err instanceof joseErrors.JOSEError) throw new TokenError("invalid", `access token rejected: ${err.code}`);
      throw new TokenError("unavailable", "could not reach the signing key set");
    }
    if (typeof payload.sub !== "string" || !payload.sub) throw new TokenError("invalid", "access token has no subject");
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null,
      via: "jwks",
    };
  }

  async function viaAuthServer(token: string): Promise<VerifiedToken> {
    let res: Response;
    try {
      res = await fetchImpl(`${issuer}/user`, {
        headers: { apikey: config.anonKey, authorization: `Bearer ${token}` },
      });
    } catch {
      throw new TokenError("unavailable", "could not reach the auth server");
    }
    if (res.status === 401 || res.status === 403) {
      throw new TokenError("invalid", "auth server rejected the access token");
    }
    if (!res.ok) throw new TokenError("unavailable", `auth server returned ${res.status}`);
    const body = (await res.json()) as AuthUserResponse;
    if (!body.id) throw new TokenError("invalid", "auth server returned no user");
    // The expiry is still in the token; read it without trusting anything else.
    let exp: number | undefined;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as JWTPayload;
      exp = typeof claims.exp === "number" ? claims.exp : undefined;
    } catch {
      exp = undefined;
    }
    return {
      subject: body.id,
      email: body.email ?? null,
      expiresAt: exp ? new Date(exp * 1000) : null,
      via: "auth-server",
    };
  }

  return {
    async verify(token: string): Promise<VerifiedToken> {
      if (!token) throw new TokenError("missing", "no access token");
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw new TokenError("malformed", "access token is not a JWT");
      }
      if (!alg) throw new TokenError("malformed", "access token header has no alg");
      if (alg.startsWith("HS")) return viaAuthServer(token);
      return viaJwks(token);
    },
  };
}

/** Pull the bearer token out of an Authorization header value. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
