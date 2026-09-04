/**
 * One client's setup record, at /portal/clients/:id.
 *
 * Where the setup wizard lands. When it arrives with ?setup=done the success
 * banner names the four setup runs that just wrote, so the person who pressed
 * Finish can see what happened rather than guessing from a toast that has
 * already faded.
 *
 * COMPLIANCE. Everything on this page is a record of what the client already
 * is. The entity type and the fiscal year end are shown because the books need
 * them, not because anyone here picked them. Nothing was filed and no agent
 * service was performed.
 */

import { useMemo } from "react";
import { useRoute } from "wouter";
import { Check } from "lucide-react";
import { EmptyState, KeyValue, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { INDUSTRY_OPTIONS } from "@/lib/intake-templates";
import { fmtDate } from "@/lib/money";

/** True when the wizard just routed here. Query only, nothing is stored. */
function cameFromWizard(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("setup") === "done";
}

const RUN_SUMMARY: ReadonlyArray<{ type: string; text: string }> = [
  { type: "INTAKE-BUILD-CHART", text: "chart of accounts seeded from the chosen template, existing accounts left alone" },
  { type: "INTAKE-SEED-TASKS", text: "practice task catalog seeded and the first period scheduled" },
  { type: "INTAKE-OPEN-REQUESTS", text: "opening document asks raised, nothing emailed" },
  { type: "SETUP-IMPORT-BALANCES", text: "opening balance entry posted at the cutover, offset to 3900" },
];

export default function PortalClientDetail() {
  const { ds } = useApp();
  const [, params] = useRoute("/portal/clients/:id");
  const id = params?.id ?? "";
  const client = ds.clients.find((c) => c.id === id);
  const fromWizard = useMemo(cameFromWizard, []);

  if (client === undefined) {
    return (
      <>
        <PageHeader title="Client not found" subtitle="No client on this workspace carries that id." />
        <EmptyState title="Nothing to show" body="Open the client book and pick a client from the list." />
      </>
    );
  }

  const banks = ds.bankAccounts.filter((b) => b.clientId === client.id);
  const profiles = ds.mappingProfiles.filter((p) => p.clientId === client.id);
  const tasks = ds.tasks.filter((t) => t.clientId === client.id);
  const industryLabel = INDUSTRY_OPTIONS.find((o) => o.value === client.industryTemplate)?.label ?? "Not built from a template";

  return (
    <>
      <PageHeader
        title={client.dba}
        subtitle={`${client.legalName}. Setup record and the accounts the books read from.`}
        actions={client.testCompany === true ? <Pill tone="info">self checking company</Pill> : null}
      />

      {fromWizard ? (
        <div className="mb-4 rounded-md border border-positive/40 bg-positive-soft px-3 py-2.5 text-xs" data-testid="banner-setup-done">
          <p className="flex items-center gap-1.5 font-medium text-positive">
            <Check className="h-3.5 w-3.5" /> Setup finished. Four runs applied in order.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
            {RUN_SUMMARY.map((r) => (
              <li key={r.type} data-testid={`row-run-${r.type}`}>
                <span className="tnum font-medium">{r.type}</span>, {r.text}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted-foreground">
            No email was sent by any of this. Portal invites are recorded in the audit log only.
          </p>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Bank and card accounts" value={String(banks.length)} testId="kpi-banks" />
        <Kpi label="Mapping profiles" value={String(profiles.length)} testId="kpi-profiles" />
        <Kpi label="Scheduled tasks" value={String(tasks.length)} testId="kpi-tasks" />
        <Kpi label="Stage" value={client.onboardingStage} testId="kpi-stage" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Setup record" description="What the client already is. Recorded here because the books need it.">
          <KeyValue
            items={[
              { label: "Legal name", value: client.legalName },
              { label: "Entity type", value: client.entityType },
              { label: "EIN", value: client.ein },
              { label: "Fiscal year end", value: client.fiscalYearEnd },
              { label: "Cutover date", value: client.cutoverDate === undefined ? "Not set by a wizard" : fmtDate(client.cutoverDate) },
              { label: "Industry template", value: industryLabel },
              { label: "Service lead", value: client.lead },
            ]}
          />
        </SectionCard>

        <SectionCard title="Contacts" bodyClassName="p-0">
          <ul className="divide-y divide-border">
            {client.contacts.map((c) => (
              <li key={c.id} className="px-4 py-2.5 text-xs" data-testid={`row-contact-${c.id}`}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Pill tone="neutral">{c.role}</Pill>
                </div>
                <p className="mt-0.5 text-muted-foreground">{c.email}</p>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Accounts and how activity reaches the books" bodyClassName="p-0">
          {banks.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">No accounts on this client yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Ledger</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((b) => {
                  const profile = profiles.find((p) => p.bankAccountIds.includes(b.id));
                  return (
                    <tr key={b.id} className="border-b border-border/60" data-testid={`row-bank-${b.id}`}>
                      <td className="px-4 py-1.5">{b.institution} {b.nickname} {b.last4}</td>
                      <td className="tnum px-4 py-1.5">{b.glAccountId}</td>
                      <td className="px-4 py-1.5">
                        {b.statementSource}
                        {profile === undefined ? null : <span className="text-muted-foreground">, {profile.name}</span>}
                        {b.statementSource === "PDF upload" ? (
                          <span className="block text-muted-foreground">filed as a document, we do not parse PDF statements</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="Mapping profiles on this client" bodyClassName="p-0">
          {profiles.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">None. No account here imports from a spreadsheet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {profiles.map((p) => (
                <li key={p.id} className="px-4 py-2.5 text-xs" data-testid={`row-profile-${p.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Pill tone="neutral">{p.fileFormat.toUpperCase()}</Pill>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    {String(p.columns.length)} columns, dates read as {p.dateFormat}, matched by header text only
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
