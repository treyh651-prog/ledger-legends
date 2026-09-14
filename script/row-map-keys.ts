/**
 * The `RowMap` keys, read out of the source.
 *
 * A type cannot be enumerated at runtime and a hand kept list would drift, so
 * the interface block in `server/runs/tables.ts` is parsed. Two callers need
 * this now, `script/check-schema.ts` and `script/db-verify.ts`, and two copies
 * of the parser would be the same drift the schema gate exists to catch.
 */

import { readFileSync } from "node:fs";

export function rowMapKeys(source = "server/runs/tables.ts"): string[] {
  const src = readFileSync(source, "utf8");
  const start = src.indexOf("export interface RowMap {");
  if (start < 0) throw new Error(`RowMap interface not found in ${source}`);
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error("RowMap interface has no closing brace");
  const body = src.slice(start, end);
  const keys: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    const m = /^\s*([a-z0-9_]+)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  if (keys.length === 0) throw new Error("RowMap parsed to zero keys");
  return keys;
}
