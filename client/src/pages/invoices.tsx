import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useCustomers, useInvoices, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { usd, fmtShortDate } from "@/lib/money";
import type { CreditMemo, Invoice } from "@shared/api";

/** A dollar string to a cents-as-digits string: AR-CREATE-INVOICE's own wire shape. */
function dollarsToCentsString(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100).toString() : "0";
}

/**
 * Invoices and credit memos, read from GET /api/firm/clients/:id/invoices.
 * Audit fix (problem 8): AR-CREATE-INVOICE and AR-CREATE-CREDITMEMO existed
 * and worked, but nothing in the client ever called either one -- a firm
 * could code a deposit to AR-COLLECTION but had no invoice to apply it
 * against, since AR-RECORD-PAYMENT/AR-APPLY-PAYMENTS both need a real,
 * posted invoice to resolve the payment onto.
 */
export default function Invoices() {
  const { client, clientId } = useActiveClient();
  const customersQ = useCustomers(clientId);
  const q = useInvoices(clientId);
  const d = q.data;
  const [tab, setTab] = useState<"invoices" | "credits">("invoices");
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const customers = customersQ.data?.items ?? [];
  const openCents = (d?.invoices ?? []).reduce(
    (sum, i) => sum + (i.originalAmountCents - i.appliedPaymentsCents - i.appliedCreditsCents - i.writtenOffCents),
    0,
  );

  return (
    <div className="space-y-4" data-testid="page-invoices">
      <PageHeader
        title="Invoices"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.invoices.length} invoices, ${d.creditMemos.length} credit memos.` : ""}`}
        actions={
          clientId ? (
            <div className="flex gap-2">
              <CreateCreditMemoDialog clientId={clientId} customers={customers} />
              <CreateInvoiceDialog clientId={clientId} customers={customers} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Invoices" value={d ? d.invoices.length : "…"} testId="kpi-invoices" />
        <Kpi label="Open balance" value={d ? usd(openCents) : "…"} />
        <Kpi label="Credit memos" value={d ? d.creditMemos.length : "…"} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "invoices" | "credits")}>
        <TabsList>
          <TabsTrigger value="invoices" data-testid="tab-invoices">Invoices</TabsTrigger>
          <TabsTrigger value="credits" data-testid="tab-credits">Credit memos</TabsTrigger>
        </TabsList>
        <TabsContent value="invoices" className="mt-4">
          <SectionCard title="Invoices" description="Newest first.">
            <DataGrid<Invoice>
              rows={d?.invoices ?? []}
              loading={q.isPending}
              rowKey={(i) => i.id}
              testId="grid-invoices"
              empty={<EmptyState title="No invoices yet" body="Add a customer first, then create an invoice against them." />}
              cols={[
                { key: "num", label: "Invoice #", mobile: "title", render: (i) => <span className="font-medium">{i.invoiceNumber}</span> },
                { key: "customer", label: "Customer", mobile: "row", render: (i) => <span className="text-xs">{i.customerName}</span> },
                { key: "date", label: "Date", mobile: "row", render: (i) => <span className="tnum text-xs">{fmtShortDate(i.invoiceDate)}</span> },
                { key: "due", label: "Due", mobile: "row", render: (i) => <span className="tnum text-xs">{fmtShortDate(i.dueDate)}</span> },
                { key: "amount", label: "Amount", align: "right", mobile: "row", render: (i) => <span className="tnum">{usd(i.originalAmountCents)}</span> },
                {
                  key: "open",
                  label: "Open",
                  align: "right",
                  mobile: "row",
                  render: (i) => <span className="tnum">{usd(i.originalAmountCents - i.appliedPaymentsCents - i.appliedCreditsCents - i.writtenOffCents)}</span>,
                },
                { key: "status", label: "Status", mobile: "value", render: (i) => <Pill tone={i.status === "paid" ? "good" : i.status === "void" ? "neutral" : "info"}>{i.status.replace(/_/g, " ")}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="credits" className="mt-4">
          <SectionCard title="Credit memos" description="Newest first.">
            <DataGrid<CreditMemo>
              rows={d?.creditMemos ?? []}
              loading={q.isPending}
              rowKey={(m) => m.id}
              testId="grid-credit-memos"
              empty={<EmptyState title="No credit memos yet" body="Issue one against a posted invoice's customer." />}
              cols={[
                { key: "num", label: "Memo #", mobile: "title", render: (m) => <span className="font-medium">{m.memoNumber}</span> },
                { key: "customer", label: "Customer", mobile: "row", render: (m) => <span className="text-xs">{m.customerName}</span> },
                { key: "date", label: "Date", mobile: "row", render: (m) => <span className="tnum text-xs">{fmtShortDate(m.memoDate)}</span> },
                { key: "amount", label: "Amount", align: "right", mobile: "row", render: (m) => <span className="tnum">{usd(m.amountCents)}</span> },
                { key: "applied", label: "Applied", align: "right", mobile: "row", render: (m) => <span className="tnum">{usd(m.appliedCents)}</span> },
                { key: "status", label: "Status", mobile: "value", render: (m) => <Pill tone={m.status === "applied" ? "good" : "info"}>{m.status}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CreateInvoiceDialog({ clientId, customers }: { clientId: string; customers: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [taxDollars, setTaxDollars] = useState("");
  const [revenueAccount, setRevenueAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setCustomerId(customers[0]?.id ?? "");
    setInvoiceNumber("");
    setInvoiceDate("");
    setDueDate("");
    setAmountDollars("");
    setTaxDollars("");
    setRevenueAccount("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!customerId || !invoiceNumber.trim() || !invoiceDate || !dueDate || !/^[0-9]{4}$/.test(revenueAccount.trim())) {
      setError("A customer, invoice number, both dates, and a 4 digit revenue account are required.");
      return;
    }
    const scope = {
      clientId,
      customerId,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      dueDate,
      amountCents: dollarsToCentsString(amountDollars),
      taxCents: dollarsToCentsString(taxDollars || "0"),
      revenueAccount: revenueAccount.trim(),
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "AR-CREATE-INVOICE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "AR-CREATE-INVOICE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.invoices(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="invoice-create" disabled={customers.length === 0}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an invoice</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Customer</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              data-testid="invoice-customer"
            >
              <option value="" disabled>Choose one</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Invoice #</label>
              <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} data-testid="invoice-number" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Revenue account</label>
              <Input value={revenueAccount} onChange={(e) => setRevenueAccount(e.target.value)} placeholder="4000" data-testid="invoice-revenue-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Invoice date</label>
              <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} data-testid="invoice-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Due date</label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} data-testid="invoice-due-date" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input type="number" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="invoice-amount" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Tax ($, included above)</label>
              <Input type="number" value={taxDollars} onChange={(e) => setTaxDollars(e.target.value)} data-testid="invoice-tax" />
            </div>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="invoice-save">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateCreditMemoDialog({ clientId, customers }: { clientId: string; customers: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [memoNumber, setMemoNumber] = useState("");
  const [memoDate, setMemoDate] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [taxDollars, setTaxDollars] = useState("");
  const [revenueAccount, setRevenueAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setCustomerId(customers[0]?.id ?? "");
    setMemoNumber("");
    setMemoDate("");
    setAmountDollars("");
    setTaxDollars("");
    setRevenueAccount("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!customerId || !memoNumber.trim() || !memoDate || !/^[0-9]{4}$/.test(revenueAccount.trim())) {
      setError("A customer, memo number, a date, and a 4 digit revenue account are required.");
      return;
    }
    const scope = {
      clientId,
      customerId,
      memoNumber: memoNumber.trim(),
      memoDate,
      amountCents: dollarsToCentsString(amountDollars),
      taxCents: dollarsToCentsString(taxDollars || "0"),
      revenueAccount: revenueAccount.trim(),
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "AR-CREATE-CREDITMEMO", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "AR-CREATE-CREDITMEMO",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.invoices(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="creditmemo-create" disabled={customers.length === 0}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add credit memo
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a credit memo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Customer</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              data-testid="creditmemo-customer"
            >
              <option value="" disabled>Choose one</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Memo #</label>
              <Input value={memoNumber} onChange={(e) => setMemoNumber(e.target.value)} data-testid="creditmemo-number" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Revenue account</label>
              <Input value={revenueAccount} onChange={(e) => setRevenueAccount(e.target.value)} placeholder="4000" data-testid="creditmemo-revenue-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input type="date" value={memoDate} onChange={(e) => setMemoDate(e.target.value)} data-testid="creditmemo-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input type="number" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="creditmemo-amount" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tax ($, included above)</label>
            <Input type="number" value={taxDollars} onChange={(e) => setTaxDollars(e.target.value)} data-testid="creditmemo-tax" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="creditmemo-save">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
