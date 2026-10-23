import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalStatements } from "@/api";
import { fmtPeriod } from "@/lib/money";
import type { PortalStatements, StatementSection } from "@shared/api";

interface CompareRow {
  key: string;
  label: string;
  thisCents: number;
  priorCents: number;
  strong: boolean;
}

/**
 * Ledger+ feature. This month against the one before, line by line, from two
 * reads of GET /api/portal/:clientId/statements?period=. The server lists the
 * periods the tier may open; when fewer than two exist the screen says so.
 */
export default function PortalCompare() {
  const [period, setPeriod] = useState<string | null>(null);
  return (
    <PortalScreen title="Month over month" subtitle="This month against last month, line by line." testId="hero-portal-compare">
      {({ clientId }) => <Body clientId={clientId} period={period} setPeriod={setPeriod} />}
    </PortalScreen>
  );
}

function Body({ clientId, period, setPeriod }: { clientId: string; period: string | null; setPeriod: (p: string) => void }) {
  const current = usePortalStatements(clientId, period);
  return (
    <QueryBody q={current} title="Month over month" testId="card-portal-compare">
      {(st) => {
        const idx = st.visiblePeriods.indexOf(st.period);
        const prior = idx >= 0 ? st.visiblePeriods.slice(0, idx).sort().reverse()[0] ?? null : null;
        const earlier = st.visiblePeriods.filter((p) => p < st.period).sort().reverse()[0] ?? prior;
        return (
          <>
            {st.visiblePeriods.length > 1 ? (
              <div className="flex justify-end">
                <Select value={st.period} onValueChange={setPeriod}>
                  <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-compare-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {st.visiblePeriods.map((v) => (
                      <SelectItem key={v} value={v}>
                        {fmtPeriod(v.slice(0, 7))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {st.periodStatus === "none" || !earlier ? (
              <SectionCard title="Month over month" testId="card-portal-compare-empty">
                <EmptyState
                  title={st.periodStatus === "none" ? "No closed month yet" : "Only one month to show"}
                  body={
                    st.periodStatus === "none"
                      ? "A comparison needs two closed months. There is no closed month on your books yet."
                      : `${fmtPeriod(st.period.slice(0, 7))} is the only month available, so there is nothing yet to set beside it.`
                  }
                />
              </SectionCard>
            ) : (
              <Prior clientId={clientId} current={st} priorPeriod={earlier} />
            )}
          </>
        );
      }}
    </QueryBody>
  );
}

function Prior({ clientId, current, priorPeriod }: { clientId: string; current: PortalStatements; priorPeriod: string }) {
  const q = usePortalStatements(clientId, priorPeriod);
  return (
    <QueryBody q={q} title="Prior month" testId="card-portal-compare-prior">
      {(prior) => {
        const rows = compareRows(current.incomeStatement, prior.incomeStatement);
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label={fmtPeriod(current.period.slice(0, 7))} value={<Money cents={current.netIncomeCents} />} hint="Net income" testId="kpi-compare-this" />
              <Kpi label={fmtPeriod(prior.period.slice(0, 7))} value={<Money cents={prior.netIncomeCents} />} hint="Net income" testId="kpi-compare-prior" />
              <Kpi label="Change" value={<Money cents={current.netIncomeCents - prior.netIncomeCents} />} tone={current.netIncomeCents - prior.netIncomeCents >= 0 ? "good" : "risk"} testId="kpi-compare-change" />
              <Kpi label="Lines" value={rows.filter((r) => !r.strong).length} testId="kpi-compare-lines" />
            </div>
            <SectionCard title="Income statement, line by line" bodyClassName="p-0" testId="card-portal-compare-rows">
              <DataGrid<CompareRow>
                rows={rows}
                rowKey={(r) => r.key}
                testId="grid-portal-compare"
                dense
                rowClassName={(r) => (r.strong ? "font-semibold" : "")}
                cols={[
                  { key: "label", label: "Line", render: (r) => r.label },
                  { key: "this", label: fmtPeriod(current.period.slice(0, 7)), align: "right", render: (r) => <Money cents={r.thisCents} /> },
                  { key: "prior", label: fmtPeriod(prior.period.slice(0, 7)), align: "right", render: (r) => <Money cents={r.priorCents} /> },
                  { key: "diff", label: "Change", align: "right", render: (r) => <Money cents={r.thisCents - r.priorCents} /> },
                ]}
              />
            </SectionCard>
          </>
        );
      }}
    </QueryBody>
  );
}

function compareRows(a: StatementSection[], b: StatementSection[]): CompareRow[] {
  const out: CompareRow[] = [];
  const codes = Array.from(new Set([...a.map((s) => s.code), ...b.map((s) => s.code)]));
  for (const code of codes) {
    const sa = a.find((s) => s.code === code);
    const sb = b.find((s) => s.code === code);
    const accounts = Array.from(new Set([...(sa?.lines ?? []).map((l) => l.accountNumber), ...(sb?.lines ?? []).map((l) => l.accountNumber)])).sort();
    for (const acct of accounts) {
      const la = sa?.lines.find((l) => l.accountNumber === acct);
      const lb = sb?.lines.find((l) => l.accountNumber === acct);
      out.push({ key: `${code}-${acct}`, label: `${acct} ${(la ?? lb)!.name}`, thisCents: la?.presentedCents ?? 0, priorCents: lb?.presentedCents ?? 0, strong: false });
    }
    out.push({ key: `${code}-total`, label: `Total ${(sa ?? sb)!.title.toLowerCase()}`, thisCents: sa?.totalCents ?? 0, priorCents: sb?.totalCents ?? 0, strong: true });
  }
  return out;
}
