import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useVendors, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { fmtShortDate } from "@/lib/money";
import type { Vendor } from "@shared/api";

const ENTITY_TYPES = [
  "individual",
  "sole_proprietor",
  "partnership",
  "llc",
  "c_corporation",
  "s_corporation",
  "government",
  "tax_exempt",
  "unknown",
] as const;

/**
 * Vendors, read from GET /api/firm/clients/:id/vendors. Audit fix
 * (problem 8): AP-CREATE-VENDOR existed and worked, but nothing in the
 * client ever called it, which also meant AP-CREATE-BILL (needs a real
 * vendorId) and the 1099/W9 runs (need a real vendor row with entityType
 * and w9OnFile stated) were unreachable from the UI too. No edit run
 * exists yet for a vendor's own fields, so this screen is create-only.
 */
export default function Vendors() {
  const { client, clientId } = useActiveClient();
  const q = useVendors(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-vendors">
      <PageHeader
        title="Vendors"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} vendors.` : ""}`}
        actions={clientId ? <CreateVendorDialog clientId={clientId} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Vendors" value={d ? d.items.length : "…"} testId="kpi-vendors" />
        <Kpi label="W-9 on file" value={d ? d.items.filter((v) => v.w9OnFile).length : "…"} />
      </div>
      <SectionCard title="Vendors" description="Who AP-CREATE-BILL and AP-RECORD-PAYMENT pay.">
        <DataGrid<Vendor>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(v) => v.id}
          testId="grid-vendors"
          empty={<EmptyState title="No vendors yet" body="Add a vendor before creating a bill against them." />}
          cols={[
            { key: "name", label: "Vendor", mobile: "title", render: (v) => <span className="font-medium">{v.legalName}</span> },
            { key: "entity", label: "Entity type", mobile: "row", render: (v) => <span className="text-xs">{v.entityType.replace(/_/g, " ")}</span> },
            {
              key: "w9",
              label: "W-9",
              mobile: "row",
              render: (v) =>
                v.w9OnFile ? (
                  <Pill tone="good">On file{v.w9ExpiresOn ? ` to ${fmtShortDate(v.w9ExpiresOn)}` : ""}</Pill>
                ) : (
                  <Pill tone="watch">Missing</Pill>
                ),
            },
            { key: "active", label: "Active", mobile: "value", render: (v) => <Pill tone={v.isActive ? "good" : "neutral"}>{v.isActive ? "Active" : "Inactive"}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function CreateVendorDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [entityType, setEntityType] = useState<(typeof ENTITY_TYPES)[number]>("unknown");
  const [earlyDiscountRule, setEarlyDiscountRule] = useState<"" | "purchase_discount_income" | "vendor_credit">("");
  const [tinLast4, setTinLast4] = useState("");
  const [w9OnFile, setW9OnFile] = useState(false);
  const [w9ExpiresOn, setW9ExpiresOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setLegalName("");
    setEntityType("unknown");
    setEarlyDiscountRule("");
    setTinLast4("");
    setW9OnFile(false);
    setW9ExpiresOn("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!legalName.trim()) {
      setError("A legal name is required.");
      return;
    }
    if (tinLast4.trim() !== "" && !/^[0-9]{4}$/.test(tinLast4.trim())) {
      setError("The last four of the TIN must be exactly four digits.");
      return;
    }
    const scope = {
      clientId,
      legalName: legalName.trim(),
      earlyDiscountRule: earlyDiscountRule === "" ? null : earlyDiscountRule,
      tinLast4: tinLast4.trim() === "" ? null : tinLast4.trim(),
      entityType,
      w9OnFile,
      w9ExpiresOn: w9OnFile && w9ExpiresOn.trim() !== "" ? w9ExpiresOn.trim() : null,
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "AP-CREATE-VENDOR", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "AP-CREATE-VENDOR",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.vendors(clientId) });
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
        <Button size="sm" data-testid="vendor-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add vendor
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a vendor</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Legal name</label>
            <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} data-testid="vendor-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Entity type</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value as (typeof ENTITY_TYPES)[number])}
                data-testid="vendor-entity-type"
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">TIN, last 4 (optional)</label>
              <Input value={tinLast4} onChange={(e) => setTinLast4(e.target.value)} placeholder="1234" data-testid="vendor-tin" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Early payment discount (optional)</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={earlyDiscountRule}
              onChange={(e) => setEarlyDiscountRule(e.target.value as typeof earlyDiscountRule)}
              data-testid="vendor-discount-rule"
            >
              <option value="">None</option>
              <option value="purchase_discount_income">Purchase discount income</option>
              <option value="vendor_credit">Vendor credit</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={w9OnFile} onChange={(e) => setW9OnFile(e.target.checked)} data-testid="vendor-w9-on-file" />
            W-9 on file
          </label>
          {w9OnFile ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">W-9 expires on (optional)</label>
              <Input type="date" value={w9ExpiresOn} onChange={(e) => setW9ExpiresOn(e.target.value)} data-testid="vendor-w9-expires" />
            </div>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="vendor-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
