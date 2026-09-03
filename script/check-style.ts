/**
 * Copy rule guard.
 *
 * No em dashes and no en dashes anywhere in source, SQL, or specification
 * prose. The previous version of this check was a grep with a PCRE escape
 * that silently errors out on some grep builds, which means it reported
 * success while scanning nothing. A script cannot fail that way.
 *
 * Exits 1 on the first violation with a file and line reference.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["client/src", "shared", "server", "db", "docs", "script"];
const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".sql", ".md", ".yml"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build"]);

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root, []));
const violations: string[] = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.includes(EM_DASH) || line.includes(EN_DASH)) {
      violations.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error("Found a long dash. Rewrite the sentence with plain punctuation.\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} violation(s) across ${files.length} files.`);
  process.exit(1);
}

console.log(`No long dashes found. Scanned ${files.length} files.`);
