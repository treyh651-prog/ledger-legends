/**
 * The business feed: status precedence (pure, no database), the opaque id
 * (stable, not the raw client id), the field whitelist (exactly
 * {id, name, status} per client and {version, clients} at the top), and
 * auth refusal (no header, wrong token, and token unset entirely).
 */

import type { AddressInfo } from "net";
import express from "express";
import { assert, assertEqual, test } from "../../runs/__tests__/harness";
import { createBusinessFeedRouter, feedClientOf, opaqueClientId, statusFor, type ClientStatusSignals } from "../business-feed";

const NONE: ClientStatusSignals = { closed: false, reviewerPending: false, latestImportFailed: false, clientOwesDocuments: false, recentActivity: false };

test("business feed: each signal on its own maps to its own status", () => {
  assertEqual(statusFor(NONE), "idle", "nothing going on, nothing recent");
  assertEqual(statusFor({ ...NONE, recentActivity: true }), "working", "recent activity alone");
  assertEqual(statusFor({ ...NONE, closed: true }), "closed", "closed alone");
  assertEqual(statusFor({ ...NONE, reviewerPending: true }), "review", "reviewer pending alone");
  assertEqual(statusFor({ ...NONE, clientOwesDocuments: true }), "waiting", "client owes documents alone");
  assertEqual(statusFor({ ...NONE, latestImportFailed: true }), "broken", "latest import failed alone");
});

test("business feed: precedence is broken > waiting > review > closed > working > idle", () => {
  const all: ClientStatusSignals = { closed: true, reviewerPending: true, latestImportFailed: true, clientOwesDocuments: true, recentActivity: true };
  assertEqual(statusFor(all), "broken", "broken wins over everything");
  assertEqual(statusFor({ ...all, latestImportFailed: false }), "waiting", "waiting wins once broken is off");
  assertEqual(statusFor({ ...all, latestImportFailed: false, clientOwesDocuments: false }), "review", "review wins once broken and waiting are off");
  assertEqual(
    statusFor({ ...all, latestImportFailed: false, clientOwesDocuments: false, reviewerPending: false }),
    "closed",
    "closed wins once broken, waiting, and review are off",
  );
  assertEqual(
    statusFor({ ...all, latestImportFailed: false, clientOwesDocuments: false, reviewerPending: false, closed: false }),
    "working",
    "working is the fallback once every blocking signal is off but something happened recently",
  );
});

test("business feed: opaqueClientId is stable, not the raw id, and distinct per client", () => {
  const a1 = opaqueClientId("secret-token", "client-a");
  const a2 = opaqueClientId("secret-token", "client-a");
  const b = opaqueClientId("secret-token", "client-b");
  assertEqual(a1, a2, "the same token and client id always hash the same");
  assert(a1 !== "client-a", "never the raw id");
  assert(a1 !== b, "different clients hash differently");
  assert(opaqueClientId("other-token", "client-a") !== a1, "a different token changes the hash too");
});

test("business feed: feedClientOf returns exactly id, name, and status", () => {
  const out = feedClientOf("tok", { clientId: "c-1", name: "Acme Plumbing LLC", signals: { ...NONE, recentActivity: true } });
  assertEqual(Object.keys(out).sort().join(","), "id,name,status", "no other field leaks through");
  assertEqual(out.name, "Acme Plumbing LLC", "name passes through");
  assertEqual(out.status, "working", "status computed from signals");
  assert(out.id !== "c-1", "id is the opaque hash, not the raw client id");
});

async function startFeed(token: string | null): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createBusinessFeedRouter(null, token));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("business feed: refuses with no Authorization header", async () => {
  const world = await startFeed("real-token");
  try {
    const r = await fetch(`${world.base}/business-feed`);
    assertEqual(r.status, 401, "no header, refused");
  } finally {
    await world.close();
  }
});

test("business feed: refuses a wrong token", async () => {
  const world = await startFeed("real-token");
  try {
    const r = await fetch(`${world.base}/business-feed`, { headers: { authorization: "Bearer wrong-token" } });
    assertEqual(r.status, 401, "wrong token, refused");
  } finally {
    await world.close();
  }
});

test("business feed: refuses every request when BUSINESS_FEED_TOKEN is unset, even the right-looking guess", async () => {
  const world = await startFeed(null);
  try {
    const r = await fetch(`${world.base}/business-feed`, { headers: { authorization: "Bearer anything" } });
    assertEqual(r.status, 401, "unset token refuses outright, never opens up");
  } finally {
    await world.close();
  }
});

test("business feed: a correct token with no pool (memory mode) answers a real, empty feed", async () => {
  const world = await startFeed("real-token");
  try {
    const r = await fetch(`${world.base}/business-feed`, { headers: { authorization: "Bearer real-token" } });
    assertEqual(r.status, 200, "authorized");
    const body = (await r.json()) as { version: number; clients: unknown[] };
    assertEqual(body.version, 1, "version 1");
    assertEqual(body.clients.length, 0, "no real tenancy tables to read in memory mode");
  } finally {
    await world.close();
  }
});
