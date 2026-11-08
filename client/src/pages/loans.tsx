import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useApp } from "@/store";
import { useLoans, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { Loan } from "@shared/api";

/**
 * A parsed amortization line, or an error for a row that did not parse.
 * paymentNumber, dueDate, payment, principal, interest, escrow, fees,
 * balanceAfter -- tab or comma separated, dollars not cents. Escrow and
 * fees are 0 for a lender's table that carries neither.
 */
interface ParsedScheduleLine {
  paymentNumber: number;
  dueDate: string;
  paymentCents: number;
  principalCents: number;
  interestCents: number;
  escrowCents: number;
  feesCents: number;
  balanceAfterCents: number;
}

function toCents(dollars: string): number {
  return Math.round(Number(dollars) * 100);
}

/** Returns the parsed lines, or an error naming the first row that failed. */
function parseScheduleText(text: string): { lines: ParsedScheduleLine[] } | { error: string } {
  const rows = text
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length === 0) return { error: "Paste the amortization table first." };
  const lines: ParsedScheduleLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i].split(/\t|,/).map((c) => c.trim());
    if (cols.length < 8) {
      if (i === 0) continue; // a header row with fewer columns than data rows is skipped, not an error
      return { error: `Row ${i + 1} has ${cols.length} columns, expected 8 (payment #, due date, payment, principal, interest, escrow, fees, balance after).` };
    }
    const paymentNumber = Math.round(Number(cols[0]));
    if (!Number.isFinite(paymentNumber) || paymentNumber <= 0) {
      if (i === 0) continue; // a header row
      return { error: `Row ${i + 1}: "${cols[0]}" is not a payment number.` };
    }
    const dueDate = cols[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return { error: `Row ${i + 1}: due date must be YYYY-MM-DD, got "${dueDate}".` };
    }
    const [paymentCents, principalCents, interestCents, escrowCents, feesCents, balanceAfterCents] = [cols[2], cols[3], cols[4], cols[5], cols[6], cols[7]].map(toCents);
    if ([paymentCents, principalCents, interestCents, escrowCents, feesCents, balanceAfterCents].some((v) => !Number.isFinite(v))) {
      return { error: `Row ${i + 1}: every dollar column must be a number.` };
    }
    lines.push({ paymentNumber, dueDate, paymentCents, principalCents, interestCents, escrowCents, feesCents, balanceAfterCents });
  }
  return { lines };
}

/**
 * Audit rerun fix, item 6. CFG-CREATE-LOAN and PER-SPLIT-LOANPAYMENT have
 * existed since the original action audit with zero UI. CFG-CREATE-LOAN's
 * own header comment is explicit that it never computes an amortization
 * table from a rate -- a lender rounds its own way -- so the real table is
 * pasted, not generated, the same "paste a real table, never guess" rule
 * CFG-CREATE-MAPPING-PROFILE and REC-IMPORT-STATEMENT already follow.
 */
export default function Loans() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = useLoans(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const active = d?.items.filter((l) => l.status === "active") ?? [];

  return (
    <div className="space-y-4" data-testid="page-loans">
      <PageHeader
        title="Loans"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} loans.` : ""}`}
        actions={
          clientId ? (
            <div className="flex items-center gap-2">
              <SplitLoanPaymentsButton clientId={clientId} period={period} />
              <CreateLoanDialog clientId={clientId} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Loans" value={d ? d.items.length : "…"} testId="kpi-loans" />
        <Kpi label="Active" value={d ? active.length : "…"} />
        <Kpi label="Original principal" value={d ? usd(active.reduce((sum, l) => sum + l.originalPrincipalCents, 0)) : "…"} />
      </div>
      <SectionCard title="Loans" description="What PER-SPLIT-LOANPAYMENT reads to split a payment into principal, interest, escrow, and fees.">
        <DataGrid<Loan>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(l) => l.id}
          testId="grid-loans"
          empty={<EmptyState title="No loans yet" body="Add a lender's note and amortization table before splitting a payment." />}
          cols={[
            {
              key: "lender",
              label: "Lender",
              mobile: "title",
              render: (l) => (
                <span className="font-medium">
                  {l.lenderName} <span className="text-muted-foreground">({l.loanType})</span>
                </span>
              ),
            },
            { key: "principal", label: "Original principal", mobile: "value", render: (l) => usd(l.originalPrincipalCents) },
            { key: "rate", label: "Rate", mobile: "row", render: (l) => `${(l.annualRateBps / 100).toFixed(2)}%, ${l.rateType}` },
            { key: "schedule", label: "Schedule", mobile: "row", render: (l) => `${l.scheduleLineCount} payments` },
            {
              key: "status",
              label: "Status",
              mobile: "value",
              render: (l) => <Pill tone={l.status === "active" ? "good" : "neutral"}>{l.status.replace(/_/g, " ")}</Pill>,
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function SplitLoanPaymentsButton({ clientId, period }: { clientId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const run = async () => {
    setError(null);
    setMessage(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PER-SPLIT-LOANPAYMENT", body: { mode: "preview", scope } });
      if (preview.status === "no_op") {
        setMessage("Nothing due this period.");
        return;
      }
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PER-SPLIT-LOANPAYMENT",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      setMessage(applied.proposals.length > 0 ? `Split ${applied.proposals.length} payments.` : "Nothing due this period.");
      void qc.invalidateQueries({ queryKey: screenKeys.loans(clientId) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={trigger.isPending} data-testid="split-loan-payments">
        Split loan payments
      </Button>
      {error ? <p className="max-w-xs break-words text-right text-xs text-destructive">{error}</p> : null}
      {message ? <p className="max-w-xs break-words text-right text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

function CreateLoanDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [lenderName, setLenderName] = useState("");
  const [loanType, setLoanType] = useState("");
  const [principalAccountLt, setPrincipalAccountLt] = useState("");
  const [interestAccount, setInterestAccount] = useState("");
  const [originalPrincipalDollars, setOriginalPrincipalDollars] = useState("");
  const [originationDate, setOriginationDate] = useState("");
  const [firstPaymentDate, setFirstPaymentDate] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [annualRatePercent, setAnnualRatePercent] = useState("");
  const [rateType, setRateType] = useState<"fixed" | "variable">("fixed");
  const [scheduleText, setScheduleText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setLenderName("");
    setLoanType("");
    setPrincipalAccountLt("");
    setInterestAccount("");
    setOriginalPrincipalDollars("");
    setOriginationDate("");
    setFirstPaymentDate("");
    setTermMonths("");
    setAnnualRatePercent("");
    setRateType("fixed");
    setScheduleText("");
    setError(null);
  };

  const parsed = parseScheduleText(scheduleText);

  const save = async () => {
    setError(null);
    if (!lenderName.trim() || !loanType.trim()) {
      setError("Lender name and loan type are required.");
      return;
    }
    const accountPattern = /^[0-9]{4}$/;
    if (!accountPattern.test(principalAccountLt) || !accountPattern.test(interestAccount)) {
      setError("Principal and interest accounts must each be a 4 digit account number.");
      return;
    }
    const originalPrincipalCents = Math.round(Number(originalPrincipalDollars) * 100);
    if (!Number.isFinite(originalPrincipalCents) || originalPrincipalCents <= 0) {
      setError("Original principal must be a positive dollar amount.");
      return;
    }
    if (!originationDate || !firstPaymentDate) {
      setError("Origination date and first payment date are both required.");
      return;
    }
    const termMonthsNum = Math.round(Number(termMonths));
    if (!Number.isFinite(termMonthsNum) || termMonthsNum <= 0) {
      setError("Term (months) must be a positive whole number.");
      return;
    }
    const annualRateBps = Math.round(Number(annualRatePercent) * 100);
    if (!Number.isFinite(annualRateBps) || annualRateBps < 0) {
      setError("Annual rate must be 0 or more.");
      return;
    }
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (parsed.lines.length === 0) {
      setError("Paste the lender's amortization table.");
      return;
    }
    const scope = {
      clientId,
      fields: {
        lenderName: lenderName.trim(),
        loanType: loanType.trim(),
        principalAccountLt,
        interestAccount,
        originalPrincipalCents,
        originationDate,
        firstPaymentDate,
        termMonths: termMonthsNum,
        annualRateBps,
        rateType,
        scheduleLines: parsed.lines,
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-LOAN", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-LOAN",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.loans(clientId) });
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
        <Button size="sm" data-testid="loan-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add loan
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a loan</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Lender name</label>
              <Input value={lenderName} onChange={(e) => setLenderName(e.target.value)} data-testid="loan-lender" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Loan type</label>
              <Input value={loanType} onChange={(e) => setLoanType(e.target.value)} placeholder="Equipment note" data-testid="loan-type" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Principal account (long term)</label>
              <Input value={principalAccountLt} onChange={(e) => setPrincipalAccountLt(e.target.value)} placeholder="2700" data-testid="loan-principal-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Interest expense account</label>
              <Input value={interestAccount} onChange={(e) => setInterestAccount(e.target.value)} placeholder="8100" data-testid="loan-interest-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Original principal ($)</label>
              <Input type="number" value={originalPrincipalDollars} onChange={(e) => setOriginalPrincipalDollars(e.target.value)} data-testid="loan-original-principal" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Term (months)</label>
              <Input type="number" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} data-testid="loan-term" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Origination date</label>
              <Input type="date" value={originationDate} onChange={(e) => setOriginationDate(e.target.value)} data-testid="loan-origination-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">First payment date</label>
              <Input type="date" value={firstPaymentDate} onChange={(e) => setFirstPaymentDate(e.target.value)} data-testid="loan-first-payment-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Annual rate (%)</label>
              <Input type="number" value={annualRatePercent} onChange={(e) => setAnnualRatePercent(e.target.value)} data-testid="loan-rate" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Rate type</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={rateType}
                onChange={(e) => setRateType(e.target.value as "fixed" | "variable")}
                data-testid="loan-rate-type"
              >
                <option value="fixed">Fixed</option>
                <option value="variable">Variable</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Amortization table -- paste from the lender, one payment per line: payment #, due date (YYYY-MM-DD), payment, principal, interest, escrow, fees, balance
              after. Tab or comma separated, dollars not cents. A header row is skipped automatically.
            </label>
            <Textarea
              value={scheduleText}
              onChange={(e) => setScheduleText(e.target.value)}
              rows={6}
              className="font-mono text-xs"
              placeholder={"1\t2027-01-01\t500.00\t420.00\t80.00\t0\t0\t9580.00\n2\t2027-02-01\t500.00\t425.00\t75.00\t0\t0\t9155.00"}
              data-testid="loan-schedule-text"
            />
            <p className="text-xs text-muted-foreground">
              {"error" in parsed ? <span className="text-destructive">{parsed.error}</span> : scheduleText.trim() ? `${parsed.lines.length} payments parsed.` : null}
            </p>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="loan-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
