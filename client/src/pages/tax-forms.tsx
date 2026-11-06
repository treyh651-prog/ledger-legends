import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useTaxForms, useTriggerRun, errorMessage, periodStartOf } from "@/api";
import { fmtShortDate, fmtTimestamp, usd } from "@/lib/money";
import type { TaxDataLine, W9State } from "@shared/api";

/**
 * TAX-BUILD-1099 / TAX-TRACK-W9. Audit fix (problem 8): both existed and
 * worked, but nothing in the client ever called either one -- this screen
 * was 100% read only, confirmed by its own file: no run trigger anywhere
 * in it before this.
 */
function BuildTaxDataButton({ clientId, period, runCode, label, testId }: { clientId: string; period: string; runCode: "TAX-BUILD-1099" | "TAX-TRACK-W9"; label: string; testId: string }) {
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode, body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode, body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "tax-forms"] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void submit()} disabled={trigger.isPending} data-testid={testId}>
        {label}
      </Button>
      {error ? <p className="max-w-[16rem] break-words text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The 1099 compilation and W-9 tracking, read from
 * GET /api/firm/clients/:id/tax-forms. A data set is what TAX-COMPILE-1099
 * built; the handoff statement on it says what the firm hands to the preparer.
 * Nothing here files anything.
 */
export default function TaxForms() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const [dataSetId, setDataSetId] = useState<string | null>(null);
  const q = useTaxForms(clientId, dataSetId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const set = d?.dataSets.find((s) => s.id === d.selectedDataSetId) ?? null;
  const w9Tone = (w: W9State) => (w.state === "on_file" || w.state === "received" ? "good" : w.state === "expired" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-tax-forms">
      <PageHeader
        title="Tax forms"
        subtitle={`${client?.name ?? ""}, tax year ${d?.taxYear ?? ""}. ${d?.threshold ? `Reporting threshold ${usd(d.threshold.thresholdCents)} effective ${fmtShortDate(d.threshold.effectiveFrom)}.` : d ? "No reporting threshold on file for the firm." : ""}`}
        actions={
          clientId ? (
            <div className="flex flex-wrap items-center gap-2">
              {d && d.dataSets.length > 1 ? (
                <Select value={d.selectedDataSetId ?? ""} onValueChange={setDataSetId}>
                  <SelectTrigger className="w-72" data-testid="select-tax-set">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {d.dataSets.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.taxYear}, built {fmtTimestamp(s.builtAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <BuildTaxDataButton clientId={clientId} period={period} runCode="TAX-TRACK-W9" label="Refresh W-9 tracking" testId="button-track-w9" />
              <BuildTaxDataButton clientId={clientId} period={period} runCode="TAX-BUILD-1099" label="Build 1099 data" testId="button-build-1099" />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Reportable payees" value={set ? set.reportableCount : "None"} hint={set ? `${set.payeeCount} payees compiled` : "TAX-COMPILE-1099 has not built a set"} testId="kpi-reportable" />
        <Kpi label="Reportable total" value={set ? <Money cents={set.reportableTotalCents} /> : "None"} />
        <Kpi label="Approaching threshold" value={set ? set.approachingCount : "None"} tone={set && set.approachingCount > 0 ? "watch" : "neutral"} />
        <Kpi label="Backup withholding" value={set ? set.backupWithholdingCount : "None"} tone={set && set.backupWithholdingCount > 0 ? "risk" : "neutral"} />
      </div>
      {set ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="text-handoff">
          {set.handoffStatement}
        </div>
      ) : null}
      <Tabs defaultValue="lines">
        <TabsList>
          <TabsTrigger value="lines" data-testid="tab-1099">1099 lines</TabsTrigger>
          <TabsTrigger value="w9" data-testid="tab-w9">W-9 status</TabsTrigger>
        </TabsList>
        <TabsContent value="lines" className="mt-4">
          <SectionCard title="Compiled payees" description="One row per payee the compilation found, with the reason it is or is not reportable.">
            <DataGrid<TaxDataLine>
              rows={d?.lines ?? []}
              loading={q.isPending}
              rowKey={(l) => l.id}
              testId="grid-1099"
              empty={<EmptyState title="No compilation" body="TAX-COMPILE-1099 writes the payee lines when it runs for a tax year." />}
              cols={[
                { key: "payee", label: "Payee", mobile: "title", render: (l) => <span className="font-medium">{l.payeeName}</span> },
                { key: "form", label: "Form", mobile: "row", render: (l) => <span className="text-xs">{l.formCode} {l.boxCode}</span> },
                { key: "gross", label: "Gross paid", align: "right", mobile: "row", render: (l) => <Money cents={l.grossPaidCents} dim /> },
                { key: "card", label: "Card excluded", align: "right", mobile: "row", render: (l) => <Money cents={l.excludedCardCents} dim /> },
                { key: "rep", label: "Reportable", align: "right", mobile: "value", render: (l) => <Money cents={l.reportableCents} className="font-semibold" /> },
                { key: "w9", label: "W-9", mobile: "row", render: (l) => <span className="text-xs">{l.w9State.replace(/_/g, " ")}{l.tinLast4 ? `, TIN ${l.tinLast4}` : ""}</span> },
                {
                  key: "state",
                  label: "State",
                  mobile: "row",
                  render: (l) => (
                    <span className="flex flex-wrap gap-1">
                      <Pill tone={l.state === "reportable" ? "good" : "watch"}>{l.state.replace(/_/g, " ")}</Pill>
                      {l.backupWithholdingRequired ? <Pill tone="risk">Backup withholding</Pill> : null}
                    </span>
                  ),
                },
              ]}
            />
          </SectionCard>
        </TabsContent>
        <TabsContent value="w9" className="mt-4">
          <SectionCard title="W-9 tracking" description="From W9-TRACK, one row per active vendor.">
            <DataGrid<W9State>
              rows={d?.w9 ?? []}
              loading={q.isPending}
              rowKey={(w) => w.id}
              testId="grid-w9"
              empty={<EmptyState title="No W-9 states" body="W9-TRACK writes a state per vendor when it runs." />}
              cols={[
                { key: "vendor", label: "Vendor", mobile: "title", render: (w) => <span className="font-medium">{w.vendorName}</span> },
                { key: "req", label: "Requested", mobile: "row", render: (w) => <span className="tnum text-xs">{w.requestedOn ? fmtShortDate(w.requestedOn) : ""}</span> },
                { key: "rec", label: "Received", mobile: "row", render: (w) => <span className="tnum text-xs">{w.receivedOn ? fmtShortDate(w.receivedOn) : ""}</span> },
                { key: "exp", label: "Expires", mobile: "row", render: (w) => <span className="tnum text-xs">{w.expiresOn ? fmtShortDate(w.expiresOn) : ""}</span> },
                { key: "age", label: "Age", align: "right", mobile: "row", render: (w) => <span className="tnum text-xs">{w.ageDays} d</span> },
                { key: "state", label: "State", mobile: "value", render: (w) => <Pill tone={w9Tone(w)}>{w.state.replace(/_/g, " ")}{w.escalation === "lead" ? ", escalated" : ""}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
