import { DataGrid, EmptyState, Kpi, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalReports } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { PortalReports as PortalReportsData } from "@shared/api";

type Row = PortalReportsData["items"][number];

/**
 * Legend feature. Report packages the engine built, read from
 * GET /api/portal/:clientId/reports. Download waits on object storage and the
 * payload says so, so no row offers a file it cannot hand over.
 */
export default function PortalReports() {
  return (
    <PortalScreen title="Your reports" subtitle="Report packages built from your closed books, one per month and basis." testId="hero-portal-reports">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalReports(clientId);
  return (
    <QueryBody q={q} title="Reports" testId="card-portal-reports">
      {(data) => (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Packages" value={data.items.length} testId="kpi-reports-count" />
            <Kpi label="Current" value={data.items.filter((r) => r.state === "draft").length} testId="kpi-reports-current" />
            <Kpi label="With exceptions" value={data.items.filter((r) => r.closedWithExceptions).length} tone={data.items.some((r) => r.closedWithExceptions) ? "watch" : "good"} testId="kpi-reports-exceptions" />
            <Kpi label="Download" value={data.storageConfigured ? "Available" : "Not yet"} tone="neutral" testId="kpi-reports-download" />
          </div>
          {!data.storageConfigured && data.items.length > 0 ? (
            <PortalNote tone="watch" testId="note-reports-storage">
              Report files are held in the document vault, and download opens once document storage is connected. Until then your accountant can send a copy.
            </PortalNote>
          ) : null}
          <SectionCard title="Packages" bodyClassName="p-0" testId="card-portal-reports-rows">
            <DataGrid<Row>
              rows={data.items}
              rowKey={(r) => r.id}
              testId="grid-portal-reports"
              empty={<EmptyState title="No report package yet" body="A package is built when a month closes. There is no closed month on your books yet." />}
              cols={[
                { key: "period", label: "Month", render: (r) => <span className="font-medium">{fmtPeriod(r.periodStart.slice(0, 7))}</span> },
                { key: "basis", label: "Basis", render: (r) => (r.basis === "accrual" ? "Accrual" : "Cash") },
                { key: "sections", label: "Sections", align: "right", render: (r) => r.sectionCount },
                { key: "state", label: "State", render: (r) => <Pill tone={r.state === "draft" ? "good" : "neutral"}>{r.state === "draft" ? "Current" : "Superseded"}</Pill> },
                { key: "exc", label: "Close", render: (r) => (r.closedWithExceptions ? <Pill tone="watch">Closed with exceptions</Pill> : <Pill tone="good">Clean close</Pill>) },
                { key: "built", label: "Built", render: (r) => fmtTimestamp(r.builtAt) },
              ]}
            />
          </SectionCard>
        </>
      )}
    </QueryBody>
  );
}
