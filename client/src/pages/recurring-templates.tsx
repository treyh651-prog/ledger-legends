import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useCategories, useRecurringTemplates, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { RecurringTemplate } from "@shared/api";

const CADENCES = ["monthly", "quarterly", "semi_annual", "annual"] as const;
const CADENCE_LABELS: Record<(typeof CADENCES)[number], string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-annual",
  annual: "Annual",
};

type Basis = "fixed" | "percent" | "remainder";

interface SplitLineState {
  accountNumber: string;
  categoryId: string;
  basis: Basis;
  amountDollars: string;
  percent: string;
}

const EMPTY_LINE: SplitLineState = { accountNumber: "", categoryId: "", basis: "fixed", amountDollars: "", percent: "" };

/**
 * Recurring entries, read from GET /api/firm/clients/:id/recurring-templates.
 * Scoped to generated_entry templates only -- the kind PER-POST-RECURRING
 * posts on a cadence whether or not a bank transaction exists.
 * transaction_match (a template that waits for a matching bank row instead)
 * has no creator yet and is out of scope for this screen.
 */
export default function RecurringTemplates() {
  const { client, clientId } = useActiveClient();
  const q = useRecurringTemplates(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-recurring-templates">
      <PageHeader
        title="Recurring entries"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} templates.` : ""}`}
        actions={clientId ? <CreateRecurringTemplateDialog clientId={clientId} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Templates" value={d ? d.items.length : "…"} testId="kpi-recurring-templates" />
        <Kpi label="Active" value={d ? d.items.filter((t) => t.isActive).length : "…"} />
      </div>
      <SectionCard title="Generated entries" description="PER-POST-RECURRING posts one of these, on its own cadence, whether or not a bank transaction exists.">
        <DataGrid<RecurringTemplate>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(t) => t.id}
          testId="grid-recurring-templates"
          empty={<EmptyState title="No recurring entries yet" body="Rent, insurance, and subscriptions are the common case -- an amount known before the period starts." />}
          cols={[
            { key: "name", label: "Template", mobile: "title", render: (t) => <span className="font-medium">{t.name}</span> },
            { key: "cadence", label: "Cadence", mobile: "row", render: (t) => <Pill tone="neutral">{t.cadence ? CADENCE_LABELS[t.cadence as (typeof CADENCES)[number]] ?? t.cadence : "None"}</Pill> },
            { key: "start", label: "Starts", mobile: "row", render: (t) => <span className="tnum text-xs">{t.startDate}</span> },
            { key: "lines", label: "Split lines", align: "right", mobile: "row", render: (t) => <span className="tnum">{t.splits.length}</span> },
            {
              key: "amount",
              label: "Fixed amount",
              align: "right",
              mobile: "row",
              render: (t) => {
                const fixed = t.splits.find((s) => s.fixedAmountCents != null && s.fixedAmountCents > 0);
                return <span className="tnum text-xs">{fixed ? usd(fixed.fixedAmountCents!) : "None"}</span>;
              },
            },
            { key: "active", label: "Active", mobile: "value", render: (t) => <Pill tone={t.isActive ? "good" : "neutral"}>{t.isActive ? "Active" : "Inactive"}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

/**
 * CFG-CREATE-RECURRING-TEMPLATE. Two split lines by default, the common
 * "one expense, one offsetting account" shape -- "Add another line" grows
 * it for anything bigger. Each line is exactly one of a fixed dollar
 * amount, a percent of the driver amount, or the remainder, matching
 * ledger.recurring_splits' own rec_split_one_basis constraint.
 */
function CreateRecurringTemplateDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("monthly");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [postingDateRule, setPostingDateRule] = useState<"period_end" | "day_n">("period_end");
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [driverAmountDollars, setDriverAmountDollars] = useState("");
  const [entryMemoTemplate, setEntryMemoTemplate] = useState("");
  const [lines, setLines] = useState<SplitLineState[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const categories = useCategories(clientId);
  const qc = useQueryClient();

  const usesPercent = lines.some((l) => l.basis === "percent");

  const reset = () => {
    setName("");
    setCadence("monthly");
    setStartDate("");
    setEndDate("");
    setPostingDateRule("period_end");
    setDayOfMonth("");
    setDriverAmountDollars("");
    setEntryMemoTemplate("");
    setLines([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
    setError(null);
  };

  const updateLine = (index: number, patch: Partial<SplitLineState>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  // A plain number, not bigint: the request body goes through
  // JSON.stringify, which has no bigint and throws before the request is
  // even sent. The run's own scope schema casts to Cents server side.
  const dollarsToCents = (v: string): number | null => {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
  };

  const splitFieldsFor = (l: SplitLineState): Record<string, unknown> | null => {
    if (!l.accountNumber.trim() || !l.categoryId) return null;
    const base = { accountNumber: l.accountNumber.trim(), categoryId: l.categoryId };
    if (l.basis === "remainder") return { ...base, fixedAmountCents: null, percentBps: null, isRemainder: true };
    if (l.basis === "percent") {
      const pct = Number(l.percent);
      if (!Number.isFinite(pct) || pct <= 0) return null;
      return { ...base, fixedAmountCents: null, percentBps: Math.round(pct * 100), isRemainder: false };
    }
    const cents = dollarsToCents(l.amountDollars);
    if (cents === null) return null;
    return { ...base, fixedAmountCents: cents, percentBps: null, isRemainder: false };
  };

  const save = async () => {
    setError(null);
    if (!name.trim() || !startDate.trim()) {
      setError("A name and a start date are required.");
      return;
    }
    const splits = lines.map(splitFieldsFor);
    if (splits.some((s) => s === null)) {
      setError("Every split line needs an account, a category, and its amount, percent, or remainder.");
      return;
    }
    const scope = {
      clientId,
      fields: {
        name: name.trim(),
        cadence,
        startDate: startDate.trim(),
        endDate: endDate.trim() || null,
        postingDateRule,
        dayOfMonth: postingDateRule === "day_n" ? (Number.isInteger(Number(dayOfMonth)) ? Number(dayOfMonth) : null) : null,
        driverAmountCents: usesPercent ? dollarsToCents(driverAmountDollars) : null,
        entryMemoTemplate: entryMemoTemplate.trim() || null,
        splits,
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-RECURRING-TEMPLATE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-RECURRING-TEMPLATE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.recurringTemplates(clientId) });
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
        <Button size="sm" data-testid="recurring-template-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Create recurring entry
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a recurring entry</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office rent" data-testid="recurring-template-name" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Cadence</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}
                data-testid="recurring-template-cadence"
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Start date</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="recurring-template-start" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">End date (optional)</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="recurring-template-end" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Posting day</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={postingDateRule}
                onChange={(e) => setPostingDateRule(e.target.value as "period_end" | "day_n")}
                data-testid="recurring-template-posting-rule"
              >
                <option value="period_end">Last day of the period</option>
                <option value="day_n">A named day of the month</option>
              </select>
            </div>
            {postingDateRule === "day_n" ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Day of month</label>
                <Input type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} data-testid="recurring-template-day-of-month" />
              </div>
            ) : null}
          </div>
          {usesPercent ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Driver amount ($) -- what the percent lines are a share of</label>
              <Input type="number" value={driverAmountDollars} onChange={(e) => setDriverAmountDollars(e.target.value)} data-testid="recurring-template-driver" />
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Memo (optional)</label>
            <Input value={entryMemoTemplate} onChange={(e) => setEntryMemoTemplate(e.target.value)} data-testid="recurring-template-memo" />
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Split lines</span>
              <Button size="sm" variant="outline" onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])} data-testid="recurring-template-add-line">
                <Plus className="mr-1 h-3 w-3" /> Add another line
              </Button>
            </div>
            {lines.map((line, i) => (
              <div key={i} className="space-y-2 rounded-md border border-border/60 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={line.accountNumber}
                    onChange={(e) => updateLine(i, { accountNumber: e.target.value })}
                    placeholder="Account (6100)"
                    data-testid={`recurring-template-line-account-${i}`}
                  />
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={line.categoryId}
                    onChange={(e) => updateLine(i, { categoryId: e.target.value })}
                    data-testid={`recurring-template-line-category-${i}`}
                  >
                    <option value="">Choose a category…</option>
                    {(categories.data?.items ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={line.basis}
                    onChange={(e) => updateLine(i, { basis: e.target.value as Basis })}
                    data-testid={`recurring-template-line-basis-${i}`}
                  >
                    <option value="fixed">Fixed amount ($)</option>
                    <option value="percent">Percent of the driver amount</option>
                    <option value="remainder">Remainder (absorbs the rest)</option>
                  </select>
                  {line.basis === "fixed" ? (
                    <Input
                      type="number"
                      value={line.amountDollars}
                      onChange={(e) => updateLine(i, { amountDollars: e.target.value })}
                      placeholder="$ (negative for a credit)"
                      data-testid={`recurring-template-line-amount-${i}`}
                    />
                  ) : line.basis === "percent" ? (
                    <Input
                      type="number"
                      value={line.percent}
                      onChange={(e) => updateLine(i, { percent: e.target.value })}
                      placeholder="%"
                      data-testid={`recurring-template-line-percent-${i}`}
                    />
                  ) : (
                    <div className="flex items-center text-xs text-muted-foreground">Takes whatever the percent lines do not reach</div>
                  )}
                </div>
                {lines.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                    data-testid={`recurring-template-remove-line-${i}`}
                  >
                    <Trash2 className="mr-1 h-3 w-3" /> Remove line
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="recurring-template-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
