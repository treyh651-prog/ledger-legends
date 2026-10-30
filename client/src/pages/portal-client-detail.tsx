/**
 * One client's setup record, at /portal/clients/:id.
 *
 * Where the setup wizard lands. When it arrives with ?setup=done the success
 * banner names the intake runs that just wrote, so the person who pressed
 * Finish can see what happened rather than guessing from a toast that has
 * already faded.
 *
 * Reads GET /api/firm/clients/:id for the client and its engagement and
 * GET /api/firm/clients/:id/setup for bank accounts, mapping profiles, and
 * tasks. Everything here is a record of what the client already is. Nothing
 * was filed and no agent service was performed.
 */

import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { Check, Pencil } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState, ErrorState, KeyValue, Kpi, LoadingRows, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { firmKeys, useClient, useClientSetup, useTriggerRun, errorMessage } from "@/api";
import { fmtDate, usd } from "@/lib/money";
import { tierMeta, isTierId } from "@shared/tiers";
import type { SetupClientPolicy } from "@shared/api";

/** True when the wizard just routed here. Query only, nothing is stored. */
function cameFromWizard(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("setup") === "done";
}

const RUN_SUMMARY: ReadonlyArray<{ type: string; text: string }> = [
  { type: "INTAKE-CREATE-CLIENT", text: "client and engagement rows written" },
  { type: "INTAKE-BUILD-CHART", text: "chart of accounts seeded from the chosen template, existing accounts left alone" },
  { type: "INTAKE-SEED-TASKS", text: "practice task catalog seeded and the first period scheduled" },
  { type: "INTAKE-OPEN-REQUESTS", text: "opening document asks raised, nothing emailed" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function PortalClientDetail() {
  const [, params] = useRoute("/portal/clients/:id");
  const id = params?.id ?? "";
  const client = useClient(id || null);
  const setup = useClientSetup(id || null);
  const fromWizard = useMemo(cameFromWizard, []);

  if (client.isError) {
    return (
      <>
        <PageHeader title="Client not found" subtitle="No client on this firm carries that id." />
        <ErrorState message={errorMessage(client.error)} onRetry={() => void client.refetch()} />
      </>
    );
  }
  if (client.isPending || !client.data) return <LoadingRows rows={6} cols={2} />;

  const c = client.data;
  const banks = setup.data?.bankAccounts ?? [];
  const profiles = setup.data?.mappingProfiles ?? [];
  const tasks = setup.data?.tasks ?? [];
  const policy = setup.data?.policy ?? null;
  const level = c.engagement && isTierId(c.engagement.serviceLevel) ? tierMeta(c.engagement.serviceLevel).name : c.engagement?.serviceLevel ?? "No engagement";

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={`${c.entityType}${c.isNonprofit ? ", nonprofit" : ""}. Setup record and the accounts the books read from.`}
        actions={<Pill tone={c.status === "active" ? "good" : "neutral"}>{c.status}</Pill>}
      />

      {fromWizard ? (
        <div className="mb-4 rounded-md border border-positive/40 bg-positive-soft px-3 py-2.5 text-xs" data-testid="banner-setup-done">
          <p className="flex items-center gap-1.5 font-medium text-positive">
            <Check className="h-3.5 w-3.5" /> Setup finished. The intake runs applied in order.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
            {RUN_SUMMARY.map((r) => (
              <li key={r.type} data-testid={`row-run-${r.type}`}>
                <span className="tnum font-medium">{r.type}</span>, {r.text}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted-foreground">No email was sent by any of this. The run log on the client book holds each run.</p>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Bank and card accounts" value={setup.data ? String(banks.length) : "…"} testId="kpi-banks" />
        <Kpi label="Mapping profiles" value={setup.data ? String(profiles.length) : "…"} testId="kpi-profiles" />
        <Kpi label="Scheduled tasks" value={setup.data ? String(tasks.length) : "…"} testId="kpi-tasks" />
        <Kpi label="Chart accounts" value={String(c.chartAccounts)} testId="kpi-chart" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Setup record" description="What the client already is. Recorded here because the books need it.">
          <KeyValue
            items={[
              { label: "Legal name", value: c.name },
              { label: "Entity type", value: c.entityType },
              { label: "Fiscal year end", value: MONTHS[c.fiscalYearEndMonth - 1] ?? String(c.fiscalYearEndMonth) },
              { label: "Books start", value: c.engagement ? fmtDate(c.engagement.startDate) : "No engagement" },
              { label: "Chart template", value: c.chartTemplateId ?? "Not built from a template" },
              { label: "Service level", value: level },
              { label: "Reporting basis", value: c.engagement?.reportingBasis ?? "No engagement" },
              { label: "Scope", value: c.scopeKeys.join(", ") || "None" },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Client policy"
          description="Overrides the coding and close runs read at execution. No row yet means every default applies."
          actions={id ? <ClientPolicyDialog clientId={id} policy={policy} /> : null}
        >
          <KeyValue
            items={[
              { label: "Functional currency", value: policy?.functionalCurrency ?? "USD (default)" },
              {
                label: "Capitalize over",
                value: policy?.capitalizeOverCents != null ? usd(policy.capitalizeOverCents) : `${usd(250000)} (default)`,
              },
              { label: "Gross at sale time", value: policy?.grossAtSaleTime ? "Yes" : "No" },
              { label: "Cleanup engagement", value: policy?.cleanupEngagement ? "Yes" : "No" },
              { label: "Entity kind", value: policy?.entityKind === "nonprofit" ? "Nonprofit" : "For profit (default)" },
              { label: "Retained earnings account", value: policy?.retainedEarningsAccount ?? "Not set" },
              { label: "Net assets without restrictions", value: policy?.netAssetsWithoutRestrictionsAccount ?? "Not set" },
              { label: "Net assets with restrictions", value: policy?.netAssetsWithRestrictionsAccount ?? "Not set" },
            ]}
          />
        </SectionCard>

        <SectionCard title="Engagement" description="From tenancy.engagements. Signing is on the client's portal.">
          {c.engagement ? (
            <KeyValue
              items={[
                { label: "Status", value: <Pill tone={c.engagement.status === "active" ? "good" : "neutral"}>{c.engagement.status}</Pill> },
                { label: "Signed", value: c.engagement.signedAt ? fmtDate(c.engagement.signedAt.slice(0, 10)) : "Not yet" },
                { label: "Open requests", value: String(c.openRequests) },
                { label: "Open suspense", value: String(c.openSuspense) },
                { label: "Open tasks", value: String(c.openTasks) },
              ]}
            />
          ) : (
            <EmptyState title="No engagement" body="INTAKE-CREATE-CLIENT writes the engagement with the client." />
          )}
        </SectionCard>

        <SectionCard title="Accounts and how activity reaches the books" bodyClassName="p-0">
          {setup.isError ? (
            <div className="p-4">
              <ErrorState message={errorMessage(setup.error)} onRetry={() => void setup.refetch()} />
            </div>
          ) : banks.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">No bank or card accounts on this client yet. The first import records them.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((b) => {
                  const profile = profiles.find((p) => p.accountNumber === b.accountNumber);
                  return (
                    <tr key={b.id} className="border-b border-border/60" data-testid={`row-bank-${b.id}`}>
                      <td className="px-4 py-1.5">
                        {b.nickname} <span className="tnum text-muted-foreground">{b.accountNumber}</span>
                      </td>
                      <td className="px-4 py-1.5">
                        {b.kind}
                        {b.isProcessorDestination ? <span className="text-muted-foreground">, processor destination</span> : null}
                      </td>
                      <td className="px-4 py-1.5">
                        {profile ? `${profile.institutionName} ${profile.fileFormat.toUpperCase()} profile` : "No mapping profile yet"}
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
            <p className="px-4 py-3 text-xs text-muted-foreground">None. No account here imports from a spreadsheet yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {profiles.map((p) => (
                <li key={p.id} className="px-4 py-2.5 text-xs" data-testid={`row-profile-${p.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {p.institutionName} {p.accountNumber}
                    </span>
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

/**
 * Edit affordance for ledger.client_policies, via CFG-EDIT-CLIENT-POLICY.
 * A Dialog rather than a Popover (EditRulePopover's pattern in rules.tsx):
 * eight fields, two of them account numbers only relevant depending on
 * entity kind, need more room than a small popover gives.
 */
function ClientPolicyDialog({ clientId, policy }: { clientId: string; policy: SetupClientPolicy | null }) {
  const [open, setOpen] = useState(false);
  const [functionalCurrency, setFunctionalCurrency] = useState("USD");
  const [capitalizeOverDollars, setCapitalizeOverDollars] = useState("2500");
  const [grossAtSaleTime, setGrossAtSaleTime] = useState(false);
  const [cleanupEngagement, setCleanupEngagement] = useState(false);
  const [entityKind, setEntityKind] = useState<"for_profit" | "nonprofit">("for_profit");
  const [retainedEarningsAccount, setRetainedEarningsAccount] = useState("");
  const [netAssetsWithoutRestrictionsAccount, setNetAssetsWithoutRestrictionsAccount] = useState("");
  const [netAssetsWithRestrictionsAccount, setNetAssetsWithRestrictionsAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setFunctionalCurrency(policy?.functionalCurrency ?? "USD");
    setCapitalizeOverDollars(policy?.capitalizeOverCents != null ? String(policy.capitalizeOverCents / 100) : "2500");
    setGrossAtSaleTime(policy?.grossAtSaleTime ?? false);
    setCleanupEngagement(policy?.cleanupEngagement ?? false);
    setEntityKind(policy?.entityKind ?? "for_profit");
    setRetainedEarningsAccount(policy?.retainedEarningsAccount ?? "");
    setNetAssetsWithoutRestrictionsAccount(policy?.netAssetsWithoutRestrictionsAccount ?? "");
    setNetAssetsWithRestrictionsAccount(policy?.netAssetsWithRestrictionsAccount ?? "");
    setError(null);
  };

  const save = async () => {
    setError(null);
    const fields: Record<string, unknown> = {};
    if (functionalCurrency !== (policy?.functionalCurrency ?? "USD")) fields.functionalCurrency = functionalCurrency;
    const parsedCents = Math.round(Number(capitalizeOverDollars) * 100);
    if (Number.isFinite(parsedCents) && parsedCents !== (policy?.capitalizeOverCents ?? 250000)) {
      fields.capitalizeOverCents = BigInt(parsedCents);
    }
    if (grossAtSaleTime !== (policy?.grossAtSaleTime ?? false)) fields.grossAtSaleTime = grossAtSaleTime;
    if (cleanupEngagement !== (policy?.cleanupEngagement ?? false)) fields.cleanupEngagement = cleanupEngagement;
    if (entityKind !== (policy?.entityKind ?? "for_profit")) fields.entityKind = entityKind;
    const retained = retainedEarningsAccount.trim() || null;
    if (retained !== (policy?.retainedEarningsAccount ?? null)) fields.retainedEarningsAccount = retained;
    const netWithout = netAssetsWithoutRestrictionsAccount.trim() || null;
    if (netWithout !== (policy?.netAssetsWithoutRestrictionsAccount ?? null)) fields.netAssetsWithoutRestrictionsAccount = netWithout;
    const netWith = netAssetsWithRestrictionsAccount.trim() || null;
    if (netWith !== (policy?.netAssetsWithRestrictionsAccount ?? null)) fields.netAssetsWithRestrictionsAccount = netWith;
    if (Object.keys(fields).length === 0) {
      setOpen(false);
      return;
    }
    const scope = { clientId, changeNote: "edited from the client setup record", fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-EDIT-CLIENT-POLICY", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-EDIT-CLIENT-POLICY",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: firmKeys.setup(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="client-policy-edit">
          <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit policy
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Client policy</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Functional currency</label>
              <Input value={functionalCurrency} onChange={(e) => setFunctionalCurrency(e.target.value.toUpperCase())} maxLength={3} data-testid="policy-currency" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Capitalize over ($)</label>
              <Input type="number" value={capitalizeOverDollars} onChange={(e) => setCapitalizeOverDollars(e.target.value)} data-testid="policy-capitalize" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={grossAtSaleTime} onChange={(e) => setGrossAtSaleTime(e.target.checked)} data-testid="policy-gross" />
            Gross booked at sale time
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cleanupEngagement} onChange={(e) => setCleanupEngagement(e.target.checked)} data-testid="policy-cleanup" />
            Cleanup engagement
          </label>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Entity kind</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={entityKind}
              onChange={(e) => setEntityKind(e.target.value as "for_profit" | "nonprofit")}
              data-testid="policy-entity-kind"
            >
              <option value="for_profit">For profit</option>
              <option value="nonprofit">Nonprofit</option>
            </select>
          </div>
          {entityKind === "for_profit" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Retained earnings account</label>
              <Input value={retainedEarningsAccount} onChange={(e) => setRetainedEarningsAccount(e.target.value)} placeholder="3200" data-testid="policy-retained" />
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Net assets without donor restrictions</label>
                <Input value={netAssetsWithoutRestrictionsAccount} onChange={(e) => setNetAssetsWithoutRestrictionsAccount(e.target.value)} placeholder="3100" data-testid="policy-net-without" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Net assets with donor restrictions (optional)</label>
                <Input value={netAssetsWithRestrictionsAccount} onChange={(e) => setNetAssetsWithRestrictionsAccount(e.target.value)} placeholder="3300" data-testid="policy-net-with" />
              </div>
            </>
          )}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="policy-save">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
