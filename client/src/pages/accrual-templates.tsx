import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useApp } from "@/store";
import { useAccrualTemplates, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { AccrualTemplate } from "@shared/api";

const KIND_LABEL: Record<AccrualTemplate["accrualKind"], string> = {
  bill_received_not_entered: "Bill received, not entered",
  wages_earned_not_paid: "Wages earned, not paid",
  revenue_earned_not_billed: "Revenue earned, not billed",
  other: "Other",
};

const BASIS_LABEL: Record<AccrualTemplate["basis"], string> = {
  fixed_amount: "Fixed amount",
  from_document: "From a source document",
  daily_rate_x_days: "Daily rate x days",
  percent_of_base: "Percent of a base",
};

function amountSummary(t: AccrualTemplate): string {
  switch (t.basis) {
    case "fixed_amount":
      return t.fixedAmountCents !== null ? usd(t.fixedAmountCents) : "";
    case "from_document":
      return t.sourceDocumentAmountCents !== null ? usd(t.sourceDocumentAmountCents) : "";
    case "daily_rate_x_days":
      return t.dailyRateCents !== null && t.dayCount !== null ? `${usd(t.dailyRateCents)}/day x ${t.dayCount} days` : "";
    case "percent_of_base":
      return t.baseCents !== null && t.percentBps !== null ? `${(t.percentBps / 100).toFixed(2)}% of ${usd(t.baseCents)}` : "";
  }
}

/**
 * Audit rerun fix, item 6. CFG-CREATE-ACCRUAL-TEMPLATE and
 * PER-POST-ACCRUALS have existed since the original action audit with
 * zero UI. The create dialog shows only the companion field(s) the
 * selected basis actually needs -- fixed_amount needs fixedAmountCents,
 * from_document needs sourceDocumentAmountCents, daily_rate_x_days needs
 * dailyRateCents and dayCount, percent_of_base needs baseCents and
 * percentBps -- mirroring per-post-accruals.ts's own amountFor(), the
 * same reasoning the run's own header comment gives for checking this
 * at creation time rather than letting a template sit silently broken.
 */
export default function AccrualTemplates() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = useAccrualTemplates(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const active = d?.items.filter((t) => t.isActive) ?? [];

  return (
    <div className="space-y-4" data-testid="page-accrual-templates">
      <PageHeader
        title="Accrual templates"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} templates.` : ""}`}
        actions={
          clientId ? (
            <div className="flex items-center gap-2">
              <PostAccrualsButton clientId={clientId} period={period} />
              <CreateAccrualTemplateDialog clientId={clientId} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Templates" value={d ? d.items.length : "…"} testId="kpi-templates" />
        <Kpi label="Active" value={d ? active.length : "…"} />
      </div>
      <SectionCard title="Templates" description="What PER-POST-ACCRUALS reads to post a bill received, wages earned, or revenue earned but not yet booked.">
        <DataGrid<AccrualTemplate>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(t) => t.id}
          testId="grid-accrual-templates"
          empty={<EmptyState title="No accrual templates yet" body="Add a recurring period end accrual before posting one." />}
          cols={[
            { key: "name", label: "Name", mobile: "title", render: (t) => <span className="font-medium">{t.name}</span> },
            { key: "kind", label: "Kind", mobile: "row", render: (t) => KIND_LABEL[t.accrualKind] },
            { key: "basis", label: "Basis", mobile: "row", render: (t) => `${BASIS_LABEL[t.basis]}${amountSummary(t) ? `, ${amountSummary(t)}` : ""}` },
            { key: "reverse", label: "Auto reverse", mobile: "value", render: (t) => (t.autoReverse ? "Yes" : "No") },
            { key: "active", label: "Active", mobile: "value", render: (t) => <Pill tone={t.isActive ? "good" : "neutral"}>{t.isActive ? "Active" : "Inactive"}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function PostAccrualsButton({ clientId, period }: { clientId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const run = async () => {
    setError(null);
    setMessage(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PER-POST-ACCRUALS", body: { mode: "preview", scope } });
      if (preview.status === "no_op") {
        setMessage("Nothing to accrue this period.");
        return;
      }
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PER-POST-ACCRUALS",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      setMessage(applied.proposals.length > 0 ? `Posted ${applied.proposals.length} accruals.` : "Nothing to accrue this period.");
      void qc.invalidateQueries({ queryKey: screenKeys.accrualTemplates(clientId) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={trigger.isPending} data-testid="post-accruals">
        Post accruals
      </Button>
      {error ? <p className="max-w-xs break-words text-right text-xs text-destructive">{error}</p> : null}
      {message ? <p className="max-w-xs break-words text-right text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

function CreateAccrualTemplateDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accrualKind, setAccrualKind] = useState<AccrualTemplate["accrualKind"]>("bill_received_not_entered");
  const [basis, setBasis] = useState<AccrualTemplate["basis"]>("fixed_amount");
  const [debitAccount, setDebitAccount] = useState("");
  const [creditAccount, setCreditAccount] = useState("");
  const [entryMemo, setEntryMemo] = useState("");
  const [autoReverse, setAutoReverse] = useState(true);
  const [fixedAmountDollars, setFixedAmountDollars] = useState("");
  const [sourceDocumentAmountDollars, setSourceDocumentAmountDollars] = useState("");
  const [dailyRateDollars, setDailyRateDollars] = useState("");
  const [dayCount, setDayCount] = useState("");
  const [baseDollars, setBaseDollars] = useState("");
  const [percentOfBase, setPercentOfBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setName("");
    setAccrualKind("bill_received_not_entered");
    setBasis("fixed_amount");
    setDebitAccount("");
    setCreditAccount("");
    setEntryMemo("");
    setAutoReverse(true);
    setFixedAmountDollars("");
    setSourceDocumentAmountDollars("");
    setDailyRateDollars("");
    setDayCount("");
    setBaseDollars("");
    setPercentOfBase("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!name.trim() || !entryMemo.trim()) {
      setError("Name and entry memo are both required.");
      return;
    }
    const accountPattern = /^[0-9]{4}$/;
    if (!accountPattern.test(debitAccount) || !accountPattern.test(creditAccount)) {
      setError("Debit and credit accounts must each be a 4 digit account number.");
      return;
    }
    const fields: Record<string, unknown> = {
      name: name.trim(),
      accrualKind,
      basis,
      debitAccount,
      creditAccount,
      entryMemo: entryMemo.trim(),
      autoReverse,
    };
    if (basis === "fixed_amount") {
      const cents = Math.round(Number(fixedAmountDollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        setError("A fixed amount is required for this basis.");
        return;
      }
      fields.fixedAmountCents = cents;
    }
    if (basis === "from_document") {
      const cents = Math.round(Number(sourceDocumentAmountDollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        setError("A source document amount is required for this basis.");
        return;
      }
      fields.sourceDocumentAmountCents = cents;
    }
    if (basis === "daily_rate_x_days") {
      const rateCents = Math.round(Number(dailyRateDollars) * 100);
      const days = Math.round(Number(dayCount));
      if (!Number.isFinite(rateCents) || rateCents <= 0 || !Number.isFinite(days) || days <= 0) {
        setError("A daily rate and a day count are both required for this basis.");
        return;
      }
      fields.dailyRateCents = rateCents;
      fields.dayCount = days;
    }
    if (basis === "percent_of_base") {
      const baseCents = Math.round(Number(baseDollars) * 100);
      const percentBps = Math.round(Number(percentOfBase) * 100);
      if (!Number.isFinite(baseCents) || baseCents <= 0 || !Number.isFinite(percentBps) || percentBps <= 0) {
        setError("A base amount and a percent are both required for this basis.");
        return;
      }
      fields.baseCents = baseCents;
      fields.percentBps = percentBps;
    }
    const scope = { clientId, fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-ACCRUAL-TEMPLATE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-ACCRUAL-TEMPLATE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.accrualTemplates(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" data-testid="accrual-template-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an accrual template</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Contractor invoice not yet entered" data-testid="accrual-name" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Kind</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={accrualKind}
                onChange={(e) => setAccrualKind(e.target.value as AccrualTemplate["accrualKind"])}
                data-testid="accrual-kind"
              >
                {Object.entries(KIND_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Debit account</label>
              <Input value={debitAccount} onChange={(e) => setDebitAccount(e.target.value)} placeholder="6100" data-testid="accrual-debit-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Credit account</label>
              <Input value={creditAccount} onChange={(e) => setCreditAccount(e.target.value)} placeholder="2200" data-testid="accrual-credit-account" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Entry memo</label>
            <Input value={entryMemo} onChange={(e) => setEntryMemo(e.target.value)} data-testid="accrual-memo" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} data-testid="accrual-auto-reverse" />
            Reverse automatically next period
          </label>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Basis</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={basis}
              onChange={(e) => setBasis(e.target.value as AccrualTemplate["basis"])}
              data-testid="accrual-basis"
            >
              {Object.entries(BASIS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {basis === "fixed_amount" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Fixed amount ($)</label>
              <Input type="number" value={fixedAmountDollars} onChange={(e) => setFixedAmountDollars(e.target.value)} data-testid="accrual-fixed-amount" />
            </div>
          ) : null}
          {basis === "from_document" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Source document amount ($)</label>
              <Input type="number" value={sourceDocumentAmountDollars} onChange={(e) => setSourceDocumentAmountDollars(e.target.value)} data-testid="accrual-doc-amount" />
            </div>
          ) : null}
          {basis === "daily_rate_x_days" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Daily rate ($)</label>
                <Input type="number" value={dailyRateDollars} onChange={(e) => setDailyRateDollars(e.target.value)} data-testid="accrual-daily-rate" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Day count</label>
                <Input type="number" value={dayCount} onChange={(e) => setDayCount(e.target.value)} data-testid="accrual-day-count" />
              </div>
            </div>
          ) : null}
          {basis === "percent_of_base" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Base amount ($)</label>
                <Input type="number" value={baseDollars} onChange={(e) => setBaseDollars(e.target.value)} data-testid="accrual-base-amount" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Percent (%)</label>
                <Input type="number" value={percentOfBase} onChange={(e) => setPercentOfBase(e.target.value)} data-testid="accrual-percent" />
              </div>
            </div>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="accrual-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
