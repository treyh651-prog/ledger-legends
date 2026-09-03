/**
 * A hand rolled test harness, in the style of script/check-books.ts.
 *
 * No vitest, no jest, nothing installed. A test is a name plus a function. A
 * failed assertion records a line and the process exits nonzero at the end.
 */

interface Recorded {
  name: string;
  failures: string[];
}

const recorded: Recorded[] = [];
let current: Recorded | null = null;

export function fail(message: string): void {
  if (!current) {
    recorded.push({ name: "outside a test", failures: [message] });
    return;
  }
  current.failures.push(message);
}

export function assert(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = show(actual);
  const b = show(expected);
  if (a !== b) fail(`${message}: got ${a}, expected ${b}`);
}

export function assertThrows(
  fn: () => unknown,
  codeOrMessage: string,
  message: string,
): void {
  try {
    const out = fn();
    if (out instanceof Promise) {
      fail(`${message}: an async function was passed to assertThrows`);
      return;
    }
    fail(`${message}: nothing was thrown`);
  } catch (err) {
    const text = describeError(err);
    if (!text.includes(codeOrMessage)) {
      fail(`${message}: threw ${text}, expected it to mention ${codeOrMessage}`);
    }
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  codeOrMessage: string,
  message: string,
): Promise<void> {
  try {
    await fn();
    fail(`${message}: the promise resolved`);
  } catch (err) {
    const text = describeError(err);
    if (!text.includes(codeOrMessage)) {
      fail(`${message}: rejected with ${text}, expected it to mention ${codeOrMessage}`);
    }
  }
}

function describeError(err: unknown): string {
  const candidate = err as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const msg = err instanceof Error ? err.message : String(err);
  return `${code} ${msg}`.trim();
}

export function show(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) return `[${value.map(show).join(",")}]`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      (x, y) => (x[0] < y[0] ? -1 : 1),
    );
    return `{${entries.map(([k, v]) => `${k}:${show(v)}`).join(",")}}`;
  }
  return String(value);
}

const queue: { name: string; fn: () => Promise<void> | void }[] = [];

export function test(name: string, fn: () => Promise<void> | void): void {
  queue.push({ name, fn });
}

export async function runAll(title: string): Promise<void> {
  console.log(title);
  for (const item of queue) {
    current = { name: item.name, failures: [] };
    recorded.push(current);
    try {
      await item.fn();
    } catch (err) {
      current.failures.push(`threw ${describeError(err)}`);
    }
    const marker = current.failures.length === 0 ? "pass" : "FAIL";
    console.log(`  ${marker}  ${item.name}`);
    for (const f of current.failures) console.log(`         ${f}`);
    current = null;
  }
  const failed = recorded.filter((r) => r.failures.length > 0);
  const total = queue.length;
  console.log(
    failed.length === 0
      ? `\n${String(total)} tests passed`
      : `\n${String(failed.length)} of ${String(total)} tests failed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
