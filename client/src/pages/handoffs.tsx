import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useCpaHandoffs, useOffboardExports, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { CpaHandoff, OffboardExport } from "@shared/api";

/**
 * CPA handoff and client export, read from GET /api/firm/clients/:id/
 * cpa-handoffs and /offboard-exports. Audit fix (problem 8): CPA-BUILD-
 * HANDOFF and OFFBOARD-BUILD-EXPORT both existed and worked, but neither
 * had any UI at all. Both build a vault locked archive artifact -- there
 * is no edit or delete action here on purpose, only building a new one.
 */
export default function Handoffs() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const handoffsQ = useCpaHandoffs(clientId);
  const exportsQ = useOffboardExports(clientId);
  if (handoffsQ.isError) return <ErrorState message={errorMessage(handoffsQ.error)} onRetry={() => void handoffsQ.refetch()} />;
  if (exportsQ.isError) return <ErrorState message={errorMessage(exportsQ.error)} onRetry={() => void exportsQ.refetch()} />;
  const handoffs = handoffsQ.data;
  const exports_ = exportsQ.data;

  return (
    <div className="space-y-4" data-testid="page-handoffs">
      <PageHeader title="Handoffs and exports" subtitle={`${client?.name ?? ""}. Vault locked archives: a CPA handoff for filing, a full client export for offboarding.`} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="CPA handoffs built" value={handoffs ? handoffs.items.length : "…"} testId="kpi-handoffs" />
        <Kpi label="Client exports built" value={exports_ ? exports_.items.length : "…"} testId="kpi-exports" />
      </div>
      <Tabs defaultValue="handoff">
        <TabsList>
          <TabsTrigger value="handoff" data-testid="tab-handoff">CPA handoff</TabsTrigger>
          <TabsTrigger value="export" data-testid="tab-export">Client export</TabsTrigger>
        </TabsList>
        <TabsContent value="handoff" className="mt-4">
          <SectionCard
            title="CPA handoffs"
            description="One archive per build, newest first. Everything a preparer needs to file, nothing that claims it was filed."
            actions={clientId ? <BuildHandoffDialog clientId={clientId} period={period} /> : null}
          >
            <DataGrid<CpaHandoff>
              rows={handoffs?.items ?? []}
              loading={handoffsQ.isPending}
              rowKey={(h) => h.id}
              testId="grid-handoffs"
              empty={<EmptyState title="No handoff built yet" body="Build one when the period, or the fiscal year, is ready to hand to the preparer." />}
              cols={[
                { key: "year", label: "Tax year", mobile: "title", render: (h) => <span className="font-medium">{h.taxYear}</span> },
                { key: "scope", label: "Scope", mobile: "row", render: (h) => <span className="text-xs">{h.scopeKind === "fiscal_year" ? "Full fiscal year" : "One period"}, {fmtShortDate(h.periodStart)} to {fmtShortDate(h.periodEnd)}</span> },
                { key: "basis", label: "Basis", mobile: "row", render: (h) => <span className="text-xs">{h.reportingBasis}</span> },
                { key: "artifacts", label: "Artifacts", align: "right", mobile: "row", render: (h) => <span className="tnum text-xs">{h.artifactCount}</span> },
                { key: "open", label: "Open items", align: "right", mobile: "row", render: (h) => <span className="tnum text-xs">{h.openItemCount}</span> },
                { key: "built", label: "Built", mobile: "value", render: (h) => <span className="text-xs">{fmtTimestamp(h.builtAt)}</span> },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="export" className="mt-4">
          <SectionCard
            title="Client exports"
            description="One archive per build, newest first. The full book, for when a client leaves."
            actions={clientId ? <BuildExportDialog clientId={clientId} period={period} /> : null}
          >
            <DataGrid<OffboardExport>
              rows={exports_?.items ?? []}
              loading={exportsQ.isPending}
              rowKey={(e) => e.id}
              testId="grid-exports"
              empty={<EmptyState title="No export built yet" body="Build one once the client has requested their records." />}
              cols={[
                { key: "requested", label: "Requested", mobile: "title", render: (e) => <span className="font-medium">{fmtShortDate(e.requestedOn)}</span> },
                { key: "due", label: "Due", mobile: "row", render: (e) => <span className="tnum text-xs">{fmtShortDate(e.dueOn)}</span> },
                { key: "period", label: "History through", mobile: "row", render: (e) => <span className="text-xs">{fmtShortDate(e.periodEnd)}</span> },
                { key: "files", label: "Files", align: "right", mobile: "row", render: (e) => <span className="tnum text-xs">{e.fileCount}</span> },
                { key: "docs", label: "Documents", align: "right", mobile: "row", render: (e) => <span className="tnum text-xs">{e.documentCount}</span> },
                { key: "built", label: "Built", mobile: "value", render: (e) => <span className="text-xs">{fmtTimestamp(e.builtAt)}</span> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** CPA-BUILD-HANDOFF. */
function BuildHandoffDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [scopeKind, setScopeKind] = useState<"period" | "fiscal_year">("period");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const submit = async () => {
    setError(null);
    const scope = { clientId, period: periodStartOf(period), scopeKind };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CPA-BUILD-HANDOFF", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "CPA-BUILD-HANDOFF", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: screenKeys.cpaHandoffs(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setScopeKind("period"); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="handoff-build">Build handoff</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Build a CPA handoff</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Scope</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value as "period" | "fiscal_year")}
              data-testid="handoff-scope-kind"
            >
              <option value="period">This period only</option>
              <option value="fiscal_year">The whole fiscal year</option>
            </select>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="handoff-build-confirm">Build</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** OFFBOARD-BUILD-EXPORT. */
function BuildExportDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [requestedOn, setRequestedOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setRequestedOn(new Date().toISOString().slice(0, 10));
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!requestedOn) {
      setError("The day the client asked is required.");
      return;
    }
    const scope = { clientId, period: periodStartOf(period), requestedOn };
    try {
      const preview = await trigger.mutateAsync({ runCode: "OFFBOARD-BUILD-EXPORT", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "OFFBOARD-BUILD-EXPORT", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: screenKeys.offboardExports(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="export-build">Build export</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Build a client export</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">The full book, every period through today, as a single archive the client keeps.</p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Requested on</label>
            <Input type="date" value={requestedOn} onChange={(e) => setRequestedOn(e.target.value)} data-testid="export-requested-on" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="export-build-confirm">Build</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
