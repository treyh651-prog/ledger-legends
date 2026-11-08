import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useApp } from "@/store";
import { useDeferralSchedules, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { DeferralSchedule } from "@shared/api";

const KIND_LABEL: Record<DeferralSchedule["kind"], string> = {
  prepaid: "Prepaid",
  intangible_amortization: "Intangible amortization",
  deferred_revenue: "Deferred revenue",
  accrual: "Stored accrual",
};

/**
 * Audit rerun fix, item 6. CFG-CREATE-DEFERRAL-SCHEDULE and
 * PER-AMORTIZE-PREPAIDS have existed since the original action audit
 * with zero UI. CFG-CREATE-DEFERRAL-SCHEDULE writes the header only --
 * PER-AMORTIZE-PREPAIDS builds its own allocation lines lazily the first
 * time it runs for a schedule, per that run's own header comment, so
 * this screen has nothing to show for the line-by-line table and no
 * reason to try.
 */
export default function DeferralSchedules() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = useDeferralSchedules(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const active = d?.items.filter((s) => s.status === "active") ?? [];

  return (
    <div className="space-y-4" data-testid="page-deferral-schedules">
      <PageHeader
        title="Prepaid and deferral schedules"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} schedules.` : ""}`}
        actions={
          clientId ? (
            <div className="flex items-center gap-2">
              <AmortizePrepaidsButton clientId={clientId} period={period} />
              <CreateDeferralScheduleDialog clientId={clientId} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Schedules" value={d ? d.items.length : "…"} testId="kpi-schedules" />
        <Kpi label="Active" value={d ? active.length : "…"} />
        <Kpi label="Total" value={d ? usd(active.reduce((sum, s) => sum + s.totalCents, 0)) : "…"} />
      </div>
      <SectionCard title="Schedules" description="What PER-AMORTIZE-PREPAIDS reads, and builds its own allocation lines against the first time it runs each one.">
        <DataGrid<DeferralSchedule>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(s) => s.id}
          testId="grid-deferral-schedules"
          empty={<EmptyState title="No schedules yet" body="Add a prepaid policy, intangible, or deferred revenue contract before amortizing it." />}
          cols={[
            { key: "description", label: "Description", mobile: "title", render: (s) => <span className="font-medium">{s.description}</span> },
            { key: "kind", label: "Kind", mobile: "row", render: (s) => KIND_LABEL[s.kind] },
            { key: "total", label: "Total", mobile: "value", render: (s) => usd(s.totalCents) },
            { key: "window", label: "Service window", mobile: "row", render: (s) => `${s.serviceStart} to ${s.serviceEnd}` },
            { key: "method", label: "Method", mobile: "row", render: (s) => s.method.replace(/_/g, " ") },
            {
              key: "status",
              label: "Status",
              mobile: "value",
              render: (s) => <Pill tone={s.status === "active" ? "good" : "neutral"}>{s.status}</Pill>,
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function AmortizePrepaidsButton({ clientId, period }: { clientId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const run = async () => {
    setError(null);
    setMessage(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PER-AMORTIZE-PREPAID", body: { mode: "preview", scope } });
      if (preview.status === "no_op") {
        setMessage("Nothing to amortize this period.");
        return;
      }
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PER-AMORTIZE-PREPAID",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      setMessage(applied.proposals.length > 0 ? `Amortized ${applied.proposals.length} schedules.` : "Nothing to amortize this period.");
      void qc.invalidateQueries({ queryKey: screenKeys.deferralSchedules(clientId) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={trigger.isPending} data-testid="amortize-prepaids">
        Amortize prepaids
      </Button>
      {error ? <p className="max-w-xs break-words text-right text-xs text-destructive">{error}</p> : null}
      {message ? <p className="max-w-xs break-words text-right text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

function CreateDeferralScheduleDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DeferralSchedule["kind"]>("prepaid");
  const [description, setDescription] = useState("");
  const [balanceAccount, setBalanceAccount] = useState("");
  const [releaseAccount, setReleaseAccount] = useState("");
  const [accumAccount, setAccumAccount] = useState("");
  const [totalDollars, setTotalDollars] = useState("");
  const [serviceStart, setServiceStart] = useState("");
  const [serviceEnd, setServiceEnd] = useState("");
  const [method, setMethod] = useState<DeferralSchedule["method"]>("straight_line_monthly");
  const [periods, setPeriods] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setKind("prepaid");
    setDescription("");
    setBalanceAccount("");
    setReleaseAccount("");
    setAccumAccount("");
    setTotalDollars("");
    setServiceStart("");
    setServiceEnd("");
    setMethod("straight_line_monthly");
    setPeriods("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!description.trim()) {
      setError("A description is required.");
      return;
    }
    const accountPattern = /^[0-9]{4}$/;
    if (!accountPattern.test(balanceAccount) || !accountPattern.test(releaseAccount)) {
      setError("Balance and release accounts must each be a 4 digit account number.");
      return;
    }
    if (accumAccount.trim() && !accountPattern.test(accumAccount.trim())) {
      setError("Accumulated account must be a 4 digit account number, or left blank.");
      return;
    }
    const totalCents = Math.round(Number(totalDollars) * 100);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      setError("Total must be a positive dollar amount.");
      return;
    }
    if (!serviceStart || !serviceEnd) {
      setError("Service start and service end are both required.");
      return;
    }
    const periodsNum = Math.round(Number(periods));
    if (!Number.isFinite(periodsNum) || periodsNum <= 0) {
      setError("Periods must be a positive whole number.");
      return;
    }
    const fields: Record<string, unknown> = {
      kind,
      description: description.trim(),
      balanceAccount,
      releaseAccount,
      totalCents,
      serviceStart,
      serviceEnd,
      method,
      periods: periodsNum,
    };
    if (accumAccount.trim()) fields.accumAccount = accumAccount.trim();
    const scope = { clientId, fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-DEFERRAL-SCHEDULE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-DEFERRAL-SCHEDULE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.deferralSchedules(clientId) });
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
        <Button size="sm" data-testid="schedule-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a prepaid or deferral schedule</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Kind</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as DeferralSchedule["kind"])}
                data-testid="schedule-kind"
              >
                {Object.entries(KIND_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Annual liability insurance" data-testid="schedule-description" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Balance account</label>
              <Input value={balanceAccount} onChange={(e) => setBalanceAccount(e.target.value)} placeholder="1300" data-testid="schedule-balance-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Release account</label>
              <Input value={releaseAccount} onChange={(e) => setReleaseAccount(e.target.value)} placeholder="6700" data-testid="schedule-release-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Accumulated account (optional)</label>
              <Input value={accumAccount} onChange={(e) => setAccumAccount(e.target.value)} data-testid="schedule-accum-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Total ($)</label>
              <Input type="number" value={totalDollars} onChange={(e) => setTotalDollars(e.target.value)} data-testid="schedule-total" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Periods</label>
              <Input type="number" value={periods} onChange={(e) => setPeriods(e.target.value)} data-testid="schedule-periods" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Service start</label>
              <Input type="date" value={serviceStart} onChange={(e) => setServiceStart(e.target.value)} data-testid="schedule-service-start" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Service end</label>
              <Input type="date" value={serviceEnd} onChange={(e) => setServiceEnd(e.target.value)} data-testid="schedule-service-end" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Method</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value as DeferralSchedule["method"])}
              data-testid="schedule-method"
            >
              <option value="straight_line_monthly">Straight line, monthly (every whole month equal)</option>
              <option value="straight_line_daily">Straight line, daily (every slice weighted by days)</option>
              <option value="custom">Custom (not supported yet, refused)</option>
            </select>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="schedule-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
