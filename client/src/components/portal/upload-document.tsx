import { useRef, useState } from "react";
import { CheckCircle2, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadDocument, errorMessage, useUploadDocument } from "@/api";
import { UPLOAD_ACCEPT, UPLOAD_DOC_TYPES, fmtLimit, mimeForFilename } from "@shared/uploads";
import type { PortalDocuments } from "@shared/api";

/**
 * The one upload control, used on Send documents and on Your documents, for a
 * client user and for firm staff alike. The server decides who may upload from
 * the session and membership; this control only picks a file and a type.
 * States: idle, uploading (button disabled, no second submit), done with the
 * stored name, or a failure sentence from the server. Nothing is staged in
 * the browser; a file either lands in storage with a record or it does not.
 */
export function UploadDocumentControl({
  clientId,
  data,
  testId = "upload-document",
}: {
  clientId: string;
  data: Pick<PortalDocuments, "storageConfigured" | "storageProvider" | "uploadMaxBytes">;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState("bank_statement");
  const [note, setNote] = useState<{ tone: "good" | "risk"; text: string } | null>(null);
  const upload = useUploadDocument(clientId);
  const busy = upload.isPending;

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
    try {
      const r = await upload.mutateAsync({ file, docType });
      setNote({ tone: "good", text: `${r.document.title} is on file.` });
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
          onChange={(e) => setDocType(e.target.value)}
          aria-label="Document type"
          data-testid={`${testId}-type`}
        >
          {UPLOAD_DOC_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
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
