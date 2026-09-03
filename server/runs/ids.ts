/**
 * Identifiers and hashing.
 *
 * ULIDs rather than UUIDs for anything read in time order, per doc 00 Part 1.
 * Crockford base32, 10 characters of millisecond timestamp then 16 characters
 * of randomness, monotonic inside the same millisecond so two ids minted in one
 * loop still sort in creation order.
 */

import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = -1;
let lastRandom: number[] = [];

function randomChars(count: number): number[] {
  const bytes = randomBytes(count);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(bytes[i] % 32);
  return out;
}

function incrementRandom(chars: number[]): number[] {
  const out = chars.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] < 31) {
      out[i] += 1;
      return out;
    }
    out[i] = 0;
  }
  return randomChars(out.length);
}

function encodeTime(ms: number): string {
  let value = ms;
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    out.unshift(ALPHABET[value % 32]);
    value = Math.floor(value / 32);
  }
  return out.join("");
}

export function ulid(now?: Date): string {
  const ms = now ? now.getTime() : Date.now();
  if (ms === lastMs) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastMs = ms;
    lastRandom = randomChars(16);
  }
  return encodeTime(ms) + lastRandom.map((c) => ALPHABET[c]).join("");
}

/** A run execution id is "RUNX-" plus a ULID. */
export function runExecutionId(now?: Date): string {
  return `RUNX-${ulid(now)}`;
}

/**
 * A deterministic id derived from a seed id, a kind, and an ordinal.
 *
 * Preview and apply must produce byte identical proposal sets, and the import
 * pipeline proposes rows that do not exist yet, so their ids cannot come from
 * ulid(), which carries randomness. Derived ids are stable across the two
 * modes and across a retry, they keep the 26 character Crockford base32 shape
 * the id columns declare, and they sort inside a batch by ordinal.
 */
export function derivedId(seed: string, kind: string, ordinal: number): string {
  const digest = sha256Hex(`${seed}:${kind}`);
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % 32];
  }
  let value = ordinal;
  const tail: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    tail.unshift(ALPHABET[value % 32]);
    value = Math.floor(value / 32);
  }
  return tail.join("") + out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON with sorted object keys and an explicit encoding for
 * bigint, so a hash over a proposal set is stable and no float ever appears.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return `{"$cents":"${value.toString()}"}`;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`non integer number in canonical json: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  throw new Error(`unsupported value in canonical json: ${typeof value}`);
}

/** Convert a value carrying bigint cents into plain JSON safe data. */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $cents: value.toString() };
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJsonValue(v);
    }
    return out;
  }
  return value;
}

/** Inverse of toJsonValue. */
export function fromJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => fromJsonValue(v));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$cents === "string" && Object.keys(obj).length === 1) {
      return BigInt(obj.$cents);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = fromJsonValue(v);
    return out;
  }
  return value;
}

/**
 * The idempotency key of doc 03 Part 4. Computed once the scope is frozen,
 * because the scope hash is part of it.
 */
export function idempotencyKeyFor(args: {
  runType: string;
  runVersion: number;
  firmId: string;
  clientId: string;
  scopeHash: string;
  mode: string;
}): string {
  return sha256Hex(
    [
      args.runType,
      String(args.runVersion),
      args.firmId,
      args.clientId,
      args.scopeHash,
      args.mode,
    ].join(":"),
  );
}

/** sha256 over the ordered candidate ids plus every participating version. */
export function scopeHashFor(args: {
  candidateIds: readonly string[];
  versions: readonly { id: string; version: number }[];
}): string {
  const versions = args.versions
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
  return sha256Hex(
    canonicalJson({ candidateIds: args.candidateIds, versions }),
  );
}

/** Digest of a proposal set, used for the preview to apply parity check. */
export function proposalsDigest(proposals: readonly unknown[]): string {
  return sha256Hex(canonicalJson(proposals));
}
