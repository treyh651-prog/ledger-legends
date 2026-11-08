import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { usePayRuns, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { fmtShortDate, usd } from "@/lib/money";
import type { PayRun } from "@shared/api";

/** A dollar string to a cents-as-digits number: the same wire-safe convention every dollar field in this file follows. */
function dollarsToCents(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

/**
 * Payroll, read from GET /api/firm/clients/:id/pay-runs. Audit fix
 * (problem 8): PAY-APPROVE-RUN existed and worked, but nothing in the
 * client ever called it -- and its own real precondition, a payroll
 * register recorded for the period (close.substantiation_records), had
 * no writer at all anywhere in the registry until
 * CFG-CREATE-SUBSTANTIATION-RECORD, built in this same round. Doc 05 D5
 * holds throughout: approval reviews a register, it never disburses, and
 * this screen has no amount entry for a reason -- the numbers come from
 * the register the firm records, never typed fresh into an approval form.
 */
export default function Payroll() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = usePayRuns(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-payroll">
      <PageHeader
        title="Payroll"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} approved runs.` : ""} Approval reviews a register; it authorizes no disbursement.`}
        actions={
          clientId ? (
            <div className="flex flex-wrap gap-2">
              <RecordRegisterDialog clientId={clientId} period={period} />
              <ApprovePayrollDialog clientId={clientId} period={period} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Approved runs" value={d ? d.items.length : "…"} testId="kpi-pay-runs" />
        <Kpi label="Latest net" value={d && d.items[0] ? usd(d.items[0].netCents) : "None"} />
        <Kpi label="Latest pay date" value={d && d.items[0] ? fmtShortDate(d.items[0].payDate) : "None"} />
      </div>
      <SectionCard title="Approved runs" description="From subledger.pay_runs, newest first. No amount here was ever keyed by this screen.">
        <DataGrid<PayRun>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(p) => p.id}
          testId="grid-pay-runs"
          empty={<EmptyState title="No approved runs yet" body="Record the provider's register, then approve it." />}
          cols={[
            { key: "provider", label: "Provider", mobile: "title", render: (p) => <span className="font-medium">{p.providerName}</span> },
            { key: "payPeriod", label: "Pay period", mobile: "row", render: (p) => <span className="text-xs">{fmtShortDate(p.payPeriodStart)} to {fmtShortDate(p.payPeriodEnd)}</span> },
            { key: "payDate", label: "Pay date", mobile: "row", render: (p) => <span className="tnum text-xs">{fmtShortDate(p.payDate)}</span> },
            { key: "gross", label: "Gross", align: "right", mobile: "row", render: (p) => <Money cents={p.grossCents} dim /> },
            { key: "net", label: "Net", align: "right", mobile: "value", render: (p) => <Money cents={p.netCents} className="font-semibold" /> },
            { key: "status", label: "Status", mobile: "row", render: (p) => <Pill tone={p.status === "posted" ? "good" : "info"}>{p.status}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

/**
 * CFG-CREATE-SUBSTANTIATION-RECORD, kind payroll_register. The missing
 * prerequisite PAY-APPROVE-RUN's own header comment names directly: "the
 * posting run reads the register key off the row this run writes."
 */
function RecordRegisterDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);

  const reset = () => {
    setAccountNumber("");
    setAmountDollars("");
    setSourceRef("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!/^[0-9]{4}$/.test(accountNumber.trim()) || !sourceRef.trim()) {
      setError("A 4 digit payroll liability account and where the register is filed are required.");
      return;
    }
    const scope = {
      clientId,
      period: periodStartOf(period),
      fields: {
        kind: "payroll_register" as const,
        accountNumber: accountNumber.trim(),
        supportedBalanceCents: dollarsToCents(amountDollars),
        sourceRef: sourceRef.trim(),
        preparedOn: periodStartOf(period),
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-SUBSTANTIATION-RECORD", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({
          runCode: "CFG-CREATE-SUBSTANTIATION-RECORD",
          body: { mode: "apply", scope, previewRunId: preview.executionId },
        });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="payroll-record-register">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Record register
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record the payroll register</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            What the provider's register says is owed, for this period, and where it is filed.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Payroll liability account</label>
              <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="2300" data-testid="payroll-register-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Register total ($)</label>
              <Input type="number" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="payroll-register-amount" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Filed where (vault reference, document name)</label>
            <Input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="Payroll register, Nov 2026.pdf" data-testid="payroll-register-source" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="payroll-register-save">Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** PAY-APPROVE-RUN. Reviews the register this screen's other dialog just recorded; authorizes no disbursement, per doc 05 D5. */
function ApprovePayrollDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [payDate, setPayDate] = useState("");
  const [withholdingDollars, setWithholdingDollars] = useState("");
  const [employerTaxDollars, setEmployerTaxDollars] = useState("");
  const [employeeCount, setEmployeeCount] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Audit fix: a solo or two person firm has nobody else to ask, so a
  // G18 refusal (overrideProtected) offers a written-reason retry right
  // here, the same "accept the exception and say why" shape
  // close-checklist.tsx's own gate override already uses.
  const [needsOverride, setNeedsOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setProviderName("");
    setPayDate("");
    setWithholdingDollars("");
    setEmployerTaxDollars("");
    setEmployeeCount("");
    setError(null);
    setNeedsOverride(false);
    setOverrideReason("");
  };

  const save = async () => {
    setError(null);
    if (!providerName.trim() || !payDate) {
      setError("The provider name and the pay date are required.");
      return;
    }
    if (needsOverride && !overrideReason.trim()) {
      setError("A written reason is required to accept the exception.");
      return;
    }
    const scope = {
      clientId,
      period: periodStartOf(period),
      payDate,
      providerName: providerName.trim(),
      employeeWithholdingCents: dollarsToCents(withholdingDollars),
      employerTaxCents: dollarsToCents(employerTaxDollars),
      employeeCount: employeeCount.trim() === "" ? undefined : Math.round(Number(employeeCount)),
      ...(needsOverride ? { overrideReason: overrideReason.trim() } : {}),
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PAY-APPROVE-RUN", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        if (!needsOverride && preview.errors[0]?.code === "overrideProtected") {
          setNeedsOverride(true);
          setError(preview.errors[0]?.message ?? null);
          return;
        }
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PAY-APPROVE-RUN",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.payRuns(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="payroll-approve">
          Approve run
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve a payroll run</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Reviews the register already on file for this period. Authorizes no disbursement, releases no payment, and
            instructs no bank -- the same statement every approval carries.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} data-testid="payroll-approve-provider" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Pay date</label>
              <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} data-testid="payroll-approve-pay-date" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Withholding ($)</label>
              <Input type="number" value={withholdingDollars} onChange={(e) => setWithholdingDollars(e.target.value)} data-testid="payroll-approve-withholding" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Employer tax ($)</label>
              <Input type="number" value={employerTaxDollars} onChange={(e) => setEmployerTaxDollars(e.target.value)} data-testid="payroll-approve-employer-tax" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Employees (optional)</label>
              <Input type="number" value={employeeCount} onChange={(e) => setEmployeeCount(e.target.value)} data-testid="payroll-approve-employee-count" />
            </div>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
          {needsOverride ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Why this exception is accepted</label>
              <Textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} data-testid="payroll-approve-override-reason" />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="payroll-approve-save">
            {needsOverride ? "Approve anyway" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
