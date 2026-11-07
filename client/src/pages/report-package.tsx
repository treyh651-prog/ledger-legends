import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DataGrid, EmptyState, ErrorState, Kpi, LoadingRows, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReportPackages, useTriggerRun, errorMessage, periodStartOf } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { ReportSection } from "@shared/api";

type ComparisonBasis = "prior_period" | "prior_year" | "budget" | "none";
type ReportBasis = "accrual" | "cash";

function BuildPackageDialog({
  clientId,
  period,
  onBuilt,
}: {
  clientId: string;
  period: string;
  /** Clears the explicit selection so the page falls back to whichever package the API now reports as current. */
  onBuilt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [comparisonBasis, setComparisonBasis] = useState<ComparisonBasis>("prior_period");
  const [reportBasis, setReportBasis] = useState<ReportBasis>("accrual");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const build = async () => {
    setError(null);
    // A plain "YYYY-MM" from the header, not the full day RPT-BUILD-PACKAGE's
    // own scope schema requires (period: z.string().min(10)) -- every build
    // request 400'd client side before this, confirmed live while
    // browser-verifying problem 9's own release gate.
    const scope = { clientId, period: periodStartOf(period), comparisonBasis, reportBasis };
    try {
      const preview = await trigger.mutateAsync({ runCode: "RPT-BUILD-PACKAGE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "RPT-BUILD-PACKAGE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "report-packages"] });
      setOpen(false);
      onBuilt();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-build-package">
          Build package
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Build report package</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">For {fmtPeriod(period)}. RPT-BUILD-PACKAGE renders all nine sections on the basis chosen below.</p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Report basis</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={reportBasis}
              onChange={(e) => setReportBasis(e.target.value as ReportBasis)}
              data-testid="select-report-basis"
            >
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Comparison basis</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={comparisonBasis}
              onChange={(e) => setComparisonBasis(e.target.value as ComparisonBasis)}
              data-testid="select-comparison-basis"
            >
              <option value="prior_period">Prior period</option>
              <option value="prior_year">Prior year</option>
              <option value="budget">Budget</option>
              <option value="none">None</option>
            </select>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void build()} disabled={trigger.isPending} data-testid="button-confirm-build">
            Build
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * RPT-RELEASE-PACKAGE. Audit fix (problem 9): before this run existed, a
 * built package reached the client portal the instant RPT-BUILD-PACKAGE
 * finished, with no firm review gate at all -- including one flagged
 * closed_with_exceptions. Shown only for a draft package; a released one
 * needs no action here.
 */
function ReleasePackageButton({ clientId, packageId, onReleased }: { clientId: string; packageId: string; onReleased: () => void }) {
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const scope = { clientId, packageId };
    try {
      const preview = await trigger.mutateAsync({ runCode: "RPT-RELEASE-PACKAGE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "RPT-RELEASE-PACKAGE", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "report-packages"] });
      onReleased();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="button-release-package">
        Release to client
      </Button>
      {error ? <p className="max-w-[16rem] break-words text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The report package for one period, read from
 * GET /api/firm/clients/:id/report-packages. A package and its sections are
 * what RPT-BUILD-PACKAGE rendered; an omitted section says why it was left
 * out rather than showing a blank.
 */
export default function ReportPackage() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const [packageId, setPackageId] = useState<string | null>(null);
  const q = useReportPackages(clientId, period, packageId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const pkg = d?.packages.find((p) => p.id === d.selectedPackageId) ?? null;

  return (
    <div className="space-y-4" data-testid="page-report-package">
      <PageHeader
        title="Report package"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${pkg ? `${pkg.basis} basis, ${pkg.comparisonBasis.replace(/_/g, " ")} comparison, built ${fmtTimestamp(pkg.builtAt)}.` : d ? "No package built for this period." : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {d && d.packages.length > 1 ? (
              <Select value={d.selectedPackageId ?? ""} onValueChange={setPackageId}>
                <SelectTrigger className="w-72" data-testid="select-package">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {d.packages.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.basis}, {p.state}, built {fmtTimestamp(p.builtAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {clientId && pkg && pkg.state === "draft" ? (
              <ReleasePackageButton clientId={clientId} packageId={pkg.id} onReleased={() => void q.refetch()} />
            ) : null}
            {clientId ? (
              <BuildPackageDialog clientId={clientId} period={period} onBuilt={() => setPackageId(null)} />
            ) : null}
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="State" value={pkg ? <Pill tone={pkg.state === "draft" ? "info" : pkg.state === "released" ? "good" : "neutral"}>{pkg.state}</Pill> : "None"} testId="kpi-package-state" />
        <Kpi label="Sections" value={pkg ? `${pkg.sectionCount - pkg.omissionCount} of ${pkg.sectionCount} rendered` : "None"} />
        <Kpi label="Comparison" value={pkg ? (pkg.comparisonAvailable ? "Available" : "Not available") : "None"} hint={pkg?.comparisonNote} />
        <Kpi label="Exceptions" value={pkg ? (pkg.closedWithExceptions ? "Closed with exceptions" : "None") : "None"} tone={pkg?.closedWithExceptions ? "watch" : "neutral"} />
      </div>
      {pkg?.exceptionBanner ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm" data-testid="banner-exceptions">
          {pkg.exceptionBanner}
        </div>
      ) : null}
      {pkg?.watermark ? <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{pkg.watermark}</p> : null}
      {q.isPending ? (
        <LoadingRows rows={6} cols={3} />
      ) : !pkg ? (
        <EmptyState title="No report package" body="RPT-BUILD-PACKAGE renders the package once the period's statements are ready." />
      ) : (
        d?.sections.map((s: ReportSection) => (
          <SectionCard key={s.id} title={`${s.sequence}. ${s.sectionTitle}`} description={s.status === "omitted" ? `Omitted: ${s.omissionReason ?? "no reason recorded"}` : s.bannerText ?? undefined}>
            {s.status === "omitted" ? (
              <p className="px-3 py-3 text-sm text-muted-foreground" data-testid={`text-omitted-${s.sectionCode}`}>This section was left out of the package on purpose.</p>
            ) : (
              <DataGrid
                rows={s.lines}
                rowKey={(l, i) => `${s.id}:${i}`}
                testId={`grid-section-${s.sectionCode}`}
                empty={<EmptyState title="No lines" body="This section rendered without lines." />}
                cols={[
                  { key: "label", label: "Line", mobile: "title", render: (l) => <span className={l.accountNumber ? "pl-4" : "font-semibold"}>{l.accountNumber ? `${l.accountNumber} ` : ""}{l.label}</span> },
                  { key: "amt", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.amountCents} signed /> },
                  { key: "cmp", label: "Comparison", align: "right", mobile: "row", render: (l) => (l.comparisonCents === null ? <span className="text-xs text-muted-foreground">None</span> : <Money cents={l.comparisonCents} signed dim />) },
                  { key: "note", label: "Note", mobile: "row", render: (l) => <span className="text-xs text-muted-foreground">{l.note ?? ""}</span> },
                ]}
              />
            )}
          </SectionCard>
        ))
      )}
    </div>
  );
}
