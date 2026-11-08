import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useApp } from "@/store";
import { useFixedAssets, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { FixedAsset } from "@shared/api";

const METHOD_LABEL: Record<FixedAsset["method"], string> = {
  straight_line: "Straight line",
  ddb: "Double declining",
  ddb_150: "150% declining",
  macrs: "MACRS",
  sum_of_years: "Sum of years",
  units_of_production: "Units of production",
  none: "Not depreciated",
};

/**
 * Audit rerun fix, item 6. CFG-CREATE-FIXED-ASSET, PER-POST-DEPRECIATION,
 * and PER-DISPOSE-ASSET have all existed since the original action audit,
 * confirmed zero UI anywhere. No edit run exists for an asset's own fields,
 * so this screen is create-only for the asset itself; depreciation and
 * disposal are the two actions a person actually takes on an existing row.
 */
export default function FixedAssets() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = useFixedAssets(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const active = d?.items.filter((a) => a.status === "active") ?? [];

  return (
    <div className="space-y-4" data-testid="page-fixed-assets">
      <PageHeader
        title="Fixed assets"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} assets.` : ""}`}
        actions={
          clientId ? (
            <div className="flex items-center gap-2">
              <PostDepreciationButton clientId={clientId} period={period} />
              <CreateFixedAssetDialog clientId={clientId} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Assets" value={d ? d.items.length : "…"} testId="kpi-assets" />
        <Kpi label="Active" value={d ? active.length : "…"} />
        <Kpi label="Total cost" value={d ? usd(active.reduce((sum, a) => sum + a.costCents, 0)) : "…"} />
      </div>
      <SectionCard title="Assets" description="What PER-POST-DEPRECIATION and PER-DISPOSE-ASSET read and act on.">
        <DataGrid<FixedAsset>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(a) => a.id}
          testId="grid-fixed-assets"
          empty={<EmptyState title="No fixed assets yet" body="Add equipment, vehicles, or leasehold improvements before depreciating them." />}
          cols={[
            {
              key: "description",
              label: "Asset",
              mobile: "title",
              render: (a) => (
                <span className="font-medium">
                  {a.tag ? `${a.tag} ` : ""}
                  {a.description}
                </span>
              ),
            },
            { key: "class", label: "Class", mobile: "row", render: (a) => a.assetClass },
            { key: "cost", label: "Cost", mobile: "value", render: (a) => usd(a.costCents) },
            { key: "method", label: "Method", mobile: "row", render: (a) => METHOD_LABEL[a.method] },
            { key: "acquired", label: "Acquired", mobile: "row", render: (a) => a.acquiredOn },
            {
              key: "status",
              label: "Status",
              mobile: "value",
              render: (a) => <Pill tone={a.status === "active" ? "good" : a.status === "disposed" ? "neutral" : "watch"}>{a.status.replace(/_/g, " ")}</Pill>,
            },
            {
              key: "actions",
              label: "",
              mobile: "row",
              render: (a) => (a.status === "active" ? <DisposeAssetDialog clientId={clientId ?? ""} asset={a} /> : null),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function PostDepreciationButton({ clientId, period }: { clientId: string; period: string }) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const run = async () => {
    setError(null);
    setMessage(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PER-POST-DEPRECIATION", body: { mode: "preview", scope } });
      if (preview.status === "no_op") {
        setMessage("Nothing to depreciate this period.");
        return;
      }
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PER-POST-DEPRECIATION",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      setMessage(applied.proposals.length > 0 ? `Posted depreciation for ${applied.proposals.length} entries.` : "Nothing to depreciate this period.");
      void qc.invalidateQueries({ queryKey: screenKeys.fixedAssets(clientId) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={trigger.isPending} data-testid="post-depreciation">
        Post depreciation
      </Button>
      {error ? <p className="max-w-xs break-words text-right text-xs text-destructive">{error}</p> : null}
      {message ? <p className="max-w-xs break-words text-right text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

function CreateFixedAssetDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [description, setDescription] = useState("");
  const [assetClass, setAssetClass] = useState("");
  const [costAccount, setCostAccount] = useState("");
  const [accumAccount, setAccumAccount] = useState("");
  const [expenseAccount, setExpenseAccount] = useState("");
  const [acquiredOn, setAcquiredOn] = useState("");
  const [placedInServiceOn, setPlacedInServiceOn] = useState("");
  const [costDollars, setCostDollars] = useState("");
  const [salvageDollars, setSalvageDollars] = useState("0");
  const [method, setMethod] = useState<FixedAsset["method"]>("straight_line");
  const [convention, setConvention] = useState<"full_month" | "mid_month" | "mid_quarter" | "mid_year" | "actual_days">("full_month");
  const [lifeMonths, setLifeMonths] = useState("");
  const [ddbFactorPercent, setDdbFactorPercent] = useState("200");
  const [macrsRecoveryYears, setMacrsRecoveryYears] = useState("");
  const [unitsTotal, setUnitsTotal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setTag("");
    setDescription("");
    setAssetClass("");
    setCostAccount("");
    setAccumAccount("");
    setExpenseAccount("");
    setAcquiredOn("");
    setPlacedInServiceOn("");
    setCostDollars("");
    setSalvageDollars("0");
    setMethod("straight_line");
    setConvention("full_month");
    setLifeMonths("");
    setDdbFactorPercent("200");
    setMacrsRecoveryYears("");
    setUnitsTotal("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!description.trim() || !assetClass.trim()) {
      setError("Description and asset class are required.");
      return;
    }
    const accountPattern = /^[0-9]{4}$/;
    for (const [label, value] of [
      ["Cost account", costAccount],
      ["Accumulated depreciation account", accumAccount],
      ["Expense account", expenseAccount],
    ] as const) {
      if (!accountPattern.test(value)) {
        setError(`${label} must be a 4 digit account number.`);
        return;
      }
    }
    if (!acquiredOn || !placedInServiceOn) {
      setError("Acquired on and placed in service on are both required.");
      return;
    }
    const costCents = Math.round(Number(costDollars) * 100);
    if (!Number.isFinite(costCents) || costCents <= 0) {
      setError("Cost must be a positive dollar amount.");
      return;
    }
    const salvageCents = Math.round(Number(salvageDollars) * 100);
    if (!Number.isFinite(salvageCents) || salvageCents < 0) {
      setError("Salvage value must be 0 or more.");
      return;
    }
    const fields: Record<string, unknown> = {
      description: description.trim(),
      assetClass: assetClass.trim(),
      costAccount,
      accumAccount,
      expenseAccount,
      acquiredOn,
      placedInServiceOn,
      costCents,
      salvageCents,
      method,
      convention,
    };
    if (tag.trim()) fields.tag = tag.trim();
    if (method === "straight_line" || method === "ddb" || method === "ddb_150") {
      const months = Math.round(Number(lifeMonths));
      if (!Number.isFinite(months) || months <= 0) {
        setError("Useful life (months) is required for this method.");
        return;
      }
      fields.lifeMonths = months;
    }
    if (method === "ddb" || method === "ddb_150") {
      const factorBps = Math.round(Number(ddbFactorPercent) * 100);
      if (!Number.isFinite(factorBps) || factorBps <= 0) {
        setError("The declining balance factor is required for this method.");
        return;
      }
      fields.ddbFactorBps = factorBps;
    }
    if (method === "macrs") {
      const years = Math.round(Number(macrsRecoveryYears));
      if (!Number.isFinite(years) || years <= 0) {
        setError("MACRS recovery years is required for this method.");
        return;
      }
      fields.macrsRecoveryYears = years;
    }
    if (method === "units_of_production") {
      const units = Math.round(Number(unitsTotal));
      if (!Number.isFinite(units) || units <= 0) {
        setError("Total expected units is required for this method.");
        return;
      }
      fields.unitsTotal = units;
    }
    const scope = { clientId, fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-FIXED-ASSET", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-FIXED-ASSET",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.fixedAssets(clientId) });
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
        <Button size="sm" data-testid="asset-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add asset
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a fixed asset</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="asset-description" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Asset class</label>
              <Input value={assetClass} onChange={(e) => setAssetClass(e.target.value)} placeholder="Computer equipment" data-testid="asset-class" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Tag (optional)</label>
              <Input value={tag} onChange={(e) => setTag(e.target.value)} data-testid="asset-tag" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Cost account</label>
              <Input value={costAccount} onChange={(e) => setCostAccount(e.target.value)} placeholder="1510" data-testid="asset-cost-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Accum. depreciation account</label>
              <Input value={accumAccount} onChange={(e) => setAccumAccount(e.target.value)} placeholder="1610" data-testid="asset-accum-account" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Depreciation expense account</label>
              <Input value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)} placeholder="6800" data-testid="asset-expense-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Acquired on</label>
              <Input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} data-testid="asset-acquired" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Placed in service on</label>
              <Input type="date" value={placedInServiceOn} onChange={(e) => setPlacedInServiceOn(e.target.value)} data-testid="asset-placed-in-service" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Cost ($)</label>
              <Input type="number" value={costDollars} onChange={(e) => setCostDollars(e.target.value)} data-testid="asset-cost" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Salvage value ($)</label>
              <Input type="number" value={salvageDollars} onChange={(e) => setSalvageDollars(e.target.value)} data-testid="asset-salvage" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Method</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={method}
                onChange={(e) => setMethod(e.target.value as FixedAsset["method"])}
                data-testid="asset-method"
              >
                {Object.entries(METHOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Convention</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={convention}
                onChange={(e) => setConvention(e.target.value as typeof convention)}
                data-testid="asset-convention"
              >
                <option value="full_month">Full month</option>
                <option value="mid_month">Mid month</option>
                <option value="mid_quarter">Mid quarter</option>
                <option value="mid_year">Mid year</option>
                <option value="actual_days">Actual days</option>
              </select>
            </div>
          </div>
          {method === "straight_line" || method === "ddb" || method === "ddb_150" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Useful life (months)</label>
                <Input type="number" value={lifeMonths} onChange={(e) => setLifeMonths(e.target.value)} data-testid="asset-life-months" />
              </div>
              {method === "ddb" || method === "ddb_150" ? (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Declining balance factor (%)</label>
                  <Input type="number" value={ddbFactorPercent} onChange={(e) => setDdbFactorPercent(e.target.value)} data-testid="asset-ddb-factor" />
                </div>
              ) : null}
            </div>
          ) : null}
          {method === "macrs" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">MACRS recovery years</label>
              <Input type="number" value={macrsRecoveryYears} onChange={(e) => setMacrsRecoveryYears(e.target.value)} data-testid="asset-macrs-years" />
            </div>
          ) : null}
          {method === "units_of_production" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Total expected units</label>
              <Input type="number" value={unitsTotal} onChange={(e) => setUnitsTotal(e.target.value)} data-testid="asset-units-total" />
            </div>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="asset-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisposeAssetDialog({ clientId, asset }: { clientId: string; asset: FixedAsset }) {
  const [open, setOpen] = useState(false);
  const [disposedOn, setDisposedOn] = useState("");
  const [proceedsDollars, setProceedsDollars] = useState("0");
  const [proceedsAccount, setProceedsAccount] = useState("");
  const [gainLossAccount, setGainLossAccount] = useState("8200");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setDisposedOn("");
    setProceedsDollars("0");
    setProceedsAccount("");
    setGainLossAccount("8200");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!disposedOn) {
      setError("Disposed on is required.");
      return;
    }
    if (!gainLossAccount.trim()) {
      setError("A gain or loss account is required.");
      return;
    }
    const proceedsCents = Math.round(Number(proceedsDollars) * 100);
    if (!Number.isFinite(proceedsCents) || proceedsCents < 0) {
      setError("Proceeds must be 0 or more.");
      return;
    }
    if (proceedsCents > 0 && !proceedsAccount.trim()) {
      setError("A proceeds account is required when proceeds are more than $0.");
      return;
    }
    const scope = {
      clientId,
      assetId: asset.id,
      disposedOn,
      proceedsCents: String(proceedsCents),
      proceedsAccount: proceedsCents > 0 ? proceedsAccount.trim() : null,
      gainLossAccount: gainLossAccount.trim(),
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "PER-DISPOSE-ASSET", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "PER-DISPOSE-ASSET",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.fixedAssets(clientId) });
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
        <Button size="sm" variant="outline" data-testid={`asset-dispose-${asset.id}`}>
          Dispose
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dispose of {asset.description}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Disposed on</label>
            <Input type="date" value={disposedOn} onChange={(e) => setDisposedOn(e.target.value)} data-testid="dispose-date" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Proceeds ($)</label>
              <Input type="number" value={proceedsDollars} onChange={(e) => setProceedsDollars(e.target.value)} data-testid="dispose-proceeds" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Proceeds account</label>
              <Input value={proceedsAccount} onChange={(e) => setProceedsAccount(e.target.value)} placeholder="1000" data-testid="dispose-proceeds-account" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Gain or loss account</label>
            <Input value={gainLossAccount} onChange={(e) => setGainLossAccount(e.target.value)} data-testid="dispose-gain-loss-account" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="dispose-save">
            Dispose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
