/**
 * Document upload and download, NOTES 256. Its own world over the memory port
 * with a memory document store, started after portal-routes.ts has stopped its
 * own. The engagement is activated by hand so the documents gate opens.
 *
 * Covered: a client upload, a firm upload for the same client, the list after
 * a fresh read, an authorized download, a client of another business refused,
 * another firm refused, a wrong type, a mismatched body, an oversized body,
 * and a record write that fails after the object was stored.
 */
import { test, assert, assertEqual } from "../../runs/__tests__/harness";
import { DEV_ACTOR, DEV_FIRM_ID } from "../dev-actor";
import { readSession } from "../session";
import { startWorld, call, NEW_CLIENT, type World } from "./routes";
import { createHash } from "node:crypto";
import { createMemoryStorage } from "../../storage/document-storage";

let world: World;
let clientId = "";
let otherClientId = "";
let clientDocId = "";
let firmDocId = "";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function upload(
  path: string,
  opts: { token?: string | null; filename: string; docType: string; bytes: Buffer; contentType?: string; requestId?: string },
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/octet-stream",
    "x-file-name": encodeURIComponent(opts.filename),
    "x-doc-type": opts.docType,
  };
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
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

test("uploads: the world stops", async () => {
  await world.close();
});
