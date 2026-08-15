import { useMemo } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, KeyValue, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { clientRollup } from "@/data/derive";
import { fmtPeriod, fmtTimestamp, usd } from "@/lib/money";
import { SCOPE_LABELS } from "@/data/labels";

export default function ClientBook() {
  const { ds, activeClient, activeClientId, setActiveClient, period, loading, loadError, reload, setPlane } = useApp();
  const [, navigate] = useLocation();
  const roll = useMemo(() => clientRollup(ds, activeClientId, period), [ds, activeClientId, period]);
  const banks = ds.bankAccounts.filter((b) => b.clientId === activeClientId);
  const tasks = ds.tasks.filter((t) => t.clientId === activeClientId && t.period === period);
  const comms = ds.comms.filter((c) => c.clientId === activeClientId).slice(0, 5);

  return (
    <>
      <PageHeader
        title={activeClient.dba}
        subtitle={`${activeClient.legalName}. Filed as ${activeClient.entityType}, fiscal year ends ${activeClient.fiscalYearEnd}. Engagement led by ${activeClient.lead}.`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPlane("portal");
                navigate("/portal");
              }}
              data-testid="button-view-as-client"
            >
              View the client portal
            </Button>
            <Button size="sm" onClick={() => navigate("/close")} data-testid="button-open-close">
              Open the close checklist
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2" data-testid="client-quickswitch">
        {ds.clients.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveClient(c.id)}
            className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
              c.id === activeClientId ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`button-client-${c.id}`}
          >
            {c.shortName}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={`Revenue, ${fmtPeriod(period)}`} value={usd(roll.revenue)} testId="kpi-client-revenue" />
        <Kpi label="Net income" value={usd(roll.netIncome)} tone={roll.netIncome >= 0 ? "good" : "risk"} testId="kpi-client-net" />
        <Kpi label="Cash on hand" value={usd(roll.cash)} hint={`${banks.length} accounts connected`} testId="kpi-client-cash" />
        <Kpi
          label="Open work"
          value={roll.tasksOpen}
          hint={`${roll.openItems} client requests, ${roll.needsReview} to code`}
          tone={roll.tasksOverdue ? "risk" : roll.tasksOpen ? "watch" : "good"}
          testId="kpi-client-work"
        />
      </div>

      <Tabs defaultValue="profile">
        <TabsList data-testid="tabs-client">
          <TabsTrigger value="profile" data-testid="tab-profile">Profile</TabsTrigger>
          <TabsTrigger value="access" data-testid="tab-access">Access and roles</TabsTrigger>
          <TabsTrigger value="accounts" data-testid="tab-accounts">Accounts and systems</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">Prior records</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 space-y-4">
          <SectionCard title="Business profile">
            <KeyValue
              items={[
                { label: "Legal name", value: activeClient.legalName },
                { label: "Doing business as", value: activeClient.dba },
                { label: "Entity type", value: activeClient.entityType },
                { label: "EIN", value: <span className="tnum">{activeClient.ein}</span> },
                { label: "Fiscal year end", value: activeClient.fiscalYearEnd },
                { label: "Address", value: activeClient.address },
                { label: "Industry", value: activeClient.industry },
                { label: "Onboarding stage", value: <Pill tone={activeClient.onboardingStage === "Live" ? "good" : "watch"}>{activeClient.onboardingStage}</Pill> },
                { label: "Tracking dimensions", value: `${activeClient.classes.length} classes, ${activeClient.locations.length} locations, ${activeClient.jobs.length} jobs` },
              ]}
            />
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Ownership" bodyClassName="p-0">
              <DataGrid
                rows={activeClient.owners}
                rowKey={(o) => o.id}
                loading={loading}
                error={loadError}
                onRetry={reload}
                cols={[
                  { key: "name", label: "Owner", mobile: "title", render: (o) => <span className="font-medium">{o.name}</span> },
                  { key: "role", label: "Role", mobile: "sub", render: (o) => <span className="text-sm text-muted-foreground">{o.role}</span> },
                  { key: "pct", label: "Ownership", align: "right", mobile: "value", render: (o) => <span className="tnum">{o.ownershipPct}%</span> },
                ]}
              />
            </SectionCard>

            <SectionCard title="Engagement" description="Fees, start date, and the signature on file.">
              <KeyValue
                items={[
                  { label: "Monthly fee", value: <Money cents={activeClient.engagement.monthlyFeeCents} /> },
                  { label: "Cleanup fee", value: <Money cents={activeClient.engagement.cleanupFeeCents} /> },
                  { label: "Start date", value: activeClient.engagement.startDate },
                  { label: "Signed by", value: activeClient.engagement.signedBy || "Not signed yet" },
                  { label: "Signed at", value: activeClient.engagement.signedAt ? fmtTimestamp(activeClient.engagement.signedAt) : "Pending" },
                  { label: "Signature method", value: activeClient.engagement.signatureMode === "drawn" ? "Drawn on screen" : "Typed name" },
                ]}
              />
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Scope of service</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {activeClient.scope.map((s) => (
                    <Pill key={s} tone="info">
                      {SCOPE_LABELS[s]}
                    </Pill>
                  ))}
                </div>
              </div>
            </SectionCard>
          </div>

          <SectionCard title={`Work assigned for ${fmtPeriod(period)}`} description="Generated from the engagement scope." bodyClassName="p-0">
            <DataGrid
              rows={tasks}
              rowKey={(t) => t.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              cols={[
                { key: "title", label: "Task", mobile: "title", render: (t) => t.title },
                { key: "scope", label: "From scope", mobile: "sub", render: (t) => <Pill>{SCOPE_LABELS[t.scopeSource] || t.scopeSource}</Pill> },
                { key: "assignee", label: "Owner", mobile: "row", render: (t) => t.assignee },
                { key: "due", label: "Due", align: "right", mobile: "row", render: (t) => <span className="tnum">{t.dueDate}</span> },
                {
                  key: "status",
                  label: "Status",
                  align: "right",
                  mobile: "value",
                  render: (t) => (
                    <Pill tone={t.status === "Done" ? "good" : t.status === "Blocked" ? "risk" : t.status === "Not started" ? "neutral" : "watch"}>
                      {t.status}
                    </Pill>
                  ),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Recent conversation" description="Last five entries from the communication log." bodyClassName="p-0">
            <DataGrid
              rows={comms}
              rowKey={(c) => c.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              cols={[
                {
                  key: "subject",
                  label: "Subject",
                  mobile: "title",
                  render: (c) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.subject}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.body}</p>
                    </div>
                  ),
                },
                { key: "who", label: "Who", mobile: "sub", render: (c) => c.who },
                { key: "channel", label: "Channel", mobile: "row", render: (c) => <Pill>{c.channel}</Pill> },
                { key: "at", label: "When", align: "right", mobile: "row", render: (c) => <span className="tnum text-xs">{fmtTimestamp(c.at)}</span> },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="access" className="mt-4 space-y-4">
          <SectionCard
            title="People with portal access"
            description="Approval rights and multi factor status are set per person. Passwords are never collected here."
            bodyClassName="p-0"
          >
            <DataGrid
              rows={activeClient.contacts}
              rowKey={(c) => c.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              cols={[
                {
                  key: "name",
                  label: "Person",
                  mobile: "title",
                  render: (c) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                    </div>
                  ),
                },
                { key: "role", label: "Role", mobile: "sub", render: (c) => <Pill tone="info">{c.role}</Pill> },
                {
                  key: "pay",
                  label: "Approves payments",
                  mobile: "row",
                  render: (c) => (c.canApprovePayments ? <Pill tone="good">Yes</Pill> : <Pill>No</Pill>),
                },
                {
                  key: "je",
                  label: "Approves entries",
                  mobile: "row",
                  render: (c) => (c.canApproveJournalEntries ? <Pill tone="good">Yes</Pill> : <Pill>No</Pill>),
                },
                {
                  key: "mfa",
                  label: "Multi factor",
                  align: "right",
                  mobile: "value",
                  render: (c) =>
                    c.mfaRequired ? (
                      <span className="inline-flex items-center gap-1 text-xs text-positive">
                        <ShieldCheck className="h-3.5 w-3.5" /> Required
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <ShieldAlert className="h-3.5 w-3.5" /> Off
                      </span>
                    ),
                },
              ]}
            />
          </SectionCard>
          <div className="rounded-md border border-warning/40 bg-warning-soft p-4 text-sm">
            <p className="font-medium text-warning">Credentials are never stored in Ledger Legends</p>
            <p className="mt-1 text-muted-foreground">
              Access to a client system is requested through that vendor and granted to a named user. If a client offers a login and
              password, decline it and send them the accountant invite instructions instead.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="accounts" className="mt-4 space-y-4">
          <SectionCard title="Bank, card, and processor accounts" bodyClassName="p-0">
            <DataGrid
              rows={banks}
              rowKey={(b) => b.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              cols={[
                {
                  key: "acct",
                  label: "Account",
                  mobile: "title",
                  render: (b) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{b.nickname}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {b.institution}, ending {b.last4}
                      </p>
                    </div>
                  ),
                },
                { key: "kind", label: "Type", mobile: "sub", render: (b) => <Pill>{b.kind}</Pill> },
                { key: "currency", label: "Currency", mobile: "row", render: (b) => b.currency },
                { key: "gl", label: "Maps to", mobile: "row", render: (b) => b.glAccountId },
                { key: "source", label: "Statements", mobile: "row", render: (b) => b.statementSource },
                {
                  key: "rec",
                  label: "Reconciled monthly",
                  align: "right",
                  mobile: "value",
                  render: (b) => (b.needsReconciling ? <Pill tone="good">Yes</Pill> : <Pill>No</Pill>),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Systems inventory" description="What the client runs and what level of access the firm holds." bodyClassName="p-0">
            <DataGrid
              rows={activeClient.systems}
              rowKey={(s) => s.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              cols={[
                { key: "kind", label: "Category", mobile: "title", render: (s) => s.kind },
                { key: "vendor", label: "Vendor", mobile: "sub", render: (s) => <span className="font-medium">{s.vendor}</span> },
                {
                  key: "access",
                  label: "Access",
                  align: "right",
                  mobile: "value",
                  render: (s) => (
                    <Pill tone={s.accessStatus === "Admin" ? "good" : s.accessStatus === "No access" ? "risk" : "watch"}>{s.accessStatus}</Pill>
                  ),
                },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-4">
          <SectionCard title="What came before us">
            <KeyValue
              items={[
                { label: "Last financials prepared", value: activeClient.priorRecords.lastFinancials },
                { label: "Prior trial balance", value: activeClient.priorRecords.priorTrialBalance },
                { label: "Existing chart of accounts", value: activeClient.priorRecords.existingCoa },
              ]}
            />
          </SectionCard>
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Cleanup items carried in">
              {activeClient.priorRecords.cleanupItems.length ? (
                <ul className="space-y-2">
                  {activeClient.priorRecords.cleanupItems.map((c, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No cleanup was needed for this client.</p>
              )}
            </SectionCard>
            <SectionCard title="Reconciliations outstanding at takeover">
              {activeClient.priorRecords.outstandingRecs.length ? (
                <ul className="space-y-2">
                  {activeClient.priorRecords.outstandingRecs.map((c, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Every account was current when we took the file.</p>
              )}
            </SectionCard>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
