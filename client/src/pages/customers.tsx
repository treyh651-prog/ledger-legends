import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useCustomers, useTriggerRun, errorMessage, screenKeys } from "@/api";
import type { Customer } from "@shared/api";

/**
 * Customers, read from GET /api/firm/clients/:id/customers. Audit fix
 * (problem 8): AR-CREATE-CUSTOMER existed and worked since early in this
 * engagement, but nothing in the client ever called it -- a firm had no
 * way to put a single real customer on the books, which also meant
 * AR-CREATE-INVOICE (needs a real customerId) was unreachable from the UI
 * too. No edit run exists yet for a customer's own fields, so this screen
 * is create-only, same as AP-CREATE-VENDOR's own sibling screen.
 */
export default function Customers() {
  const { client, clientId } = useActiveClient();
  const q = useCustomers(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-customers">
      <PageHeader
        title="Customers"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} customers.` : ""}`}
        actions={clientId ? <CreateCustomerDialog clientId={clientId} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Customers" value={d ? d.items.length : "…"} testId="kpi-customers" />
        <Kpi label="Active" value={d ? d.items.filter((c) => c.isActive).length : "…"} />
      </div>
      <SectionCard title="Customers" description="Who AR-CREATE-INVOICE and AR-RECORD-PAYMENT bill and collect from.">
        <DataGrid<Customer>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(c) => c.id}
          testId="grid-customers"
          empty={<EmptyState title="No customers yet" body="Add a customer before creating an invoice against them." />}
          cols={[
            { key: "name", label: "Customer", mobile: "title", render: (c) => <span className="font-medium">{c.name}</span> },
            {
              key: "latefee",
              label: "Late fee",
              mobile: "row",
              render: (c) =>
                c.lateFeeEnabled ? (
                  <span className="text-xs">
                    {c.annualizedRateBp != null ? `${(c.annualizedRateBp / 100).toFixed(2)}%/yr` : ""}
                    {c.graceDays != null ? `, ${c.graceDays}d grace` : ""}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Off</span>
                ),
            },
            {
              key: "pursue",
              label: "",
              mobile: "row",
              render: (c) => (c.doNotPursue ? <Pill tone="watch">Do not pursue</Pill> : null),
            },
            { key: "active", label: "Active", mobile: "value", render: (c) => <Pill tone={c.isActive ? "good" : "neutral"}>{c.isActive ? "Active" : "Inactive"}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function CreateCustomerDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [lateFeeEnabled, setLateFeeEnabled] = useState(false);
  const [annualRatePercent, setAnnualRatePercent] = useState("");
  const [graceDays, setGraceDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setName("");
    setLateFeeEnabled(false);
    setAnnualRatePercent("");
    setGraceDays("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError("A name is required.");
      return;
    }
    const rate = Number(annualRatePercent);
    const scope = {
      clientId,
      name: name.trim(),
      lateFeeEnabled,
      annualizedRateBp: lateFeeEnabled && annualRatePercent.trim() !== "" && Number.isFinite(rate) ? Math.round(rate * 100) : null,
      graceDays: lateFeeEnabled && graceDays.trim() !== "" ? Math.round(Number(graceDays)) : null,
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "AR-CREATE-CUSTOMER", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "AR-CREATE-CUSTOMER",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.customers(clientId) });
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
        <Button size="sm" data-testid="customer-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add customer
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="customer-name" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={lateFeeEnabled} onChange={(e) => setLateFeeEnabled(e.target.checked)} data-testid="customer-latefee-enabled" />
            Late fees apply to this customer
          </label>
          {lateFeeEnabled ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Annual rate (%)</label>
                <Input type="number" value={annualRatePercent} onChange={(e) => setAnnualRatePercent(e.target.value)} data-testid="customer-rate" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Grace days</label>
                <Input type="number" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} data-testid="customer-grace-days" />
              </div>
            </div>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="customer-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
