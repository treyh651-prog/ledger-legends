import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, FolderOpen, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { DOC_TYPES } from "@/data/labels";
import { PERIODS } from "@/data/seed";
import { fmtBytes, fmtPeriod } from "@/lib/money";

type RowState = "queued" | "uploading" | "ready" | "failed" | "duplicate" | "filed";

interface StagedFile {
  id: string;
  name: string;
  sizeBytes: number;
  docType: string;
  period: string;
  bankAccountId?: string;
  openItemId?: string;
  progress: number;
  state: RowState;
  note?: string;
}

const CLASSIFY: { match: RegExp; type: string }[] = [
  { match: /statement|stmt/i, type: "Bank statement" },
  { match: /card|visa|amex/i, type: "Credit card statement" },
  { match: /receipt|rcpt|img|photo/i, type: "Receipt" },
  { match: /invoice|inv/i, type: "Customer invoice" },
  { match: /bill|vendor/i, type: "Vendor bill" },
  { match: /payroll|adp|gusto/i, type: "Payroll report" },
  { match: /w-?9/i, type: "W-9" },
  { match: /loan|amort/i, type: "Loan statement" },
  { match: /inventory|count/i, type: "Inventory count" },
];

const SAMPLE_FILES = [
  { name: "First Cascade checking statement July 2026.pdf", sizeBytes: 384_112 },
  { name: "Card statement 4412 July.pdf", sizeBytes: 221_804 },
  { name: "Receipt hardware store 08-02.jpg", sizeBytes: 1_804_233 },
  { name: "Payroll register July 2026.pdf", sizeBytes: 98_442 },
];

function classify(name: string) {
  const hit = CLASSIFY.find((c) => c.match.test(name));
  return hit ? hit.type : "Other";
}

export default function PortalUpload() {
  const { ds, activeClient, activeClientId, period, addDocuments, logAudit } = useApp();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rows, setRows] = useState<StagedFile[]>([]);
  const contact = activeClient.contacts[0]?.name || "Client contact";
  const banks = ds.bankAccounts.filter((b) => b.clientId === activeClientId);
  const requests = ds.openItems.filter((o) => o.clientId === activeClientId && o.status !== "accepted");

  const runUpload = useCallback(
    (id: string, willFail: boolean, isDuplicate: boolean) => {
      let pct = 0;
      const timer = setInterval(() => {
        pct += 12 + Math.random() * 18;
        if (pct >= 100) {
          clearInterval(timer);
          setRows((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    progress: 100,
                    state: willFail ? "failed" : isDuplicate ? "duplicate" : "ready",
                    note: willFail
                      ? "The connection dropped before the file finished. Try again."
                      : isDuplicate
                        ? "We already have a file with this name and size for this period."
                        : undefined,
                  }
                : r,
            ),
          );
        } else {
          setRows((prev) => prev.map((r) => (r.id === id ? { ...r, progress: Math.round(pct), state: "uploading" } : r)));
        }
      }, 220);
    },
    [],
  );

  const stage = useCallback(
    (files: { name: string; sizeBytes: number }[], source: "picker" | "drop" | "camera") => {
      const staged = files.map((f, i) => {
        const id = `sf-${Date.now()}-${i}`;
        const docType = classify(f.name);
        const dupe = ds.documents.some((d) => d.clientId === activeClientId && d.name === f.name);
        const fails = /fail|corrupt/i.test(f.name);
        const guessedRequest = requests.find((r) => r.docType === docType);
        return {
          id,
          name: f.name,
          sizeBytes: f.sizeBytes,
          docType,
          period,
          bankAccountId: docType.includes("statement") ? banks[0]?.id : undefined,
          openItemId: guessedRequest?.id,
          progress: 0,
          state: "queued" as RowState,
          note: undefined,
        };
      });
      setRows((prev) => [...staged, ...prev]);
      staged.forEach((s) =>
        runUpload(s.id, /fail|corrupt/i.test(s.name), ds.documents.some((d) => d.clientId === activeClientId && d.name === s.name)),
      );
      if (source === "camera") toast({ title: "Photo added", description: "Check the type and period before you send it." });
    },
    [ds.documents, activeClientId, period, banks, requests, runUpload, toast],
  );

  const onPick = (e: React.ChangeEvent<HTMLInputElement>, source: "picker" | "camera") => {
    const list = Array.from(e.target.files || []).map((f) => ({ name: f.name, sizeBytes: f.size }));
    if (list.length) stage(list, source);
    e.target.value = "";
  };

  const send = () => {
    const ready = rows.filter((r) => r.state === "ready" || r.state === "duplicate");
    if (!ready.length) return;
    addDocuments(
      ready.map((r) => ({ name: r.name, sizeBytes: r.sizeBytes, docType: r.docType, period: r.period, bankAccountId: r.bankAccountId, openItemId: r.openItemId })),
      contact,
      "portal",
    );
    setRows((prev) => prev.map((r) => (r.state === "ready" || r.state === "duplicate" ? { ...r, state: "filed" } : r)));
    toast({
      title: `${ready.length} file${ready.length > 1 ? "s" : ""} sent`,
      description: "Your accountant sees them right away, and the audit trail records who sent what.",
    });
  };

  const readyCount = rows.filter((r) => r.state === "ready" || r.state === "duplicate").length;

  return (
    <>
      <PageHeader
        title="Send documents"
        subtitle="Drop files in, pick them from your device, or snap a photo of a receipt. We guess the type and the month, and you can change either one before sending."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Files staged" value={rows.length} testId="kpi-staged" />
        <Kpi label="Ready to send" value={readyCount} tone={readyCount ? "good" : "neutral"} testId="kpi-ready-send" />
        <Kpi label="Needs another look" value={rows.filter((r) => r.state === "failed" || r.state === "duplicate").length} tone="watch" testId="kpi-attention" />
        <Kpi label="Already sent" value={rows.filter((r) => r.state === "filed").length} testId="kpi-sent" />
      </div>

      <SectionCard testId="card-dropzone" bodyClassName="p-3 sm:p-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const list = Array.from(e.dataTransfer.files || []).map((f) => ({ name: f.name, sizeBytes: f.size }));
            if (list.length) stage(list, "drop");
          }}
          className={`rounded-md border-2 border-dashed p-5 text-center transition-colors sm:p-8 ${
            dragging ? "border-primary bg-primary/5" : "border-border"
          }`}
          data-testid="dropzone"
        >
          <Upload className="mx-auto h-7 w-7 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">Drag files here</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            PDF, images, CSV, and spreadsheets all work. Nothing is shared until you press send.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button size="sm" onClick={() => inputRef.current?.click()} data-testid="button-choose-files">
              <FolderOpen className="mr-1 h-4 w-4" />
              Choose files
            </Button>
            <Button size="sm" variant="outline" onClick={() => cameraRef.current?.click()} data-testid="button-camera">
              <Camera className="mr-1 h-4 w-4" />
              Take a photo
            </Button>
            <Button size="sm" variant="ghost" onClick={() => stage(SAMPLE_FILES, "picker")} data-testid="button-sample-files">
              Use the sample set
            </Button>
          </div>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => onPick(e, "picker")} data-testid="input-file" />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPick(e, "camera")} data-testid="input-camera" />
        </div>
      </SectionCard>

      {rows.length ? (
        <SectionCard
          title="Files in this batch"
          description="Set the type, the month, and the account each one belongs to. We prefill what we can."
          actions={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRows([])} data-testid="button-clear-batch">
                Clear
              </Button>
              <Button size="sm" disabled={!readyCount} onClick={send} data-testid="button-send-files">
                Send {readyCount || ""} to the firm
              </Button>
            </div>
          }
          bodyClassName="p-0"
          testId="card-batch"
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="px-3 py-3 sm:px-4" data-testid={`file-row-${r.id}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[320px]">{r.name}</p>
                      {r.state === "uploading" ? <Pill tone="info">Uploading</Pill> : null}
                      {r.state === "ready" ? (
                        <Pill tone="good">
                          <CheckCircle2 className="h-3 w-3" />
                          Ready
                        </Pill>
                      ) : null}
                      {r.state === "duplicate" ? (
                        <Pill tone="watch">
                          <AlertTriangle className="h-3 w-3" />
                          Possible duplicate
                        </Pill>
                      ) : null}
                      {r.state === "failed" ? <Pill tone="risk">Upload failed</Pill> : null}
                      {r.state === "filed" ? <Pill tone="good">Sent</Pill> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {fmtBytes(r.sizeBytes)}, we think this is a {r.docType.toLowerCase()}
                      {r.openItemId ? ", and it answers a request from your accountant" : ""}
                    </p>
                    {r.note ? <p className={`mt-1 text-xs ${r.state === "failed" ? "text-destructive" : "text-warning"}`}>{r.note}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {r.state === "failed" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label="Try again"
                        onClick={() => {
                          setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, progress: 0, state: "queued", note: undefined } : x)));
                          runUpload(r.id, false, false);
                        }}
                        data-testid={`button-retry-${r.id}`}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Remove file"
                      onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
                      data-testid={`button-remove-${r.id}`}
                    >
                      {r.state === "filed" ? <X className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {r.state === "uploading" || r.state === "queued" ? (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${r.progress}%` }} />
                  </div>
                ) : null}

                {r.state === "ready" || r.state === "duplicate" ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Type</Label>
                      <Select value={r.docType} onValueChange={(v) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, docType: v } : x)))}>
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-type-${r.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DOC_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Month</Label>
                      <Select value={r.period} onValueChange={(v) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, period: v } : x)))}>
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-period-${r.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERIODS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {fmtPeriod(p)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Account</Label>
                      <Select
                        value={r.bankAccountId || "none"}
                        onValueChange={(v) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, bankAccountId: v === "none" ? undefined : v } : x)))}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-account-${r.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not tied to an account</SelectItem>
                          {banks.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.nickname}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">Answers a request</Label>
                      <Select
                        value={r.openItemId || "none"}
                        onValueChange={(v) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, openItemId: v === "none" ? undefined : v } : x)))}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid={`select-request-${r.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Nothing in particular</SelectItem>
                          {requests.map((q) => (
                            <SelectItem key={q.id} value={q.id}>
                              {q.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="How this works" testId="card-how">
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>Every file records who sent it and when, and that record cannot be edited later.</li>
          <li>If a file will not open on our side, we send it back with a reason instead of guessing.</li>
          <li>Statements go straight to the account they belong to, which is what makes the reconciliation quick.</li>
          <li>
            You can always see the full history on the{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => {
                logAudit(undefined, "Document history", "viewed", `${contact} opened the document history`, contact, "portal");
              }}
              data-testid="button-history-note"
            >
              documents page
            </button>
            .
          </li>
        </ul>
      </SectionCard>
    </>
  );
}
