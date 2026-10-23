/**
 * Upload limits, shared by the browser (early refusal) and the server (the
 * refusal that counts). The server never trusts the browser's check.
 */

export const UPLOAD_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Content type by extension. Only these five kinds are accepted. */
export const UPLOAD_TYPES: ReadonlyArray<{ ext: string; mime: string; label: string }> = [
  { ext: "pdf", mime: "application/pdf", label: "PDF" },
  { ext: "png", mime: "image/png", label: "PNG" },
  { ext: "jpg", mime: "image/jpeg", label: "JPEG" },
  { ext: "jpeg", mime: "image/jpeg", label: "JPEG" },
  { ext: "csv", mime: "text/csv", label: "CSV" },
  { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel" },
];

export const UPLOAD_ACCEPT = UPLOAD_TYPES.map((t) => `.${t.ext}`).join(",");

/** Document types a person may choose when sending a file. The engine's own types (engagement_letter and so on) are not offered. */
export const UPLOAD_DOC_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "bank_statement", label: "Bank statement" },
  { id: "card_statement", label: "Card statement" },
  { id: "receipt", label: "Receipt" },
  { id: "invoice_ap", label: "Bill from a vendor" },
  { id: "invoice_ar", label: "Invoice to a customer" },
  { id: "processor_statement", label: "Processor statement" },
  { id: "payroll_report", label: "Payroll report" },
  { id: "loan_agreement", label: "Loan agreement" },
  { id: "lease", label: "Lease" },
  { id: "insurance_policy", label: "Insurance policy" },
  { id: "formation_document", label: "Formation document" },
  { id: "correspondence", label: "Correspondence" },
  { id: "other", label: "Other" },
];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** The content type the extension says, or null when the extension is not accepted. */
export function mimeForFilename(filename: string): string | null {
  const ext = extensionOf(filename);
  return UPLOAD_TYPES.find((t) => t.ext === ext)?.mime ?? null;
}

/** A filename safe for an object key: no path separators, no control characters, bounded length. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  const bounded = cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
  return bounded.length > 0 ? bounded : "file";
}

export function fmtLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
