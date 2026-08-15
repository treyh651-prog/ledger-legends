import { useMemo } from "react";
import { AlertTriangle, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { REPORTABLE_THRESHOLD_CENTS, vendorViews } from "@/data/derive";
import { usd } from "@/lib/money";

export default function TaxForms() {
  const { ds, activeClient, activeClientId, loading, loadError, reload, addMessage } = useApp();
  const { toast } = useToast();
  const vendors = useMemo(() => vendorViews(ds, activeClientId), [ds, activeClientId]);

  const reportable = vendors.filter((v) => v.reportable);
  const missing = reportable.filter((v) => !v.w9OnFile);
  const totalReportable = reportable.reduce((s, v) => s + v.ytdPaymentsCents, 0);

  return (
    <>
      <PageHeader
        title="1099 and W-9 tracker"
        subtitle={`Vendor payments for ${activeClient.dba} measured against the ${usd(REPORTABLE_THRESHOLD_CENTS)} reporting threshold, with the W-9 status next to each one.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Vendors paid this year" value={vendors.length} testId="kpi-vendors" />
        <Kpi label="Reportable" value={reportable.length} hint={`${usd(totalReportable)} in payments`} testId="kpi-reportable" />
        <Kpi label="Missing a W-9" value={missing.length} tone={missing.length ? "risk" : "good"} testId="kpi-missing-w9" />
        <Kpi label="Forms ready to file" value={reportable.length - missing.length} tone="good" testId="kpi-ready" />
      </div>

      {missing.length ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft p-4" data-testid="banner-w9">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-semibold text-warning">
              {missing.length} vendor{missing.length > 1 ? "s" : ""} crossed the threshold without a W-9 on file
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              These have to be collected before January, when the 1099 filing window opens. Chasing them in December is how firms end up filing late.
              Highest exposure right now is {missing[0].name} at {usd(missing[0].ytdPaymentsCents)}.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => {
                addMessage(
                  activeClientId,
                  "Trey Hernandez",
                  "W-9 forms needed before January",
                  `We have ${missing.length} vendors over the reporting threshold with no W-9 on file: ${missing.map((m) => m.name).join(", ")}. Please forward the request to each of them or send us a contact and we will handle it.`,
                  "Outbound",
                );
                toast({ title: "Requests queued", description: `${missing.length} W-9 requests are now visible in the portal.` });
              }}
              data-testid="button-request-all-w9"
            >
              <Send className="mr-1 h-4 w-4" />
              Ask the client to collect them
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-positive/40 bg-positive-soft p-3 text-sm" data-testid="banner-w9-clear">
          <ShieldCheck className="h-4 w-4 shrink-0 text-positive" />
          <span className="text-muted-foreground">Every reportable vendor has a W-9 on file, so January filing is already covered for this client.</span>
        </div>
      )}

      <SectionCard
        title="Vendor detail"
        description="Payments are totaled from the transactions on the ledger, so the figures move as the year goes on."
        bodyClassName="p-0"
        testId="card-vendors"
      >
        <DataGrid
          rows={vendors}
          rowKey={(v) => v.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          rowClassName={(v) => (v.reportable && !v.w9OnFile ? "bg-warning-soft" : "")}
          empty={<EmptyState title="No vendor payments yet" body="Once bills and card charges post, vendors show up here." />}
          cols={[
            {
              key: "name",
              label: "Vendor",
              mobile: "title",
              render: (v) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{v.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{v.taxClassification}</p>
                </div>
              ),
            },
            {
              key: "tin",
              label: "Tax number",
              mobile: "row",
              render: (v) => <span className="tnum text-xs">{v.tinLast4 ? `Ends in ${v.tinLast4}` : "Not collected"}</span>,
            },
            { key: "ytd", label: "Paid this year", align: "right", mobile: "value", render: (v) => <Money cents={v.ytdPaymentsCents} /> },
            {
              key: "threshold",
              label: "Threshold",
              align: "right",
              mobile: "row",
              render: (v) => (
                <span className="tnum text-xs text-muted-foreground">
                  {v.ytdPaymentsCents >= REPORTABLE_THRESHOLD_CENTS ? "Over" : `${usd(REPORTABLE_THRESHOLD_CENTS - v.ytdPaymentsCents)} to go`}
                </span>
              ),
            },
            {
              key: "reportable",
              label: "1099 needed",
              mobile: "row",
              render: (v) => <Pill tone={v.reportable ? "info" : "neutral"}>{v.reportable ? "Yes" : "No"}</Pill>,
            },
            {
              key: "w9",
              label: "W-9",
              align: "right",
              mobile: "row",
              render: (v) =>
                v.w9OnFile ? (
                  <Pill tone="good">On file</Pill>
                ) : v.reportable ? (
                  <Pill tone="risk">Missing</Pill>
                ) : (
                  <Pill tone="neutral">Not needed yet</Pill>
                ),
            },
            {
              key: "action",
              label: "Follow up",
              align: "right",
              width: "150px",
              mobile: "row",
              render: (v) =>
                v.w9OnFile ? (
                  <span className="text-xs text-muted-foreground">{v.requestSentAt ? `Received ${v.requestSentAt}` : "Complete"}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2"
                    onClick={() => {
                      addMessage(
                        activeClientId,
                        "Trey Hernandez",
                        `W-9 request for ${v.name}`,
                        `${v.name} has been paid ${usd(v.ytdPaymentsCents)} this year. Please have them complete a W-9 so the 1099 can be filed on time.`,
                        "Outbound",
                      );
                      toast({ title: "Request sent", description: `${v.name} is on the follow up list.` });
                    }}
                    data-testid={`button-request-w9-${v.id}`}
                  >
                    Request a W-9
                  </Button>
                ),
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
