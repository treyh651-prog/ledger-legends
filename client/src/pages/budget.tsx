import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useBudget, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { fmtCompactUsd, fmtPeriod, usd } from "@/lib/money";
import type { BudgetLine } from "@shared/api";

/** The last day of the month `period` (already periodStartOf'd) falls in. */
function periodEndOf(period: string): string {
  const [y, m] = periodStartOf(period).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function dollarsToCents(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const CHART_ACCOUNT_LIMIT = 10;

/**
 * Budget against actual, the accounts with the largest budget first. Two
 * series means a legend; colors are fixed (budget first, actual second) so
 * filtering never repaints which hue means what.
 */
function BudgetVsActualChart({ lines }: { lines: BudgetLine[] }) {
  const top = [...lines].sort((a, b) => Math.abs(b.budgetCents) - Math.abs(a.budgetCents)).slice(0, CHART_ACCOUNT_LIMIT);
  const data = top.map((l) => ({
    name: l.accountNumber,
    full: `${l.accountNumber} ${l.accountName}`,
    budget: l.budgetCents / 100,
    actual: l.actualCents / 100,
  }));
  return (
    <>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={{ stroke: "hsl(var(--border))" }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtCompactUsd(v * 100)} width={56} />
          <Tooltip
            formatter={((value: number, key: string) => [usd(Math.round(value * 100)), key === "budget" ? "Budget" : "Actual"]) as never}
            labelFormatter={((label: string, items: Array<{ payload?: { full?: string } }>) => items?.[0]?.payload?.full ?? label) as never}
            contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: "hsl(var(--foreground))" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={(key: string) => (key === "budget" ? "Budget" : "Actual")} />
          <Bar dataKey="budget" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Bar dataKey="actual" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
      {lines.length > CHART_ACCOUNT_LIMIT ? (
        <p className="mt-1 text-xs text-muted-foreground">Showing the {CHART_ACCOUNT_LIMIT} largest of {lines.length} budgeted accounts. The table below has all of them.</p>
      ) : null}
    </>
  );
}

/**
 * Budget versus actual, read from GET /api/firm/clients/:id/budget. Budget
 * rows are what the firm entered; variance rows are what RPT-COMPUTE-VARIANCES
 * wrote for the period. Until that run has applied the screen says so rather
 * than compute a variance of its own.
 */
export default function Budget() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useBudget(clientId, period);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const tone = (l: BudgetLine) => (!l.flagged ? "good" : l.direction === "unfavorable" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-budget">
      <PageHeader
        title="Budget"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}.`}
        actions={
          clientId ? (
            <div className="flex gap-2">
              <AddThresholdDialog clientId={clientId} />
              <AddBudgetLineDialog clientId={clientId} period={period} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Accounts budgeted" value={d ? d.budgetedAccounts : "…"} testId="kpi-budgeted" />
        <Kpi label="Budget total" value={d ? <Money cents={d.budgetTotalCents} /> : "…"} />
        <Kpi label="Variance lines" value={d ? d.lines.length : "…"} hint={d && d.lines.length === 0 ? "RPT-COMPUTE-VARIANCES has not run for this period" : undefined} />
        <Kpi label="Flagged" value={d ? d.flaggedCount : "…"} tone={d && d.flaggedCount > 0 ? "watch" : "neutral"} />
      </div>
      {d && d.lines.length > 0 ? (
        <SectionCard title="Budget vs actual" description="The largest budgeted accounts, budget beside actual.">
          <BudgetVsActualChart lines={d.lines} />
        </SectionCard>
      ) : null}
      <SectionCard title="Variances" description="One row per account the variance run compared, with the threshold it applied.">
        <DataGrid<BudgetLine>
          rows={d?.lines ?? []}
          loading={q.isPending}
          rowKey={(l) => l.accountNumber}
          testId="grid-variances"
          empty={
            <EmptyState
              title={d && d.budgetedAccounts === 0 ? "No budget for this period" : "No variances computed"}
              body={d && d.budgetedAccounts === 0 ? "Enter or roll forward a budget, then RPT-COMPUTE-VARIANCES compares it to actuals." : "RPT-COMPUTE-VARIANCES writes a row per account when it runs for this period."}
            />
          }
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (l) => <span className="font-medium">{l.accountNumber} {l.accountName}</span> },
            { key: "budget", label: "Budget", align: "right", mobile: "row", render: (l) => <Money cents={l.budgetCents} dim /> },
            { key: "actual", label: "Actual", align: "right", mobile: "row", render: (l) => <Money cents={l.actualCents} /> },
            { key: "var", label: "Variance", align: "right", mobile: "value", render: (l) => <Money cents={l.varianceCents} signed /> },
            { key: "bp", label: "Percent", align: "right", mobile: "row", render: (l) => <span className="tnum text-xs">{l.varianceBp === null ? "" : `${(l.varianceBp / 100).toFixed(1)}%`}</span> },
            { key: "flag", label: "Flag", mobile: "row", render: (l) => <Pill tone={tone(l)}>{l.flagCode.replace(/_/g, " ")}</Pill> },
          ]}
        />
      </SectionCard>
      <SectionCard title="Thresholds" description="Floors and percentages the variance run applies. A null account is the client default.">
        <DataGrid
          rows={d?.thresholds ?? []}
          loading={q.isPending}
          rowKey={(t, i) => `${t.accountNumber ?? "default"}:${i}`}
          testId="grid-thresholds"
          empty={<EmptyState title="No thresholds" body="The variance run uses its stated defaults until the firm enters thresholds." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (t) => <span>{t.accountNumber ?? "Client default"}</span> },
            { key: "floor", label: "Floor", align: "right", mobile: "row", render: (t) => <span className="tnum">{usd(t.varianceFloorCents)}</span> },
            { key: "bp", label: "Percent", align: "right", mobile: "value", render: (t) => <span className="tnum">{(t.varianceThresholdBp / 100).toFixed(1)}%</span> },
            { key: "note", label: "Note", mobile: "row", render: (t) => <span className="text-xs text-muted-foreground">{t.note}</span> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

/**
 * CFG-CREATE-BUDGET-LINES. Audit finding: the run has existed since the
 * original audit campaign's problem 7, but nothing in the client ever
 * called it -- RPT-FLAG-VARIANCES and every report package's variance
 * section always had nothing to compare against. One line per click;
 * the run itself is bulk, but a firm adding its budget one account at a
 * time is the common case and needs no multi row editor to start.
 */
function AddBudgetLineDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setAccountNumber("");
    setAmountDollars("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!/^[0-9]{4}$/.test(accountNumber.trim())) {
      setError("A 4 digit account number is required.");
      return;
    }
    const periodStart = periodStartOf(period);
    const scope = {
      clientId,
      periodStart,
      periodEnd: periodEndOf(period),
      lines: [{ accountNumber: accountNumber.trim(), budgetCents: dollarsToCents(amountDollars) }],
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-BUDGET-LINES", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({ runCode: "CFG-CREATE-BUDGET-LINES", body: { mode: "apply", scope, previewRunId: preview.executionId } });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.budget(clientId, periodStart) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="budget-add-line">Add budget line</Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a budget line for {fmtPeriod(period)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Account</label>
            <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="6100" data-testid="budget-line-account" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Budgeted amount ($)</label>
            <Input type="number" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="budget-line-amount" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="budget-line-save">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * CFG-CREATE-BUDGET-THRESHOLD. Audit finding: RPT-FLAG-VARIANCES has
 * always run against zero thresholds, since nothing ever wrote one --
 * the client default (a blank account) never applied. One row per
 * account, or leave the account blank to set the client's own default.
 */
function AddThresholdDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [floorDollars, setFloorDollars] = useState("");
  const [thresholdPercent, setThresholdPercent] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();
  const { period } = useApp();

  const reset = () => {
    setAccountNumber("");
    setFloorDollars("");
    setThresholdPercent("");
    setNote("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!note.trim()) {
      setError("A note explaining the threshold is required.");
      return;
    }
    const scope = {
      clientId,
      fields: {
        accountNumber: accountNumber.trim() === "" ? null : accountNumber.trim(),
        varianceFloorCents: dollarsToCents(floorDollars),
        varianceThresholdBp: Math.round((Number(thresholdPercent) || 0) * 100),
        note: note.trim(),
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-BUDGET-THRESHOLD", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({ runCode: "CFG-CREATE-BUDGET-THRESHOLD", body: { mode: "apply", scope, previewRunId: preview.executionId } });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.budget(clientId, periodStartOf(period)) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="budget-add-threshold">Add threshold</Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a variance threshold</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Account (blank for the client default)</label>
            <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="6100" data-testid="threshold-account" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Floor ($)</label>
              <Input type="number" value={floorDollars} onChange={(e) => setFloorDollars(e.target.value)} data-testid="threshold-floor" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Threshold (%)</label>
              <Input type="number" value={thresholdPercent} onChange={(e) => setThresholdPercent(e.target.value)} data-testid="threshold-percent" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Note</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="threshold-note" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="threshold-save">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
