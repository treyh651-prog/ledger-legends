import { useRef, useState } from "react";
import { CheckCircle2, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadDocument, errorMessage, useUploadDocument, type UploadDocumentArgs } from "@/api";
import { UPLOAD_ACCEPT, UPLOAD_DOC_TYPES, fmtLimit, mimeForFilename } from "@shared/uploads";
import type { PortalDocuments } from "@shared/api";

const STATEMENT_DOC_TYPES: ReadonlySet<string> = new Set(["bank_statement", "card_statement"]);

type LinkField = "bankAccountId" | "vendorId" | "assetId" | "loanId";

/**
 * Which document types offer which "what is this for" picker, and where its
 * options come from. A bank or card statement names an account because the
 * upload route reads a CSV one automatically once the account is named; a
 * bill from a vendor, a receipt, and a loan agreement name the row they
 * support for the same reason linked_transaction_id already lets a coded
 * transaction point back at the document behind it, just reached from the
 * other direction. Nothing else in UPLOAD_DOC_TYPES gets a picker.
 */
const LINK_PICKERS: ReadonlyArray<{
  docTypes: ReadonlySet<string>;
  field: LinkField;
  label: string;
  source: keyof Pick<PortalDocuments, "bankAccounts" | "vendors" | "fixedAssets" | "loans">;
  nameOf: (row: Record<string, unknown>) => string;
}> = [
  { docTypes: STATEMENT_DOC_TYPES, field: "bankAccountId", label: "Which account is this", source: "bankAccounts", nameOf: (r) => String(r.nickname ?? "") },
  { docTypes: new Set(["invoice_ap"]), field: "vendorId", label: "Which vendor is this from", source: "vendors", nameOf: (r) => String(r.legalName ?? "") },
  { docTypes: new Set(["receipt"]), field: "assetId", label: "Which asset is this for", source: "fixedAssets", nameOf: (r) => String(r.description ?? "") },
  { docTypes: new Set(["loan_agreement"]), field: "loanId", label: "Which loan is this for", source: "loans", nameOf: (r) => String(r.lenderName ?? "") },
];

/**
 * The one upload control, used on Send documents and on Your documents, for a
 * client user and for firm staff alike. The server decides who may upload from
 * the session and membership; this control only picks a file, a type, and
 * which row the file is for when the type offers one. States: idle,
 * uploading (button disabled, no second submit), done with the stored name,
 * or a failure sentence from the server. Nothing is staged in the browser; a
 * file either lands in storage with a record or it does not.
 *
 * The picker for a given type appears only when the client has a row to pick
 * from; everything else uploads exactly as it always has. Only the bank and
 * card statement picker changes what happens next (it is what
 * IMPORT-PARSE-FEED reads automatically); the vendor, asset, and loan
 * pickers just record a link, per docs/05 Part 3's "a person links it."
 */
export function UploadDocumentControl({
  clientId,
  data,
  testId = "upload-document",
}: {
  clientId: string;
  data: Pick<PortalDocuments, "storageConfigured" | "storageProvider" | "uploadMaxBytes" | "bankAccounts" | "vendors" | "fixedAssets" | "loans">;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState("bank_statement");
  const [linkId, setLinkId] = useState<string>("");
  const [note, setNote] = useState<{ tone: "good" | "risk"; text: string } | null>(null);
  const upload = useUploadDocument(clientId);
  const busy = upload.isPending;

  const picker = LINK_PICKERS.find((p) => p.docTypes.has(docType));
  const options: ReadonlyArray<Record<string, unknown> & { id: string }> = picker ? data[picker.source] : [];
  const showPicker = !!picker && options.length > 0;
  const selectedLinkId = showPicker ? (linkId && options.some((o) => o.id === linkId) ? linkId : options[0]?.id ?? "") : "";
  const isStatementType = STATEMENT_DOC_TYPES.has(docType);

  const onPick = async (file: File | undefined) => {
    if (!file || busy) return;
    setNote(null);
    if (!mimeForFilename(file.name)) {
      setNote({ tone: "risk", text: "Only PDF, PNG, JPEG, CSV, and Excel files are accepted." });
      return;
    }
    if (file.size > data.uploadMaxBytes) {
      setNote({ tone: "risk", text: `That file is larger than ${fmtLimit(data.uploadMaxBytes)}.` });
      return;
    }
    const linkArgs: Pick<UploadDocumentArgs, "bankAccountId" | "vendorId" | "assetId" | "loanId"> = {
      bankAccountId: null,
      vendorId: null,
      assetId: null,
      loanId: null,
    };
    if (picker && showPicker && selectedLinkId) linkArgs[picker.field] = selectedLinkId;
    try {
      const r = await upload.mutateAsync({ file, docType, ...linkArgs });
      const outcome = r.importOutcome;
      if (outcome?.status === "staged") {
        setNote({ tone: "good", text: `${r.document.title} is on file and staged for review.` });
      } else if (outcome?.status === "needs_mapping") {
        setNote({ tone: "risk", text: `${r.document.title} is on file. Its layout needs to be mapped before it can be read automatically.` });
      } else if (outcome?.status === "not_supported" || outcome?.status === "failed") {
        setNote({ tone: "risk", text: outcome.detail ?? `${r.document.title} is on file, but could not be read automatically.` });
      } else {
        setNote({ tone: "good", text: `${r.document.title} is on file.` });
      }
    } catch (e) {
      setNote({ tone: "risk", text: errorMessage(e) });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (!data.storageConfigured) {
    return (
      <Button size="sm" disabled data-testid={`${testId}-button`} title="Storage is not configured on this server">
        <Upload className="mr-1.5 h-4 w-4" /> Upload a file
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={docType}
          disabled={busy}
          onChange={(e) => {
            setDocType(e.target.value);
            setLinkId("");
          }}
          aria-label="Document type"
          data-testid={`${testId}-type`}
        >
          {UPLOAD_DOC_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {showPicker && picker ? (
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={selectedLinkId}
            disabled={busy}
            onChange={(e) => setLinkId(e.target.value)}
            aria-label={picker.label}
            data-testid={`${testId}-link`}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {picker.nameOf(o)}
              </option>
            ))}
          </select>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => void onPick(e.target.files?.[0])}
          data-testid={`${testId}-input`}
        />
        <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()} data-testid={`${testId}-button`}>
          <Upload className="mr-1.5 h-4 w-4" /> {busy ? "Uploading" : "Upload a file"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-hint`}>
        PDF, PNG, JPEG, CSV or Excel, up to {fmtLimit(data.uploadMaxBytes)}.
        {data.storageProvider === "memory" ? " Development store: files are kept only while this server runs." : ""}
        {showPicker && isStatementType ? " A CSV statement with an account named is read automatically." : ""}
      </p>
      {note ? (
        <p className={`flex items-center gap-1 text-xs ${note.tone === "good" ? "text-emerald-700" : "text-destructive"}`} role="status" data-testid={`${testId}-note`}>
          {note.tone === "good" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

/** One download link per row. Asks the server for the file; nothing is public. */
export function DownloadDocumentLink({ clientId, documentId, title, enabled }: { clientId: string; documentId: string; title: string; enabled: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  if (!enabled) return <span className="text-xs text-muted-foreground">Not available</span>;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        try {
          await downloadDocument(clientId, documentId, title);
          setState("idle");
        } catch {
          setState("failed");
        }
      }}
      data-testid={`download-${documentId}`}
      title={state === "failed" ? "The download did not start. Try again." : "Download"}
    >
      <Download className="h-4 w-4" />
      {state === "failed" ? <span className="ml-1 text-xs text-destructive">Try again</span> : null}
    </Button>
  );
}
