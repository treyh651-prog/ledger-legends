const fs = require("fs");
const BASE = process.env.SEED_BASE || "https://playful-longma-d9fd28.netlify.app";
const TOKEN = fs
  .readFileSync(
    "C:\\Users\\treyh\\AppData\\Local\\Temp\\claude\\C--Users-treyh-OneDrive-Desktop-car-app-ALL-CLAUDE\\003a0658-28a5-4cf9-a649-4c05faba039d\\scratchpad\\owner-token.txt",
    "utf8",
  )
  .trim();

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    console.log(`${method} ${path} -> ${res.status}`, JSON.stringify(json).slice(0, 500));
  }
  return { status: res.status, body: json };
}

async function createAndActivate(input) {
  const create = await api("POST", "/api/firm/clients", input);
  if (create.status !== 201) {
    console.log("create failed for", input.name);
    return null;
  }
  const client = create.body.client;
  console.log(`created ${input.name} (${client.id}), tier ${client.engagement.serviceLevel}`);

  const activatePreview = await api("POST", `/api/firm/clients/${client.id}/runs/INTAKE-ACTIVATE-ENGAGEMENT`, {
    mode: "preview",
    scope: {
      engagementId: client.engagement.id,
      signedOutside: { signerName: "Owner", signedOn: input.startDate },
    },
  });
  if (activatePreview.status !== 200 || activatePreview.body.status !== "completed") {
    console.log("activate preview did not complete for", input.name, JSON.stringify(activatePreview.body).slice(0, 300));
    return client;
  }
  const activateApply = await api("POST", `/api/firm/clients/${client.id}/runs/INTAKE-ACTIVATE-ENGAGEMENT`, {
    mode: "apply",
    previewRunId: activatePreview.body.executionId,
    scope: {
      engagementId: client.engagement.id,
      signedOutside: { signerName: "Owner", signedOn: input.startDate },
    },
  });
  console.log(`  activated: ${activateApply.body.status}`);
  return client;
}

async function main() {
  const balloon = await createAndActivate({
    name: "Pop & Fizz Party Supply LLC",
    entityType: "LLC",
    industry: "product",
    startDate: "2026-07-01",
    serviceLevel: "ledger",
    scopeKeys: ["monthly_close", "ap", "ar"],
    monthlyFeeCents: 29900,
  });

  const contractor = await createAndActivate({
    name: "Summit Peak Contracting LLC",
    entityType: "LLC",
    industry: "contractor",
    startDate: "2026-04-01",
    serviceLevel: "ledger_plus",
    scopeKeys: ["monthly_close", "ap", "ar", "form_1099"],
    monthlyFeeCents: 59900,
  });

  const consulting = await createAndActivate({
    name: "Northgate Consulting Group LLC",
    entityType: "LLC",
    industry: "services",
    startDate: "2026-01-01",
    serviceLevel: "legend",
    scopeKeys: ["monthly_close", "ap", "ar", "payroll_je", "form_1099"],
    monthlyFeeCents: 129900,
  });

  console.log(JSON.stringify({ balloon: balloon?.id, contractor: contractor?.id, consulting: consulting?.id }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
