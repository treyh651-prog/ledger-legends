import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useVendors, useBills, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { usd, fmtShortDate } from "@/lib/money";
import type { Bill } from "@shared/api";

/** A dollar string to a cents-as-digits string: AP-CREATE-BILL's own wire shape. */
function dollarsToCentsString(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100).toString() : "0";
}

/**
 * Bills, read from GET /api/firm/clients/:id/bills. Audit fix (problem 8):
 * AP-CREATE-BILL existed and worked, but nothing in the client ever called
 * it -- a firm could code a withdrawal to AP-COLLECTION but had no bill to
 * apply it against, since AP-RECORD-PAYMENT/AP-APPLY-PAYMENTS both need a
 * real, posted bill to resolve the payment onto.
 */
export default function Bills() {
  const { client, clientId } = useActiveClient();
  const vendorsQ = useVendors(clientId);
  const q = useBills(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const vendors = vendorsQ.data?.items.map((v) => ({ id: v.id, name: v.legalName })) ?? [];
  const openCents = (d?.items ?? []).reduce(
    (sum, b) => sum + (b.originalAmountCents + b.freightCents + b.taxCents - b.paidCents - b.discountTakenCents - b.creditsCents),
    0,
  );

  return (
    <div className="space-y-4" data-testid="page-bills">
      <PageHeader
        title="Bills"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} bills.` : ""}`}
        actions={clientId ? <CreateBillDialog clientId={clientId} vendors={vendors} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Bills" value={d ? d.items.length : "…"} testId="kpi-bills" />
        <Kpi label="Open balance" value={d ? usd(openCents) : "…"} />
      </div>
      <SectionCard title="Bills" description="Newest first.">
        <DataGrid<Bill>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(b) => b.id}
          testId="grid-bills"
          empty={<EmptyState title="No bills yet" body="Add a vendor first, then create a bill against them." />}
          cols={[
            { key: "num", label: "Bill #", mobile: "title", render: (b) => <span className="font-medium">{b.billNumber}</span> },
            { key: "vendor", label: "Vendor", mobile: "row", render: (b) => <span className="text-xs">{b.vendorName}</span> },
            { key: "date", label: "Date", mobile: "row", render: (b) => <span className="tnum text-xs">{fmtShortDate(b.billDate)}</span> },
            { key: "due", label: "Due", mobile: "row", render: (b) => <span className="tnum text-xs">{fmtShortDate(b.dueDate)}</span> },
            { key: "amount", label: "Amount", align: "right", mobile: "row", render: (b) => <span className="tnum">{usd(b.originalAmountCents + b.freightCents + b.taxCents)}</span> },
            {
              key: "open",
              label: "Open",
              align: "right",
              mobile: "row",
              render: (b) => <span className="tnum">{usd(b.originalAmountCents + b.freightCents + b.taxCents - b.paidCents - b.discountTakenCents - b.creditsCents)}</span>,
            },
            { key: "status", label: "Status", mobile: "value", render: (b) => <Pill tone={b.status === "paid" ? "good" : b.status === "void" ? "neutral" : b.onHold ? "watch" : "info"}>{b.onHold ? "on hold" : b.status}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function CreateBillDialog({ clientId, vendors }: { clientId: string; vendors: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [freightDollars, setFreightDollars] = useState("");
  const [taxDollars, setTaxDollars] = useState("");
  const [expenseAccount, setExpenseAccount] = useState("");
  const [hasDiscount, setHasDiscount] = useState(false);
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountDays, setDiscountDays] = useState("");
  const [netDays, setNetDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setVendorId(vendors[0]?.id ?? "");
    setBillNumber("");
    setBillDate("");
    setDueDate("");
    setAmountDollars("");
    setFreightDollars("");
    setTaxDollars("");
    setExpenseAccount("");
    setHasDiscount(false);
    setDiscountPercent("");
    setDiscountDays("");
    setNetDays("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!vendorId || !billNumber.trim() || !billDate || !dueDate || !/^[0-9]{4}$/.test(expenseAccount.trim())) {
      setError("A vendor, bill number, both dates, and a 4 digit expense account are required.");
      return;
    }
    if (hasDiscount && (discountPercent.trim() === "" || discountDays.trim() === "" || netDays.trim() === "")) {
      setError("A discount term needs its percent, its days, and the net days, all three.");
      return;
    }
    const scope = {
      clientId,
      vendorId,
      billNumber: billNumber.trim(),
      billDate,
      dueDate,
      amountCents: dollarsToCentsString(amountDollars),
      freightCents: dollarsToCentsString(freightDollars || "0"),
      taxCents: dollarsToCentsString(taxDollars || "0"),
      expenseAccount: expenseAccount.trim(),
      discountBps: hasDiscount ? Math.round(Number(discountPercent) * 100) : null,
      discountDays: hasDiscount ? Math.round(Number(discountDays)) : null,
      netDays: hasDiscount ? Math.round(Number(netDays)) : null,
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "AP-CREATE-BILL", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "AP-CREATE-BILL",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.bills(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="bill-create" disabled={vendors.length === 0}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add bill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a bill</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Vendor</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              data-testid="bill-vendor"
            >
              <option value="" disabled>Choose one</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Bill #</label>
              <Input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} data-testid="bill-number" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Expense account</label>
              <Input value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)} placeholder="6100" data-testid="bill-expense-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Bill date</label>
              <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} data-testid="bill-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Due date</label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} data-testid="bill-due-date" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input type="number" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="bill-amount" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Freight ($)</label>
              <Input type="number" value={freightDollars} onChange={(e) => setFreightDollars(e.target.value)} data-testid="bill-freight" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Tax ($)</label>
              <Input type="number" value={taxDollars} onChange={(e) => setTaxDollars(e.target.value)} data-testid="bill-tax" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hasDiscount} onChange={(e) => setHasDiscount(e.target.checked)} data-testid="bill-has-discount" />
            Early payment discount terms (e.g. 2/10 net 30)
          </label>
          {hasDiscount ? (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Discount %</label>
                <Input type="number" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} placeholder="2" data-testid="bill-discount-percent" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Discount days</label>
                <Input type="number" value={discountDays} onChange={(e) => setDiscountDays(e.target.value)} placeholder="10" data-testid="bill-discount-days" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Net days</label>
                <Input type="number" value={netDays} onChange={(e) => setNetDays(e.target.value)} placeholder="30" data-testid="bill-net-days" />
              </div>
            </div>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="bill-save">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
