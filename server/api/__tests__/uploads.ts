/**
 * Document upload and download, NOTES 256. Its own world over the memory port
 * with a memory document store, started after portal-routes.ts has stopped its
 * own. The engagement is activated by hand so the documents gate opens.
 *
 * Covered: a client upload, a firm upload for the same client, the list after
 * a fresh read, an authorized download, a client of another business refused,
 * another firm refused, a wrong type, a mismatched body, an oversized body,
 * a record write that fails after the object was stored, and that the upload
 * and the download each leave their own row in docvault.audit_events.
 */
import { test, assert, assertEqual } from "../../runs/__tests__/harness";
import { DEV_ACTOR, DEV_FIRM_ID, DEV_USER_ID } from "../dev-actor";
import { readSession } from "../session";
import { startWorld, call, NEW_CLIENT, type World } from "./routes";
import { createHash } from "node:crypto";
import { createMemoryStorage } from "../../storage/document-storage";
import { headerFingerprintOf } from "../../runs/runs/import-parse-feed";
import type { BankAccountRow, MappingProfileRow } from "../../runs/tables";
import { vendor as vendorFixture } from "../../runs/__tests__/arap-fixtures";
import { asset as assetFixture, loan as loanFixture } from "../../runs/__tests__/per-fixtures";

const CSV_HEADER = ["Date", "Description", "Amount"];
function csvBody(lines: readonly string[] = ["01/12/2026,COFFEE HOUSE #22,-14.75"]): Buffer {
  return Buffer.from(`${CSV_HEADER.join(",")}\n${lines.join("\n")}\n`, "utf8");
}
const XLSX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);

async function seedBankAccount(
  w: World,
  cid: string,
  id: string,
  institutionName = "First Bank",
): Promise<void> {
  await w.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
    const row: BankAccountRow = {
      id,
      firmId: DEV_FIRM_ID,
      clientId: cid,
      accountNumber: "1010",
      nickname: "Operating checking",
      kind: "bank",
      isProcessorDestination: false,
      institutionName,
    };
    await tx.insert("bank_accounts", [row]);
  });
}

async function seedVendor(w: World, cid: string, id: string): Promise<void> {
  await w.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
    await tx.insert("vendors", [vendorFixture(id, { firmId: DEV_FIRM_ID, clientId: cid })]);
  });
}

async function seedAsset(w: World, cid: string, id: string): Promise<void> {
  await w.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
    await tx.insert("fixed_assets", [assetFixture(id, { firmId: DEV_FIRM_ID, clientId: cid })]);
  });
}

async function seedLoan(w: World, cid: string, id: string): Promise<void> {
  await w.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
    await tx.insert("loans", [loanFixture(id, { firmId: DEV_FIRM_ID, clientId: cid })]);
  });
}

async function seedMappingProfile(w: World, cid: string, id: string, institutionName = "First Bank"): Promise<void> {
  await w.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
    const row: MappingProfileRow = {
      id,
      firmId: DEV_FIRM_ID,
      clientId: cid,
      version: 1,
      institutionName,
      accountNumber: "1010",
      fileFormat: "csv",
      headerFingerprint: headerFingerprintOf(CSV_HEADER),
      headerRowNumber: 1,
      skipRows: 0,
      dateColumn: "Date",
      dateFormat: "MM/DD/YYYY",
      descriptionColumn: "Description",
      amountColumn: "Amount",
      debitColumn: null,
      creditColumn: null,
      signConvention: "credit_positive",
      currency: "USD",
      bankIdColumn: null,
      checkNumberColumn: null,
      bankCodeColumn: null,
      isActive: true,
      createdBy: DEV_USER_ID,
    };
    await tx.insert("mapping_profiles", [row]);
  });
}

let world: World;
let clientId = "";
let otherClientId = "";
let clientDocId = "";
let firmDocId = "";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function upload(
  path: string,
  opts: { token?: string | null; filename: string; docType: string; bytes: Buffer; contentType?: string; requestId?: string; bankAccountId?: string; vendorId?: string; assetId?: string; loanId?: string; periodEnd?: string },
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/octet-stream",
    "x-file-name": encodeURIComponent(opts.filename),
    "x-doc-type": opts.docType,
  };
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  if (opts.bankAccountId) headers["x-bank-account-id"] = opts.bankAccountId;
  if (opts.vendorId) headers["x-vendor-id"] = opts.vendorId;
  if (opts.assetId) headers["x-asset-id"] = opts.assetId;
  if (opts.loanId) headers["x-loan-id"] = opts.loanId;
  if (opts.periodEnd) headers["x-period-end"] = opts.periodEnd;
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "owner"}`;
  const res = await fetch(world.base + path, { method: "POST", headers, body: new Uint8Array(opts.bytes) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

test("uploads: the world starts with a memory store and an active client", async () => {
  world = await startWorld({ storage: createMemoryStorage() });
  const r = await call(world, "POST", "/api/firm/clients", { body: NEW_CLIENT });
  assertEqual(r.status, 201, "created");
  clientId = r.body.client.id;
  world.setClientFor(clientId);
  const other = await call(world, "POST", "/api/firm/clients", { body: { ...NEW_CLIENT, name: "Other Business LLC" } });
  otherClientId = other.body.client.id;
  for (const id of [clientId, otherClientId]) {
    await world.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, id), readOnly: false }, async (tx) => {
      const engagements = await tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId: id });
      await tx.update("engagements", engagements[0]!.id, { status: "active" } as any);
    });
  }
  const docs = await call(world, "GET", `/api/portal/${clientId}/documents`, { token: "client" });
  assertEqual(docs.status, 200, "documents readable");
  assertEqual(docs.body.storageConfigured, true, "storage configured");
  assertEqual(docs.body.storageProvider, "memory", "memory provider named");
  assertEqual(docs.body.items.length, 0, "nothing on file");
});

test("uploads: a client user sends a PDF and the record exists only after the object does", async () => {
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "October statement.pdf",
    docType: "bank_statement",
    bytes: PDF,
    contentType: "application/pdf",
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.done, true, "done");
  clientDocId = r.body.document.id;
  assertEqual(r.body.document.title, "October statement.pdf", "original name kept");
  assertEqual(r.body.document.status, "uploaded", "status uploaded");
  assertEqual(r.body.document.byteSize, PDF.length, "size recorded");
  assertEqual(r.body.document.contentType, "application/pdf", "type recorded");
  const key = `firm/${DEV_FIRM_ID}/client/${clientId}/${clientDocId}/October statement.pdf`;
  assert(world.storage!.objects.has(key), "object stored under the firm and client scoped key");
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: clientDocId }),
  );
  const row = rows[0] as any;
  assertEqual(row.uploadedBy, "00000000-0000-4000-8000-0000000000c1", "uploader is the authenticated client user");
  assertEqual(row.sha256Hex, createHash("sha256").update(PDF).digest("hex"), "hash recorded");
  assertEqual(row.scanStatus, "not_scanned", "scan status honest");
  assertEqual(row.magicVerified, true, "magic bytes verified");
  assertEqual(row.storageProvider, "supabase", "provider shape");

  // docvault.audit_events has carried the document access log since migration
  // 0008; this is the first thing in this suite that could ever have written
  // to it.
  const events = world.db.all("audit_events").filter((e: any) => e.documentId === clientDocId);
  assertEqual(events.length, 1, "one audit event for the upload");
  assertEqual(events[0].action, "row_created", "the event DOC-RECORD-UPLOAD can attest to");
  assertEqual(events[0].actorId, "00000000-0000-4000-8000-0000000000c1", "attributed to the uploader");
  assert(events[0].createdAt !== null, "timestamped");
});

test("uploads: firm staff send a PNG for the same client through firm membership", async () => {
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "owner",
    filename: "receipt.png",
    docType: "receipt",
    bytes: PNG,
    contentType: "image/png",
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  firmDocId = r.body.document.id;
  assert(firmDocId !== clientDocId, "a fresh id");
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: firmDocId }),
  );
  assertEqual((rows[0] as any).uploadedBy, DEV_ACTOR.userId, "uploader is the firm owner");
});

test("uploads: a fresh read lists both documents, newest first", async () => {
  const docs = await call(world, "GET", `/api/portal/${clientId}/documents`, { token: "client" });
  assertEqual(docs.status, 200, "status");
  assertEqual(docs.body.items.length, 2, "two on file");
  const ids = docs.body.items.map((d: any) => d.id);
  assert(ids.includes(clientDocId) && ids.includes(firmDocId), "both listed");
});

test("uploads: the client downloads their own document and the bytes match", async () => {
  const res = await fetch(`${world.base}/api/portal/${clientId}/documents/${clientDocId}/download`, {
    headers: { authorization: "Bearer client" },
  });
  assertEqual(res.status, 200, "status");
  assertEqual(res.headers.get("content-type"), "application/pdf", "content type");
  assert((res.headers.get("content-disposition") ?? "").includes("October statement.pdf"), "filename in disposition");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(bytes.equals(PDF), "same bytes back");

  // The memory store never signs a URL, so every download in this suite takes
  // the direct byte stream path, and that is the one this asserts.
  const events = world.db
    .all("audit_events")
    .filter((e: any) => e.documentId === clientDocId && e.action === "download_completed");
  assertEqual(events.length, 1, "one download event recorded");
  assert((events[0]?.ipInet ?? "").length > 0, "the requesting address is recorded");
});

test("uploads: a client user of another business is refused on upload, list and download", async () => {
  world.setClientFor(otherClientId);
  const up = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "x.pdf", docType: "other", bytes: PDF });
  assert(up.status === 403 || up.status === 404, `upload refused: ${up.status}`);
  const list = await call(world, "GET", `/api/portal/${clientId}/documents`, { token: "client" });
  assert(list.status === 403 || list.status === 404, `list refused: ${list.status}`);
  const dl = await fetch(`${world.base}/api/portal/${clientId}/documents/${clientDocId}/download`, { headers: { authorization: "Bearer client" } });
  assert(dl.status === 403 || dl.status === 404, `download refused: ${dl.status}`);
  world.setClientFor(clientId);
  const objectCount = world.storage!.objects.size;
  assertEqual(objectCount, 2, "no object written for the refused upload");
});

test("uploads: another firm's owner cannot reach the client at all", async () => {
  const up = await upload(`/api/portal/${clientId}/documents`, { token: "other-firm", filename: "x.pdf", docType: "other", bytes: PDF });
  assert(up.status === 403 || up.status === 404, `refused: ${up.status}`);
  const dl = await fetch(`${world.base}/api/portal/${clientId}/documents/${clientDocId}/download`, { headers: { authorization: "Bearer other-firm" } });
  assert(dl.status === 403 || dl.status === 404, `download refused: ${dl.status}`);
});

test("uploads: no token is 401", async () => {
  const up = await upload(`/api/portal/${clientId}/documents`, { token: null, filename: "x.pdf", docType: "other", bytes: PDF });
  assertEqual(up.status, 401, "status");
});

test("uploads: a type outside the list is refused before any object is written", async () => {
  const before = world.storage!.objects.size;
  const r = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "notes.exe", docType: "other", bytes: PDF });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "upload_rejected", "code");
  assertEqual(world.storage!.objects.size, before, "nothing stored");
});

test("uploads: a file whose bytes do not match its name is refused", async () => {
  const r = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "photo.png", docType: "receipt", bytes: PDF, contentType: "image/png" });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "upload_rejected", "code");
  const r2 = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "data.csv", docType: "other", bytes: PNG, contentType: "text/csv" });
  assertEqual(r2.status, 400, "binary csv refused");
});

test("uploads: an oversized body is 413 and nothing is stored", async () => {
  const before = world.storage!.objects.size;
  const max = Number(process.env.UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;
  const big = Buffer.alloc(max + 1024, 0x20);
  PDF.copy(big, 0);
  const r = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "big.pdf", docType: "other", bytes: big, contentType: "application/pdf" });
  assertEqual(r.status, 413, `status: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.error.code, "payload_too_large", "code");
  assertEqual(world.storage!.objects.size, before, "nothing stored");
});

test("uploads: an unknown document type and a missing filename are 400", async () => {
  const r = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "x.pdf", docType: "tax_return", bytes: PDF });
  assertEqual(r.status, 400, "doc type outside the offered list");
  const res = await fetch(`${world.base}/api/portal/${clientId}/documents`, {
    method: "POST",
    headers: { authorization: "Bearer client", "content-type": "application/pdf", "x-doc-type": "other" },
    body: new Uint8Array(PDF),
  });
  assertEqual(res.status, 400, "missing filename");
});

test("uploads: when the record write fails the stored object is removed and the request fails", async () => {
  const before = world.storage!.objects.size;
  // Its own world, so the main one is not wrapped. The memory port's insert
  // into documents is made to throw once, after the object has been stored.
  const failing = createMemoryStorage();
  const w2 = await startWorld({ storage: failing });
  try {
    const r0 = await call(w2, "POST", "/api/firm/clients", { body: NEW_CLIENT });
    const cid = r0.body.client.id;
    w2.setClientFor(cid);
    await w2.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
      const engagements = await tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId: cid });
      await tx.update("engagements", engagements[0]!.id, { status: "active" } as any);
    });
    // Break the record path: the memory port throws on insert into documents once.
    const realTx = w2.db.tx.bind(w2.db);
    let armed = true;
    (w2.db as any).tx = async (session: any, fn: any) =>
      realTx(session, async (tx: any) => {
        if (armed && session.readOnly === false) {
          const realInsert = tx.insert.bind(tx);
          tx.insert = async (table: string, rows: any[]) => {
            if (table === "documents") {
              armed = false;
              throw new Error("simulated database failure");
            }
            return realInsert(table, rows);
          };
        }
        return fn(tx);
      });
    const headers = {
      authorization: "Bearer client",
      "content-type": "application/pdf",
      "x-file-name": "fails.pdf",
      "x-doc-type": "other",
    };
    const res = await fetch(`${w2.base}/api/portal/${cid}/documents`, { method: "POST", headers, body: new Uint8Array(PDF) });
    assert(res.status >= 400, `failed: ${res.status}`);
    assertEqual(failing.objects.size, 0, "the orphan object was removed");
    const docs = await call(w2, "GET", `/api/portal/${cid}/documents`, { token: "client" });
    assertEqual(docs.body.items.length, 0, "no record either");
  } finally {
    await w2.close();
  }
  assertEqual(world.storage!.objects.size, before, "the main world is untouched");
});

test("uploads: a store that refuses the object leaves no record", async () => {
  world.storage!.failNextPut = true;
  const r = await upload(`/api/portal/${clientId}/documents`, { token: "client", filename: "refused.pdf", docType: "other", bytes: PDF, contentType: "application/pdf" });
  assertEqual(r.status, 500, "status");
  const docs = await call(world, "GET", `/api/portal/${clientId}/documents`, { token: "client" });
  assertEqual(docs.body.items.length, 2, "still two");
});

test("uploads: without a store the upload answers 501 naming the settings", async () => {
  const bare = await startWorld();
  try {
    const r0 = await call(bare, "POST", "/api/firm/clients", { body: NEW_CLIENT });
    const cid = r0.body.client.id;
    bare.setClientFor(cid);
    await bare.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, cid), readOnly: false }, async (tx) => {
      const engagements = await tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId: cid });
      await tx.update("engagements", engagements[0]!.id, { status: "active" } as any);
    });
    const docs = await call(bare, "GET", `/api/portal/${cid}/documents`, { token: "client" });
    assertEqual(docs.body.storageConfigured, false, "not configured");
    const res = await fetch(`${bare.base}/api/portal/${cid}/documents`, {
      method: "POST",
      headers: { authorization: "Bearer client", "content-type": "application/pdf", "x-file-name": "x.pdf", "x-doc-type": "other" },
      body: new Uint8Array(PDF),
    });
    assertEqual(res.status, 501, "status");
    const body = (await res.json()) as any;
    assert(String(body.error.message).includes("SUPABASE_SERVICE_ROLE_KEY"), "names the missing setting");
  } finally {
    await bare.close();
  }
});

/* ---------------- The two step direct upload path (NOTES, Netlify adaptation) ----------------
 *
 * finalize is exercised directly against the memory store by writing the
 * object with storage.put first, standing in for the browser's own write to
 * Supabase Storage that step 1 and step 2 sit on either side of in
 * production. Everything finalize itself does, the memory store supports:
 * read, inspect, remove on refusal, recordDocument. Only createUploadUrl is
 * real Supabase REST and untested here; its only job is returning a URL and
 * it is covered by a server answering 501 when it is absent, below.
 */

test("finalize: the object is read back, inspected, and recorded exactly like a direct upload", async () => {
  const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const filename = "statement.pdf";
  const objectKey = `firm/${DEV_FIRM_ID}/client/${clientId}/${documentId}/${filename}`;
  await world.storage!.put(objectKey, PDF, "application/pdf");
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/${documentId}/finalize`, {
    token: "client",
    body: { filename, docType: "bank_statement", objectKey },
  });
  assertEqual(res.status, 201, `finalized: ${JSON.stringify(res.body)}`);
  assertEqual(res.body.document.title, filename, "title recorded");
  assertEqual(res.body.document.byteSize, PDF.length, "size recorded from the object itself, not a client claim");
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: res.body.document.id }),
  );
  assertEqual((rows[0] as any).sha256Hex, createHash("sha256").update(PDF).digest("hex"), "hash recorded from the object's own bytes");
});

test("finalize: an object key outside this document's own firm and client prefix is refused before anything is read", async () => {
  const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FBB";
  const foreignKey = `firm/${DEV_FIRM_ID}/client/${otherClientId}/${documentId}/x.pdf`;
  const before = world.storage!.objects.size;
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/${documentId}/finalize`, {
    token: "client",
    body: { filename: "x.pdf", docType: "other", objectKey: foreignKey },
  });
  assertEqual(res.status, 400, `refused: ${JSON.stringify(res.body)}`);
  assertEqual(world.storage!.objects.size, before, "nothing was read or touched");
});

test("finalize: content that does not match its declared name is refused and the object is removed", async () => {
  const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FCC";
  const filename = "photo.png";
  const objectKey = `firm/${DEV_FIRM_ID}/client/${clientId}/${documentId}/${filename}`;
  await world.storage!.put(objectKey, PDF, "image/png");
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/${documentId}/finalize`, {
    token: "client",
    body: { filename, docType: "receipt", objectKey },
  });
  assertEqual(res.status, 400, `refused: ${JSON.stringify(res.body)}`);
  assertEqual(res.body.error.code, "upload_rejected", "code");
  assert(!world.storage!.objects.has(objectKey), "the mismatched object was removed, same as the body route refuses before ever writing one");
});

test("finalize: no object at the given key is refused", async () => {
  const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FDD";
  const objectKey = `firm/${DEV_FIRM_ID}/client/${clientId}/${documentId}/missing.pdf`;
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/${documentId}/finalize`, {
    token: "client",
    body: { filename: "missing.pdf", docType: "other", objectKey },
  });
  assertEqual(res.status, 400, `refused: ${JSON.stringify(res.body)}`);
});

test("finalize: a client user of another business cannot finalize into this client", async () => {
  const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FEE";
  const objectKey = `firm/${DEV_FIRM_ID}/client/${clientId}/${documentId}/x.pdf`;
  world.setClientFor(otherClientId);
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/${documentId}/finalize`, {
    token: "client",
    body: { filename: "x.pdf", docType: "other", objectKey },
  });
  assert(res.status === 403 || res.status === 404, `refused: ${res.status}`);
  world.setClientFor(clientId);
});

test("upload-url: the memory store has no direct upload mechanism, so the route answers 501 and the browser falls back to the body route", async () => {
  const res = await call(world, "POST", `/api/portal/${clientId}/documents/upload-url`, {
    token: "client",
    body: { filename: "x.pdf", docType: "other" },
  });
  assertEqual(res.status, 501, `status: ${JSON.stringify(res.body)}`);
  assertEqual(res.body.error.code, "not_configured", "code");
});

/* ---------------- Statement uploads reach IMPORT-PARSE-FEED automatically ----------------
 *
 * These five cover doc upload's new connection to the import pipeline: a
 * matching header stages the file, a mismatched header opens the firm's
 * mapping exception and stages nothing, a duplicate upload of the same file
 * is held rather than staged twice, a wrong tenant account is refused before
 * the file is even read, and xlsx is accepted for storage but never parsed.
 * IMPORT-COMMIT-BATCH, IMPORT-REJECT-BATCH and the full coding cascade are
 * covered against the firm's staged-batches routes in routes.ts; nothing
 * here commits anything, by construction, since recordDocument only ever
 * calls IMPORT-PARSE-FEED.
 */

test("uploads: a bank statement csv with a matching account is staged automatically", async () => {
  const bankAccountId = "BA-UP-0001";
  await seedBankAccount(world, clientId, bankAccountId);
  await seedMappingProfile(world, clientId, "MP-UP-0001");

  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "october.csv",
    docType: "bank_statement",
    bytes: csvBody(),
    contentType: "text/csv",
    bankAccountId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.importOutcome.status, "staged", "parsed into staging");
  assertEqual(r.body.importOutcome.detail, null, "no detail needed on a clean stage");

  const batches = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("import_batches_awaiting_review", { firmId: DEV_FIRM_ID, clientId }),
  );
  const batch = (batches as any[]).find((b) => b.bankAccountId === bankAccountId);
  assert(batch !== undefined, "a batch is waiting on a decision");
  assertEqual(batch.sourceDocumentId, r.body.document.id, "the batch names the document it came from");
  const staged = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("staged_rows_by_batch", { firmId: DEV_FIRM_ID, clientId, batchId: batch.id }),
  );
  assertEqual(staged.length, 1, "one staged row");
  assertEqual(batch.status, "parsed", "parsed and ready, not yet committed");
});

test("uploads: a header that does not match opens a mapping exception and stages nothing", async () => {
  const bankAccountId = "BA-UP-0002";
  await seedBankAccount(world, clientId, bankAccountId, "Second Bank");
  // No mapping profile for "Second Bank" at all.

  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "november.csv",
    docType: "bank_statement",
    bytes: csvBody(),
    contentType: "text/csv",
    bankAccountId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.importOutcome.status, "needs_mapping", "flagged rather than guessed");
  assert(String(r.body.importOutcome.detail).includes("no active csv mapping profile"), "names the reason");

  const exceptions = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("mapping_exception_for_account", { firmId: DEV_FIRM_ID, clientId, bankAccountId }),
  );
  assertEqual(exceptions.length, 1, "one exception row");
  assertEqual(exceptions[0].status, "open", "open, waiting on the firm");
  assertEqual(exceptions[0].sourceDocumentId, r.body.document.id, "linked to the document that triggered it");

  const batches = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("import_batches_awaiting_review", { firmId: DEV_FIRM_ID, clientId }),
  );
  assert(!(batches as any[]).some((b) => b.bankAccountId === bankAccountId), "no batch was staged for this account");

  // Fixing the profile and uploading again resolves the exception.
  await seedMappingProfile(world, clientId, "MP-UP-0002", "Second Bank");
  const r2 = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "november-fixed.csv",
    docType: "bank_statement",
    bytes: csvBody(["01/13/2026,A DIFFERENT ROW,-20.00"]),
    contentType: "text/csv",
    bankAccountId,
  });
  assertEqual(r2.body.importOutcome.status, "staged", "the retry got past the mapping check");
  const resolved = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("mapping_exception_for_account", { firmId: DEV_FIRM_ID, clientId, bankAccountId }),
  );
  assertEqual(resolved[0].status, "resolved", "the same row closed itself once a parse got through");
});

test("uploads: a repeated upload of the same statement is held, not staged twice", async () => {
  const bankAccountId = "BA-UP-0001";
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "october.csv",
    docType: "bank_statement",
    bytes: csvBody(),
    contentType: "text/csv",
    bankAccountId,
  });
  // A second document with the exact same bytes derives the same batch id,
  // so IMPORT-PARSE-FEED's own preview reports no_op rather than staging a
  // second copy of the same file.
  assertEqual(r.body.importOutcome.status, "staged", "reported as staged either way");
  assertEqual(r.body.importOutcome.detail, "this statement was already imported", "named as the repeat it is");
});

test("uploads: a bank account from another client is refused before the file is read", async () => {
  const bankAccountId = "BA-UP-0001"; // belongs to clientId, not otherClientId
  world.setClientFor(otherClientId);
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "client",
    filename: "cross-tenant.csv",
    docType: "bank_statement",
    bytes: csvBody(),
    contentType: "text/csv",
    bankAccountId,
  });
  assertEqual(r.status, 500, `refused: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.error.code, "run_refused", "the document record itself refused");
  world.setClientFor(clientId);
});

test("uploads: an xlsx statement is accepted for storage but not read automatically", async () => {
  const bankAccountId = "BA-UP-0001";
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "october.xlsx",
    docType: "bank_statement",
    bytes: XLSX_BYTES,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bankAccountId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.importOutcome.status, "not_supported", "stored, not parsed");
  assert(String(r.body.importOutcome.detail).toLowerCase().includes("csv"), "tells the uploader what to do instead");
});

/* ---------------- Vendor, asset, and loan links ----------------
 *
 * Same tenant check as the bank account above, now exercised for the other
 * three link fields migration 0047 gave a foreign key. None of these change
 * what happens to the file; they only record which row the document is for.
 */

test("uploads: a bill names a real vendor and the link is recorded", async () => {
  const vendorId = "VN-UP-0001";
  await seedVendor(world, clientId, vendorId);
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "bill.pdf",
    docType: "invoice_ap",
    bytes: PDF,
    contentType: "application/pdf",
    vendorId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: r.body.document.id }),
  );
  assertEqual((rows[0] as any).linkedVendorId, vendorId, "the link is on the row");
});

test("uploads: a vendor from another client is refused before the file is kept", async () => {
  const vendorId = "VN-UP-0001"; // belongs to clientId
  world.setClientFor(otherClientId);
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "client",
    filename: "cross-tenant-bill.pdf",
    docType: "invoice_ap",
    bytes: PDF,
    contentType: "application/pdf",
    vendorId,
  });
  assertEqual(r.status, 500, `refused: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.error.code, "run_refused", "DOC-RECORD-UPLOAD refused it");
  world.setClientFor(clientId);
});

test("uploads: a receipt names a real fixed asset and the link is recorded", async () => {
  const assetId = "AS-UP-0001";
  await seedAsset(world, clientId, assetId);
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "receipt.pdf",
    docType: "receipt",
    bytes: PDF,
    contentType: "application/pdf",
    assetId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: r.body.document.id }),
  );
  assertEqual((rows[0] as any).linkedAssetId, assetId, "the link is on the row");
});

test("uploads: a fixed asset from another client is refused before the file is kept", async () => {
  const assetId = "AS-UP-0001"; // belongs to clientId
  world.setClientFor(otherClientId);
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "client",
    filename: "cross-tenant-receipt.pdf",
    docType: "receipt",
    bytes: PDF,
    contentType: "application/pdf",
    assetId,
  });
  assertEqual(r.status, 500, `refused: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.error.code, "run_refused", "DOC-RECORD-UPLOAD refused it");
  world.setClientFor(clientId);
});

test("uploads: a loan agreement names a real loan and the link is recorded", async () => {
  const loanId = "LN-UP-0001";
  await seedLoan(world, clientId, loanId);
  const r = await upload(`/api/portal/${clientId}/documents`, {
    token: "client",
    filename: "loan-agreement.pdf",
    docType: "loan_agreement",
    bytes: PDF,
    contentType: "application/pdf",
    loanId,
  });
  assertEqual(r.status, 201, `created: ${JSON.stringify(r.body)}`);
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId, documentId: r.body.document.id }),
  );
  assertEqual((rows[0] as any).linkedLoanId, loanId, "the link is on the row");
});

test("uploads: a loan from another client is refused before the file is kept", async () => {
  const loanId = "LN-UP-0001"; // belongs to clientId
  world.setClientFor(otherClientId);
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "client",
    filename: "cross-tenant-loan.pdf",
    docType: "loan_agreement",
    bytes: PDF,
    contentType: "application/pdf",
    loanId,
  });
  assertEqual(r.status, 500, `refused: ${JSON.stringify(r.body)}`);
  assertEqual(r.body.error.code, "run_refused", "DOC-RECORD-UPLOAD refused it");
  world.setClientFor(clientId);
});

test("uploads: with no period named, retention falls back to the upload day", async () => {
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "owner",
    filename: "no-period.pdf",
    docType: "other",
    bytes: PDF,
    contentType: "application/pdf",
  });
  assertEqual(r.status, 201, "created");
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, otherClientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId: otherClientId, documentId: r.body.document.id }),
  );
  const row = rows[0] as any;
  const today = new Date().toISOString().slice(0, 10);
  assertEqual(row.periodStart, today, "falls back to the upload day");
  assertEqual(row.periodEnd, today, "falls back to the upload day");
  assertEqual(row.retentionStartsOn, today, "retention starts at the fallback period end");
});

test("uploads: a named period sets retention to start there, not the upload day", async () => {
  const r = await upload(`/api/portal/${otherClientId}/documents`, {
    token: "owner",
    filename: "with-period.pdf",
    docType: "bank_statement",
    bytes: PDF,
    contentType: "application/pdf",
    periodEnd: "2023-03-31",
  });
  assertEqual(r.status, 201, "created");
  const rows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, otherClientId), (tx) =>
    tx.query("document_by_id", { firmId: DEV_FIRM_ID, clientId: otherClientId, documentId: r.body.document.id }),
  );
  const row = rows[0] as any;
  assertEqual(row.periodStart, "2023-03-31", "the named period, not the upload day");
  assertEqual(row.periodEnd, "2023-03-31", "the named period, not the upload day");
  assertEqual(row.retentionStartsOn, "2023-03-31", "retention starts at the document's own period end, doc 05 D7");
});

test("uploads: the world stops", async () => {
  await world.close();
});
