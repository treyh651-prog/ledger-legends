import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, LoadingRows, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReportPackages, errorMessage } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { ReportSection } from "@shared/api";

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
          d && d.packages.length > 1 ? (
            <Select value={d.selectedPackageId ?? ""} onValueChange={setPackageId}>
              <SelectTrigger className="w-72" data-testid="select-package">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {d.packages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.state}, built {fmtTimestamp(p.builtAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="State" value={pkg ? <Pill tone={pkg.state === "draft" ? "info" : "neutral"}>{pkg.state}</Pill> : "None"} testId="kpi-package-state" />
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
