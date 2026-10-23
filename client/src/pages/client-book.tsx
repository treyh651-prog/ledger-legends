import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, KeyValue, Kpi, LoadingRows, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useClient, useClients, useCreateClient, useRunHistory, useTriggerRun, errorMessage, type CreateClientResult } from "@/api";
import type { RunOutcomeDto } from "@shared/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import { isUuid } from "@/lib/period";
import { SCOPE_LABELS, SCOPE_OPTIONS } from "@/data/labels";
import { TIER_ORDER, TIERS } from "@shared/tiers";
import { ENTITY_TYPES, INDUSTRIES, type CreateClientInput, type EntityType, type Industry, type ScopeKey } from "@shared/api";
import { NO_CLIENTS_COPY } from "./firm-overview";

/**
 * The client book, read from GET /api/firm/clients and one client's detail
 * from GET /api/firm/clients/:id. Adding a client is one POST that the server
 * turns into four intake runs; the outcome of each run is shown as returned.
 */
export default function ClientBook() {
  const { activeClientId, setActiveClient, setPlane } = useApp();
  const [, navigate] = useLocation();
  const list = useClients();
  const clients = list.data?.items ?? [];
  const [adding, setAdding] = useState(false);

  // The store's active client may still be a mock id. Use it only when it
  // names a client the API knows; otherwise land on the first API client.
  const selectedId = useMemo(() => {
    if (isUuid(activeClientId) && clients.some((c) => c.id === activeClientId)) return activeClientId;
    return clients[0]?.id ?? null;
  }, [activeClientId, clients]);
  useEffect(() => {
    if (selectedId && selectedId !== activeClientId) setActiveClient(selectedId);
  }, [selectedId, activeClientId, setActiveClient]);

  const detail = useClient(selectedId);
  const history = useRunHistory(selectedId, null, 20);
  const c = detail.data;

  if (list.isPending) {
    return (
      <>
        <PageHeader title="Clients" subtitle="Loading the client book." />
        <LoadingRows rows={6} cols={4} />
      </>
    );
  }
  if (list.isError) {
    return (
      <>
        <PageHeader title="Clients" />
        <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
      </>
    );
  }
  if (clients.length === 0 || adding) {
    return (
      <>
        <PageHeader
          title={clients.length === 0 ? "Clients" : "Add a client"}
          subtitle={clients.length === 0 ? NO_CLIENTS_COPY : "One form, four intake runs."}
          actions={
            clients.length ? (
              <Button size="sm" variant="outline" onClick={() => setAdding(false)} data-testid="button-cancel-add">
                Back to the book
              </Button>
            ) : null
          }
        />
        {clients.length === 0 ? (
          <EmptyState
            title={NO_CLIENTS_COPY}
            body="Fill in the form below. The server writes the client, builds its chart, seeds its workload, and opens its first document requests."
          />
        ) : null}
        <CreateClientForm
          onCreated={(r) => {
            if (r.client) {
              setActiveClient(r.client.id);
              setAdding(false);
            }
          }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={c?.name ?? "Client"}
        subtitle={
          c
            ? `Filed as ${c.entityType}, fiscal year ends month ${c.fiscalYearEndMonth}. ${c.engagement ? `${TIERS[c.engagement.serviceLevel as keyof typeof TIERS]?.name ?? c.engagement.serviceLevel} engagement, ${c.engagement.status}.` : "No engagement on file."}`
            : undefined
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="button-add-client">
              Add a client
            </Button>
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
        {clients.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setActiveClient(x.id)}
            className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
              x.id === selectedId ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`button-client-${x.id}`}
          >
            {x.name}
          </button>
        ))}
      </div>

      {detail.isError ? <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Chart accounts" value={c ? c.chartAccounts : "\u2026"} testId="kpi-client-accounts" />
        <Kpi label="Open tasks" value={c ? c.openTasks : "\u2026"} tone={c && c.openTasks ? "watch" : "good"} testId="kpi-client-work" />
        <Kpi label="Open requests" value={c ? c.openRequests : "\u2026"} tone={c && c.openRequests ? "watch" : "good"} testId="kpi-client-requests" />
        <Kpi label="In suspense" value={c ? c.openSuspense : "\u2026"} tone={c && c.openSuspense ? "watch" : "good"} testId="kpi-client-suspense" />
      </div>

      <Tabs defaultValue="profile">
        <TabsList data-testid="tabs-client">
          <TabsTrigger value="profile" data-testid="tab-profile">Profile</TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4 space-y-4">
          <SectionCard title="Business profile">
            {detail.isPending ? (
              <LoadingRows rows={4} cols={2} />
            ) : c ? (
              <KeyValue
                items={[
                  { label: "Name", value: c.name },
                  { label: "Entity type", value: c.entityType },
                  { label: "Nonprofit", value: c.isNonprofit ? "Yes" : "No" },
                  { label: "Fiscal year end", value: `Month ${c.fiscalYearEndMonth}` },
                  { label: "Currency", value: c.functionalCurrency },
                  { label: "Chart template", value: c.chartTemplateId ?? "none" },
                  {
                    label: "Stage",
                    value: <Pill tone={c.status === "active" ? "good" : "watch"}>{c.status === "active" ? "Live" : c.status === "archived" ? "Archived" : "Onboarding"}</Pill>,
                  },
                  { label: "Open period", value: c.openPeriod ? fmtPeriod(c.openPeriod.slice(0, 7)) : "none" },
                  { label: "Latest closed period", value: c.latestClosedPeriod ? fmtPeriod(c.latestClosedPeriod.slice(0, 7)) : "none" },
                  { label: "Last run", value: c.lastRunAt ? fmtTimestamp(c.lastRunAt) : "never" },
                ]}
              />
            ) : null}
          </SectionCard>

          <SectionCard title="Engagement" description="Service level, basis, and start date.">
            {c?.engagement ? (
              <>
                <KeyValue
                  items={[
                    { label: "Service level", value: TIERS[c.engagement.serviceLevel as keyof typeof TIERS]?.name ?? c.engagement.serviceLevel },
                    { label: "Status", value: <Pill tone={c.engagement.status === "active" ? "good" : "info"}>{c.engagement.status}</Pill> },
                    { label: "Reporting basis", value: c.engagement.reportingBasis },
                    { label: "Start date", value: c.engagement.startDate },
                    { label: "Signed at", value: c.engagement.signedAt ? fmtTimestamp(c.engagement.signedAt) : "Not signed yet" },
                  ]}
                />
                <div className="mt-4 border-t border-border pt-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Scope of service</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.scopeKeys.map((s) => (
                      <Pill key={s} tone="info">
                        {SCOPE_LABELS[s] ?? s}
                      </Pill>
                    ))}
                  </div>
                </div>
                {c.engagement.status !== "active" && c.engagement.status !== "terminated" ? (
                  <ActivatePanel clientId={c.id} engagementId={c.engagement.id} signedAt={c.engagement.signedAt} />
                ) : null}
              </>
            ) : (
              <EmptyState title="No engagement" body="The intake run writes a draft engagement with the client." />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <SectionCard title="Run log" description="Every run against this client, newest first." bodyClassName="p-0">
            <DataGrid
              rows={history.data?.items ?? []}
              rowKey={(r) => r.executionId}
              loading={history.isPending}
              error={history.isError ? errorMessage(history.error) : null}
              onRetry={() => void history.refetch()}
              empty={<EmptyState title="No runs yet" body="Intake posts the first four." />}
              cols={[
                { key: "run", label: "Run", mobile: "title", render: (r) => <span className="font-mono text-xs">{r.runType}</span> },
                { key: "mode", label: "Mode", mobile: "sub", render: (r) => <span className="text-sm">{r.mode}</span> },
                {
                  key: "status",
                  label: "Status",
                  mobile: "row",
                  render: (r) => <Pill tone={r.status === "failed" || r.status === "refused" ? "risk" : r.status.startsWith("completed") ? "good" : "neutral"}>{r.status}</Pill>,
                },
                { key: "at", label: "Started", mobile: "row", render: (r) => <span className="text-xs text-muted-foreground">{fmtTimestamp(r.startedAt)}</span> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CreateClientForm({ onCreated }: { onCreated: (r: CreateClientResult) => void }) {
  const create = useCreateClient();
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<EntityType>("LLC");
  const [industry, setIndustry] = useState<Industry>(INDUSTRIES[0]);
  const [serviceLevel, setServiceLevel] = useState<string>("ledger");
  const [startDate, setStartDate] = useState(today());
  const [fye, setFye] = useState("12");
  const [scopes, setScopes] = useState<ScopeKey[]>(["monthly_close"]);
  const result = create.data;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: CreateClientInput = {
      name,
      entityType,
      industry,
      serviceLevel,
      startDate,
      fiscalYearEndMonth: Number(fye),
      isNonprofit: entityType === "Nonprofit",
      scopeKeys: scopes,
    };
    create.mutate(body, { onSuccess: onCreated });
  };

  return (
    <SectionCard title="New client" description="Everything the four intake runs need." testId="card-create-client">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="client-name">Business name</Label>
          <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} data-testid="input-client-name" />
        </div>
        <div className="space-y-1.5">
          <Label>Entity type</Label>
          <Select value={entityType} onValueChange={(v) => setEntityType(v as EntityType)}>
            <SelectTrigger data-testid="select-entity-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ENTITY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Industry</Label>
          <Select value={industry} onValueChange={(v) => setIndustry(v as Industry)}>
            <SelectTrigger data-testid="select-industry"><SelectValue /></SelectTrigger>
            <SelectContent>
              {INDUSTRIES.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Service level</Label>
          <Select value={serviceLevel} onValueChange={setServiceLevel}>
            <SelectTrigger data-testid="select-service-level"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIER_ORDER.map((t) => (
                <SelectItem key={t} value={t}>{TIERS[t].name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="client-start">Start date</Label>
          <Input id="client-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required data-testid="input-start-date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="client-fye">Fiscal year end month</Label>
          <Input id="client-fye" type="number" min={1} max={12} value={fye} onChange={(e) => setFye(e.target.value)} data-testid="input-fye" />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>Scope of service</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCOPE_OPTIONS.map((o) => {
              const key = o.key as ScopeKey;
              const on = scopes.includes(key);
              return (
                <label key={o.key} className="flex items-start gap-2 rounded-sm border border-border p-2 text-sm">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(v) => setScopes((s) => (v ? [...s, key] : s.filter((k) => k !== key)))}
                    data-testid={`checkbox-scope-${o.key}`}
                  />
                  <span>
                    <span className="font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.blurb}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button type="submit" disabled={create.isPending || !name.trim()} data-testid="button-create-client">
            {create.isPending ? "Running intake" : "Create the client"}
          </Button>
          {create.isError ? (
            <p className="text-sm text-destructive" data-testid="text-create-error">{errorMessage(create.error)}</p>
          ) : null}
        </div>
      </form>

      {result ? (
        <div className="mt-4 border-t border-border pt-3" data-testid="create-client-runs">
          <p className="text-sm font-medium">{result.complete ? "Intake finished." : "Intake stopped before it finished."}</p>
          <ul className="mt-2 space-y-1">
            {result.runs.map((r) => (
              <li key={r.executionId} className="flex items-center gap-2 text-xs">
                <span className="font-mono">{r.runType}</span>
                <span className="text-muted-foreground">{r.mode}</span>
                <Pill tone={r.status === "failed" || r.status === "refused" ? "risk" : r.status.startsWith("completed") ? "good" : "neutral"}>{r.status}</Pill>
                {r.errors.length ? <span className="text-destructive">{r.errors[0].message}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}

/**
 * Activation of a draft engagement through INTAKE-ACTIVATE-ENGAGEMENT. The
 * portal grants features from the active engagement, so until this applies
 * the client's portal sees the floor tier. A letter signed in the system
 * needs only the button; a letter signed outside it needs the signer and the
 * day, which the run keeps as a pending vault document.
 */
function ActivatePanel({ clientId, engagementId, signedAt }: { clientId: string; engagementId: string; signedAt: string | null }) {
  const trigger = useTriggerRun(clientId);
  const [outside, setOutside] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signedOn, setSignedOn] = useState("");
  const [outcome, setOutcome] = useState<RunOutcomeDto | null>(null);
  const ready = signedAt !== null || (outside && signerName.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(signedOn));

  const activate = async () => {
    const scope: Record<string, unknown> = { engagementId };
    if (signedAt === null && outside) scope.signedOutside = { signerName: signerName.trim(), signedOn };
    try {
      const preview = await trigger.mutateAsync({ runCode: "INTAKE-ACTIVATE-ENGAGEMENT", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setOutcome(preview);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "INTAKE-ACTIVATE-ENGAGEMENT",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      setOutcome(applied);
    } catch {
      setOutcome(null);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border p-3" data-testid="panel-activate-engagement">
      <p className="text-xs text-muted-foreground">
        A draft engagement grants the portal nothing. Activate it once the engagement letter is signed.
      </p>
      {signedAt === null ? (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={outside} onCheckedChange={(v) => setOutside(v === true)} data-testid="check-signed-outside" />
            The letter was signed outside the system
          </label>
          {outside ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="signer-name">Signed by</Label>
                <Input id="signer-name" value={signerName} onChange={(e) => setSignerName(e.target.value)} data-testid="input-signer-name" />
              </div>
              <div>
                <Label htmlFor="signed-on">Signed on</Label>
                <Input id="signed-on" type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} data-testid="input-signed-on" />
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Not signed in the system yet. The client signs through the portal, or tick the box above.</p>
          )}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={!ready || trigger.isPending} onClick={() => void activate()} data-testid="button-activate-engagement">
          {trigger.isPending ? "Activating" : "Activate engagement"}
        </Button>
        {trigger.isError ? <span className="text-xs text-destructive">{errorMessage(trigger.error)}</span> : null}
        {outcome && outcome.status !== "completed" ? (
          <span className="text-xs text-destructive" data-testid="text-activate-refused">
            {outcome.errors[0]?.message ?? `The run finished ${outcome.status}.`}
          </span>
        ) : null}
        {outcome && outcome.status === "completed" && outcome.mode === "apply" ? (
          <span className="text-xs text-muted-foreground">Engagement active.</span>
        ) : null}
      </div>
    </div>
  );
}
