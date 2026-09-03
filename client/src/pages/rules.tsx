import { Switch } from "@/components/ui/switch";
import { DataGrid, EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { acct } from "@/data/coa";
import { fmtDate } from "@/lib/money";

export default function Rules() {
  const { ds, activeClient, activeClientId, loading, loadError, reload, toggleRule } = useApp();
  const rules = ds.rules.filter((r) => r.clientId === activeClientId);
  const hits = rules.reduce((s, r) => s + r.hits, 0);
  const active = rules.filter((r) => r.active).length;

  return (
    <>
      <PageHeader
        title="Categorization rules"
        subtitle={`Rules do the repetitive coding for ${activeClient.dba}. Each one shows how many transactions it has caught so you can retire the ones that stopped earning their keep.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Rules on file" value={rules.length} testId="kpi-rules" />
        <Kpi label="Currently active" value={active} tone={active === rules.length ? "good" : "watch"} testId="kpi-active" />
        <Kpi label="Transactions matched" value={hits} hint="Since the rule was created" testId="kpi-hits" />
        <Kpi
          label="Coding handled by rules"
          value={`${Math.min(99, Math.round((hits / Math.max(1, ds.txns.filter((t) => t.clientId === activeClientId).length)) * 100))}%`}
          hint="Share of this client's feed"
          testId="kpi-coverage"
        />
      </div>

      <SectionCard bodyClassName="p-0" testId="card-rules">
        <DataGrid
          rows={rules}
          rowKey={(r) => r.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          empty={
            <EmptyState
              title="No rules yet for this client"
              body="Open the transaction feed, pick a repeat vendor, and choose Make a rule. It will show up here."
            />
          }
          cols={[
            {
              key: "name",
              label: "Rule",
              mobile: "title",
              render: (r) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.matchType} {'"'}
                    {r.matchValue}
                    {'"'}
                  </p>
                </div>
              ),
            },
            {
              key: "account",
              label: "Posts to",
              mobile: "row",
              render: (r) => (
                <span className="text-sm">
                  {acct(r.accountId).code} {acct(r.accountId).name}
                </span>
              ),
            },
            { key: "class", label: "Class", mobile: "row", render: (r) => <span className="text-sm">{r.klass || "Not set"}</span> },
            { key: "hits", label: "Matches", align: "right", mobile: "value", render: (r) => <span className="tnum">{r.hits}</span> },
            {
              key: "created",
              label: "Created",
              mobile: "row",
              render: (r) => (
                <div className="text-xs text-muted-foreground">
                  <p>{fmtDate(r.createdAt)}</p>
                  <p>{r.createdBy}</p>
                </div>
              ),
            },
            {
              key: "active",
              label: "Active",
              align: "right",
              mobile: "row",
              render: (r) => (
                <div className="flex items-center justify-end gap-2">
                  {r.active ? <Pill tone="good">On</Pill> : <Pill>Off</Pill>}
                  <Switch checked={r.active} onCheckedChange={() => toggleRule(r.id)} aria-label="Toggle rule" data-testid={`switch-rule-${r.id}`} />
                </div>
              ),
            },
          ]}
        />
      </SectionCard>

      <SectionCard title="How the engine decides" description="Plain rules, no black box.">
        <ol className="space-y-2 text-sm">
          {[
            "An exact vendor match on an active rule wins first and posts with full confidence.",
            "A description match on an active rule comes next and carries the rule name into the audit trail.",
            "If no rule fires, the engine looks at how the same vendor was coded in the last six months and offers that as a suggestion.",
            "Anything still unmatched is parked in 1990 Suspense on the balance sheet with a reason code, so it shows up on the review list and blocks the close instead of quietly reducing profit.",
          ].map((t, i) => (
            <li key={i} className="flex gap-3">
              <span className="tnum mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-muted text-xs font-medium">{i + 1}</span>
              <span className="text-muted-foreground">{t}</span>
            </li>
          ))}
        </ol>
      </SectionCard>
    </>
  );
}
