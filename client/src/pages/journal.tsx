import { useMemo, useState } from "react";
import { Lock, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { ACCOUNTS, acct } from "@/data/coa";
import { entriesFor } from "@/data/derive";
import { fmtPeriod, fmtShortDate, parseAmountToCents, usd } from "@/lib/money";
import type { JELine, JournalEntry } from "@/data/types";
import { periodEnd } from "@/data/derive";

interface DraftLine {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

const SOURCE_LABELS: Record<string, string> = {
  opening: "Opening balance",
  bank: "Bank activity",
  invoice: "Customer invoice",
  bill: "Vendor bill",
  payroll: "Payroll",
  manual: "Manual entry",
  depreciation: "Depreciation",
  accrual: "Accrual",
  reversal: "Reversal",
};

export default function Journal() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, postEntry, reverseEntry } = useApp();
  const { toast } = useToast();
  const [scope, setScope] = useState<"period" | "all">("period");
  const [source, setSource] = useState("all");
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<JournalEntry | null>(null);
  const [date, setDate] = useState(periodEnd(period));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { id: "l1", accountId: "", debit: "", credit: "", memo: "" },
    { id: "l2", accountId: "", debit: "", credit: "", memo: "" },
  ]);

  const entries = useMemo(
    () =>
      entriesFor(ds, activeClientId)
        .filter((e) => (scope === "period" ? e.period === period : true))
        .filter((e) => (source === "all" ? true : e.source === source)),
    [ds, activeClientId, scope, period, source],
  );

  const totalDebit = lines.reduce((s, l) => s + parseAmountToCents(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + parseAmountToCents(l.credit), 0);
  const diff = totalDebit - totalCredit;
  const canPost = diff === 0 && totalDebit > 0 && memo.trim().length > 3 && lines.every((l) => !parseAmountToCents(l.debit) || l.accountId) && lines.some((l) => l.accountId);

  const manualCount = entriesFor(ds, activeClientId, (e) => e.source === "manual").length;
  const reversals = entriesFor(ds, activeClientId, (e) => e.source === "reversal").length;

  const resetDraft = () => {
    setMemo("");
    setDate(periodEnd(period));
    setLines([
      { id: "l1", accountId: "", debit: "", credit: "", memo: "" },
      { id: "l2", accountId: "", debit: "", credit: "", memo: "" },
    ]);
  };

  return (
    <>
      <PageHeader
        title="Journal entries"
        subtitle={`Every entry in the ledger for ${activeClient.dba}, whether it came from a bank feed or a person. Posted entries are never edited, they are corrected by reversal.`}
        actions={
          <Button size="sm" onClick={() => setOpen(true)} data-testid="button-new-entry">
            <Plus className="mr-1 h-4 w-4" />
            New entry
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Entries in view" value={entries.length} hint={scope === "period" ? fmtPeriod(period) : "Every period"} testId="kpi-entries" />
        <Kpi label="Posted by hand" value={manualCount} hint="Manual entries on this client" testId="kpi-manual" />
        <Kpi label="Reversals" value={reversals} hint="Corrections, not edits" tone={reversals ? "watch" : "good"} testId="kpi-reversals" />
        <Kpi label="Debits equal credits" value="Always" tone="good" hint="Unbalanced entries cannot be posted" testId="kpi-balance" />
      </div>

      <SectionCard bodyClassName="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-sm border border-border bg-muted p-0.5">
            {(["period", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${scope === s ? "bg-card font-medium" : "text-muted-foreground"}`}
                data-testid={`button-je-scope-${s}`}
              >
                {s === "period" ? fmtPeriod(period) : "Every period"}
              </button>
            ))}
          </div>
          <div className="min-w-[180px] flex-1 sm:max-w-[240px]">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-je-source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every source</SelectItem>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SectionCard>

      <SectionCard bodyClassName="p-0" testId="card-entries">
        <DataGrid
          rows={entries}
          rowKey={(e) => e.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          onRowClick={(e) => setDetail(e)}
          empty={<EmptyState title="No entries match" body="Switch to every period or clear the source filter." />}
          cols={[
            { key: "ref", label: "Reference", mobile: "sub", render: (e) => <span className="tnum text-xs">{e.ref}</span> },
            { key: "date", label: "Date", mobile: "sub", render: (e) => <span className="tnum text-xs">{fmtShortDate(e.date)}</span> },
            {
              key: "memo",
              label: "Memo",
              mobile: "title",
              render: (e) => (
                <div className="min-w-0">
                  <p className="truncate">{e.memo}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {e.lines.length} lines, prepared by {e.createdBy}
                  </p>
                </div>
              ),
            },
            { key: "source", label: "Source", mobile: "row", render: (e) => <Pill>{SOURCE_LABELS[e.source]}</Pill> },
            {
              key: "amount",
              label: "Debits",
              align: "right",
              mobile: "value",
              render: (e) => <Money cents={e.lines.reduce((s, l) => s + l.debit, 0)} />,
            },
            {
              key: "state",
              label: "State",
              align: "right",
              mobile: "row",
              render: (e) => (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {e.reversedBy ? <Pill tone="risk">Reversed</Pill> : null}
                  {e.reversalOf ? <Pill tone="info">Reversal</Pill> : null}
                  <Pill tone="good">
                    <Lock className="h-3 w-3" />
                    Posted
                  </Pill>
                </div>
              ),
            },
          ]}
        />
      </SectionCard>

      {/* entry detail */}
      <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl" data-testid="dialog-entry-detail">
          <DialogHeader>
            <DialogTitle>{detail?.ref}</DialogTitle>
            <DialogDescription>
              {detail?.memo}. Posted {detail ? fmtShortDate(detail.date) : ""} by {detail?.createdBy}.
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Account</th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">Debit</th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-2">
                          <p>
                            {acct(l.accountId).code} {acct(l.accountId).name}
                          </p>
                          {l.klass || l.job ? (
                            <p className="text-xs text-muted-foreground">
                              {[l.klass, l.location, l.job].filter(Boolean).join(", ")}
                            </p>
                          ) : null}
                        </td>
                        <td className="tnum px-3 py-2 text-right">{l.debit ? usd(l.debit) : ""}</td>
                        <td className="tnum px-3 py-2 text-right">{l.credit ? usd(l.credit) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-border bg-muted/40">
                    <tr>
                      <td className="px-3 py-2 text-sm font-semibold">Totals</td>
                      <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(detail.lines.reduce((s, l) => s + l.debit, 0))}</td>
                      <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(detail.lines.reduce((s, l) => s + l.credit, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <DialogFooter className="flex-col gap-2 sm:flex-row">
                {detail.reversedBy ? (
                  <p className="text-xs text-muted-foreground">This entry was already reversed, so the correction is on the books.</p>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      reverseEntry(detail.id);
                      toast({ title: "Reversal posted", description: `${detail.ref} was reversed with a mirrored entry dated today.` });
                      setDetail(null);
                    }}
                    data-testid="button-reverse"
                  >
                    <RotateCcw className="mr-1 h-4 w-4" />
                    Reverse this entry
                  </Button>
                )}
                <Button onClick={() => setDetail(null)} data-testid="button-detail-close">
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* new entry */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetDraft();
        }}
      >
        <DialogContent className="max-w-3xl" data-testid="dialog-new-entry">
          <DialogHeader>
            <DialogTitle>New journal entry</DialogTitle>
            <DialogDescription>
              Debits have to equal credits before the Post button turns on. Once posted, an entry can only be corrected by a reversal.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <div className="space-y-1.5">
              <Label className="text-xs">Date</Label>
              <Input value={date} onChange={(e) => setDate(e.target.value)} className="tnum" data-testid="input-je-date" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Memo</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Accrue July utilities not yet billed" data-testid="input-je-memo" />
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={l.id} className="grid gap-2 sm:grid-cols-[1fr_120px_120px_auto]">
                <Select value={l.accountId} onValueChange={(v) => setLines(lines.map((x) => (x.id === l.id ? { ...x, accountId: v } : x)))}>
                  <SelectTrigger data-testid={`select-line-account-${i}`}>
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNTS.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={l.debit}
                  placeholder="Debit"
                  className="tnum text-right"
                  onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, debit: e.target.value, credit: "" } : x)))}
                  data-testid={`input-line-debit-${i}`}
                />
                <Input
                  value={l.credit}
                  placeholder="Credit"
                  className="tnum text-right"
                  onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, credit: e.target.value, debit: "" } : x)))}
                  data-testid={`input-line-credit-${i}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={lines.length <= 2}
                  onClick={() => setLines(lines.filter((x) => x.id !== l.id))}
                  aria-label="Remove line"
                  data-testid={`button-remove-line-${i}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLines([...lines, { id: `l${Date.now()}`, accountId: "", debit: "", credit: "", memo: "" }])}
              data-testid="button-add-line"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add a line
            </Button>
          </div>

          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm ${
              diff === 0 && totalDebit > 0 ? "border-positive/40 bg-positive-soft" : "border-warning/40 bg-warning-soft"
            }`}
            data-testid="banner-je-balance"
          >
            <div className="flex flex-wrap gap-4">
              <span>
                Debits <span className="tnum font-semibold">{usd(totalDebit)}</span>
              </span>
              <span>
                Credits <span className="tnum font-semibold">{usd(totalCredit)}</span>
              </span>
              <span>
                Out of balance by <span className="tnum font-semibold">{usd(diff)}</span>
              </span>
            </div>
            <span className={canPost ? "font-medium text-positive" : "font-medium text-warning"}>
              {totalDebit === 0
                ? "Enter some amounts"
                : diff !== 0
                  ? "Not balanced yet"
                  : memo.trim().length <= 3
                    ? "Write a memo to finish"
                    : !lines.every((l) => !parseAmountToCents(l.debit) || l.accountId)
                      ? "Pick an account on every line"
                      : "Ready to post"}
            </span>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-je-cancel">
              Cancel
            </Button>
            <Button
              disabled={!canPost}
              onClick={() => {
                const payload: JELine[] = lines
                  .filter((l) => l.accountId && (parseAmountToCents(l.debit) || parseAmountToCents(l.credit)))
                  .map((l) => ({ accountId: l.accountId, debit: parseAmountToCents(l.debit), credit: parseAmountToCents(l.credit), memo: l.memo || undefined }));
                const entry = postEntry({ date, memo, lines: payload });
                toast({ title: "Entry posted", description: `${entry.ref} hit the ledger with ${usd(totalDebit)} on each side.` });
                setOpen(false);
                resetDraft();
              }}
              data-testid="button-je-post"
            >
              Post the entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
