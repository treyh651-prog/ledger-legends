import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { Check, ChevronLeft, ChevronRight, Eraser, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Meter, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import type { IntakeAccountDraft, IntakeOwnerDraft, IntakePersonDraft, IntakeSystemDraft } from "@/store";
import { ACCESS_STATUSES, BANK_KINDS, CONTACT_ROLES, ENTITY_TYPES, SCOPE_OPTIONS, STATEMENT_SOURCES, SYSTEM_KINDS } from "@/data/labels";
import { usd } from "@/lib/money";
import type { ScopeKey } from "@/data/types";

const STEPS = [
  "Business profile",
  "Owners and contact",
  "Engagement scope",
  "Systems inventory",
  "Accounts inventory",
  "Prior records",
  "Engagement letter",
  "Signature",
  "Access and roles",
  "Review and open the file",
];

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function Intake() {
  const { intake, setIntake, intakeStep, setIntakeStep, intakeCompleteness, intakeTaskPreview, createClientFromIntake, resetIntake } = useApp();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { pct, sections } = intakeCompleteness();
  const step = intakeStep;

  const setOwners = (owners: IntakeOwnerDraft[]) => setIntake({ owners });
  const setSystems = (systems: IntakeSystemDraft[]) => setIntake({ systems });
  const setAccounts = (accounts: IntakeAccountDraft[]) => setIntake({ accounts });
  const setPeople = (people: IntakePersonDraft[]) => setIntake({ people });

  const taskPreview = intakeTaskPreview();

  return (
    <>
      <PageHeader
        title="New client intake"
        subtitle="Ten steps from first call to an open file. Everything you enter here drives the chart of accounts, the task list, and the portal requests."
        actions={
          <Button variant="outline" size="sm" onClick={resetIntake} data-testid="button-reset-intake">
            Start over
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <div className="space-y-4">
          <SectionCard title="Completeness" description={`${pct} percent of the file is filled in.`}>
            <Meter pct={pct} tone={pct > 75 ? "primary" : pct > 40 ? "warning" : "danger"} />
            <ul className="mt-3 space-y-1.5">
              {sections.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-xs">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                      s.done ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent"
                    }`}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className={s.done ? "" : "text-muted-foreground"}>{s.label}</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="Steps" bodyClassName="p-2">
            <ol className="space-y-0.5">
              {STEPS.map((s, i) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => setIntakeStep(i)}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors ${
                      i === step ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`button-step-${i}`}
                  >
                    <span className="tnum w-4 shrink-0 text-right text-[10px] text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{s}</span>
                  </button>
                </li>
              ))}
            </ol>
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title={`Step ${step + 1} of ${STEPS.length}, ${STEPS[step]}`} testId="card-intake-step">
            {step === 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Legal name">
                  <Input value={intake.legalName} onChange={(e) => setIntake({ legalName: e.target.value })} placeholder="Cedar Post Fabrication LLC" data-testid="input-legalName" />
                </Field>
                <Field label="Doing business as">
                  <Input value={intake.dba} onChange={(e) => setIntake({ dba: e.target.value })} placeholder="Cedar Post" data-testid="input-dba" />
                </Field>
                <Field label="Entity type">
                  <Select value={intake.entityType} onValueChange={(v) => setIntake({ entityType: v })}>
                    <SelectTrigger data-testid="select-entityType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENTITY_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="EIN" hint="Nine digits, formatted for you on the client record.">
                  <Input value={intake.ein} onChange={(e) => setIntake({ ein: e.target.value })} placeholder="87-4412093" data-testid="input-ein" />
                </Field>
                <Field label="Fiscal year end">
                  <Input value={intake.fiscalYearEnd} onChange={(e) => setIntake({ fiscalYearEnd: e.target.value })} data-testid="input-fye" />
                </Field>
                <Field label="Industry">
                  <Input value={intake.industry} onChange={(e) => setIntake({ industry: e.target.value })} placeholder="Metal fabrication" data-testid="input-industry" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Business address">
                    <Input value={intake.address} onChange={(e) => setIntake({ address: e.target.value })} placeholder="1420 SE Ninth Street, Bend, OR 97702" data-testid="input-address" />
                  </Field>
                </div>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Primary contact name">
                    <Input value={intake.primaryContactName} onChange={(e) => setIntake({ primaryContactName: e.target.value })} data-testid="input-contactName" />
                  </Field>
                  <Field label="Primary contact email">
                    <Input value={intake.primaryContactEmail} onChange={(e) => setIntake({ primaryContactEmail: e.target.value })} data-testid="input-contactEmail" />
                  </Field>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Owners</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOwners([...intake.owners, { id: `od-${Date.now()}`, name: "", ownershipPct: "", role: "Owner" }])}
                      data-testid="button-add-owner"
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Add owner
                    </Button>
                  </div>
                  <div className="space-y-3">
                    {intake.owners.map((o, i) => (
                      <div key={o.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_120px_140px_auto]">
                        <Input
                          value={o.name}
                          placeholder="Full name"
                          onChange={(e) => setOwners(intake.owners.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))}
                          data-testid={`input-owner-name-${i}`}
                        />
                        <Input
                          value={o.ownershipPct}
                          placeholder="Percent"
                          className="tnum"
                          onChange={(e) => setOwners(intake.owners.map((x) => (x.id === o.id ? { ...x, ownershipPct: e.target.value } : x)))}
                          data-testid={`input-owner-pct-${i}`}
                        />
                        <Input
                          value={o.role}
                          placeholder="Role"
                          onChange={(e) => setOwners(intake.owners.map((x) => (x.id === o.id ? { ...x, role: e.target.value } : x)))}
                          data-testid={`input-owner-role-${i}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setOwners(intake.owners.filter((x) => x.id !== o.id))}
                          aria-label="Remove owner"
                          data-testid={`button-remove-owner-${i}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Ownership adds to{" "}
                    <span className="tnum font-medium">{intake.owners.reduce((s, o) => s + (Number(o.ownershipPct) || 0), 0)}</span> percent.
                  </p>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                <div className="grid gap-2 sm:grid-cols-2">
                  {SCOPE_OPTIONS.map((s) => {
                    const on = intake.scope.includes(s.key as ScopeKey);
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() =>
                          setIntake({
                            scope: on ? intake.scope.filter((x) => x !== s.key) : [...intake.scope, s.key as ScopeKey],
                          })
                        }
                        className={`rounded-md border p-3 text-left transition-colors ${on ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/40"}`}
                        data-testid={`button-scope-${s.key}`}
                      >
                        <div className="flex items-start gap-2">
                          <Checkbox checked={on} className="mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{s.label}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{s.blurb}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recurring task list this scope creates
                  </p>
                  {taskPreview.length ? (
                    <ul className="mt-2 space-y-1.5" data-testid="list-task-preview">
                      {taskPreview.map((t, i) => (
                        <li key={i} className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 flex-1 truncate">{t.title}</span>
                          <span className="tnum shrink-0 text-xs text-muted-foreground">{t.estHours} h</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">Pick a service above and the monthly task list builds itself.</p>
                  )}
                  {taskPreview.length ? (
                    <p className="tnum mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                      {taskPreview.length} tasks, {taskPreview.reduce((s, t) => s + t.estHours, 0).toFixed(1)} hours per month
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p className="text-muted-foreground">
                    Record the vendor and the access level only. Ledger Legends has no field for a username or a password, and it never will.
                    Ask the client to send an accountant invite from inside their own system.
                  </p>
                </div>
                {intake.systems.map((s, i) => (
                  <div key={s.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[180px_1fr_180px_auto]">
                    <Select value={s.kind} onValueChange={(v) => setSystems(intake.systems.map((x) => (x.id === s.id ? { ...x, kind: v } : x)))}>
                      <SelectTrigger data-testid={`select-system-kind-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SYSTEM_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {k}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={s.vendor}
                      placeholder="Vendor, for example QuickBooks Online"
                      onChange={(e) => {
                        const v = e.target.value;
                        setSystems(intake.systems.map((x) => (x.id === s.id ? { ...x, vendor: v } : x)));
                        if (/password|passcode|login|pin|user ?name/i.test(v) && !intake.credentialWarningShown) {
                          setIntake({ credentialWarningShown: true });
                          toast({
                            title: "That belongs somewhere else",
                            description: "Login details are not stored in Ledger Legends. Request accountant access from the vendor instead.",
                          });
                        }
                      }}
                      data-testid={`input-system-vendor-${i}`}
                    />
                    <Select value={s.accessStatus} onValueChange={(v) => setSystems(intake.systems.map((x) => (x.id === s.id ? { ...x, accessStatus: v } : x)))}>
                      <SelectTrigger data-testid={`select-system-access-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCESS_STATUSES.map((k) => (
                          <SelectItem key={k} value={k}>
                            {k}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSystems(intake.systems.filter((x) => x.id !== s.id))}
                      aria-label="Remove system"
                      data-testid={`button-remove-system-${i}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSystems([...intake.systems, { id: `sd-${Date.now()}`, kind: "Other", vendor: "", accessStatus: "No access" }])}
                  data-testid="button-add-system"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add a system
                </Button>
              </div>
            ) : null}

            {step === 4 ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  List every account that touches the books. Each one becomes a reconciliation line in the monthly close.
                </p>
                {intake.accounts.map((a, i) => (
                  <div key={a.id} className="space-y-3 rounded-md border border-border p-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_100px_auto]">
                      <Input
                        value={a.institution}
                        placeholder="Institution"
                        onChange={(e) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, institution: e.target.value } : x)))}
                        data-testid={`input-acct-institution-${i}`}
                      />
                      <Input
                        value={a.nickname}
                        placeholder="Nickname"
                        onChange={(e) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, nickname: e.target.value } : x)))}
                        data-testid={`input-acct-nickname-${i}`}
                      />
                      <Input
                        value={a.last4}
                        placeholder="Last 4"
                        className="tnum"
                        maxLength={4}
                        onChange={(e) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, last4: e.target.value } : x)))}
                        data-testid={`input-acct-last4-${i}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setAccounts(intake.accounts.filter((x) => x.id !== a.id))}
                        aria-label="Remove account"
                        data-testid={`button-remove-acct-${i}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Select value={a.kind} onValueChange={(v) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, kind: v } : x)))}>
                        <SelectTrigger data-testid={`select-acct-kind-${i}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BANK_KINDS.map((k) => (
                            <SelectItem key={k} value={k}>
                              {k}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={a.currency} onValueChange={(v) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, currency: v } : x)))}>
                        <SelectTrigger data-testid={`select-acct-currency-${i}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["USD", "CAD", "EUR", "GBP"].map((k) => (
                            <SelectItem key={k} value={k}>
                              {k}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={a.statementSource} onValueChange={(v) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, statementSource: v } : x)))}>
                        <SelectTrigger data-testid={`select-acct-source-${i}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATEMENT_SOURCES.map((k) => (
                            <SelectItem key={k} value={k}>
                              {k}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={a.needsReconciling}
                          onCheckedChange={(v) => setAccounts(intake.accounts.map((x) => (x.id === a.id ? { ...x, needsReconciling: v } : x)))}
                          data-testid={`switch-acct-rec-${i}`}
                        />
                        Reconcile monthly
                      </label>
                    </div>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setAccounts([
                      ...intake.accounts,
                      { id: `ad-${Date.now()}`, institution: "", nickname: "", last4: "", kind: "Checking", currency: "USD", statementSource: "Bank feed", needsReconciling: true },
                    ])
                  }
                  data-testid="button-add-acct"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add an account
                </Button>
              </div>
            ) : null}

            {step === 5 ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Last financials prepared" hint="Who prepared them and through what date.">
                    <Input value={intake.priorFinancials} onChange={(e) => setIntake({ priorFinancials: e.target.value })} data-testid="input-priorFinancials" />
                  </Field>
                  <Field label="Prior trial balance">
                    <Input value={intake.priorTrialBalance} onChange={(e) => setIntake({ priorTrialBalance: e.target.value })} data-testid="input-priorTb" />
                  </Field>
                </div>
                <Field label="Existing chart of accounts">
                  <Input value={intake.existingCoa} onChange={(e) => setIntake({ existingCoa: e.target.value })} data-testid="input-existingCoa" />
                </Field>
                <Field label="Cleanup items, one per line">
                  <Textarea
                    rows={4}
                    value={intake.cleanupItems.join("\n")}
                    onChange={(e) => setIntake({ cleanupItems: e.target.value.split("\n").filter(Boolean) })}
                    data-testid="input-cleanupItems"
                  />
                </Field>
                <Field label="Reconciliations outstanding, one per line">
                  <Textarea
                    rows={3}
                    value={intake.outstandingRecs.join("\n")}
                    onChange={(e) => setIntake({ outstandingRecs: e.target.value.split("\n").filter(Boolean) })}
                    data-testid="input-outstandingRecs"
                  />
                </Field>
              </div>
            ) : null}

            {step === 6 ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Monthly fee in dollars">
                    <Input value={intake.monthlyFee} className="tnum" onChange={(e) => setIntake({ monthlyFee: e.target.value })} placeholder="950" data-testid="input-monthlyFee" />
                  </Field>
                  <Field label="Cleanup fee in dollars">
                    <Input value={intake.cleanupFee} className="tnum" onChange={(e) => setIntake({ cleanupFee: e.target.value })} placeholder="2400" data-testid="input-cleanupFee" />
                  </Field>
                  <Field label="Service start date">
                    <Input value={intake.startDate} onChange={(e) => setIntake({ startDate: e.target.value })} data-testid="input-startDate" />
                  </Field>
                </div>
                <div className="rounded-md border border-border bg-card p-4 text-sm leading-relaxed" data-testid="preview-engagement">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Engagement letter preview</p>
                  <h3 className="mt-3 text-base font-semibold">Bookkeeping services agreement</h3>
                  <p className="mt-3 text-muted-foreground">
                    This agreement is between Ledger Legends and {intake.legalName || "the client"}
                    {intake.dba ? `, doing business as ${intake.dba}` : ""}, with a service start date of {intake.startDate || "a date to be set"}.
                  </p>
                  <p className="mt-3 text-muted-foreground">Ledger Legends will perform the following work each month:</p>
                  <ul className="mt-2 space-y-1">
                    {intake.scope.length ? (
                      intake.scope.map((s) => (
                        <li key={s} className="flex gap-2">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{SCOPE_OPTIONS.find((o) => o.key === s)?.blurb}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-muted-foreground">No services selected yet.</li>
                    )}
                  </ul>
                  <p className="mt-3 text-muted-foreground">
                    The monthly fee is {intake.monthlyFee ? usd(Math.round(Number(intake.monthlyFee) * 100)) : "to be agreed"}, billed on the first
                    business day of each month. Cleanup work is billed once at{" "}
                    {intake.cleanupFee ? usd(Math.round(Number(intake.cleanupFee) * 100)) : "no charge"}. Either party may end the engagement with
                    thirty days written notice. The client keeps ownership of all records and remains responsible for the accuracy of the
                    information provided.
                  </p>
                </div>
              </div>
            ) : null}

            {step === 7 ? <SignatureStep /> : null}

            {step === 8 ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Give each person only what they need. Multi factor is on by default for anyone who can approve money movement.
                </p>
                {intake.people.map((p, i) => (
                  <div key={p.id} className="space-y-3 rounded-md border border-border p-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
                      <Input value={p.name} placeholder="Full name" onChange={(e) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))} data-testid={`input-person-name-${i}`} />
                      <Input value={p.email} placeholder="Email" onChange={(e) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, email: e.target.value } : x)))} data-testid={`input-person-email-${i}`} />
                      <Select value={p.role} onValueChange={(v) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, role: v } : x)))}>
                        <SelectTrigger data-testid={`select-person-role-${i}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONTACT_ROLES.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="icon" onClick={() => setPeople(intake.people.filter((x) => x.id !== p.id))} aria-label="Remove person" data-testid={`button-remove-person-${i}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={p.canApprovePayments} onCheckedChange={(v) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, canApprovePayments: v } : x)))} data-testid={`switch-pay-${i}`} />
                        Can approve payments
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={p.canApproveJournalEntries} onCheckedChange={(v) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, canApproveJournalEntries: v } : x)))} data-testid={`switch-je-${i}`} />
                        Can approve journal entries
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch checked={p.mfaRequired} onCheckedChange={(v) => setPeople(intake.people.map((x) => (x.id === p.id ? { ...x, mfaRequired: v } : x)))} data-testid={`switch-mfa-${i}`} />
                        Multi factor required
                      </label>
                      {p.canApprovePayments && !p.mfaRequired ? <Pill tone="risk">Turn multi factor on for a payment approver</Pill> : null}
                    </div>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPeople([...intake.people, { id: `pd-${Date.now()}`, name: "", email: "", role: "Controller", canApprovePayments: false, canApproveJournalEntries: false, mfaRequired: true }])}
                  data-testid="button-add-person"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add a person
                </Button>
              </div>
            ) : null}

            {step === 9 ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {sections.map((s) => (
                    <div key={s.label} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                      <span>{s.label}</span>
                      {s.done ? <Pill tone="good">Ready</Pill> : <Pill tone="watch">Needs input</Pill>}
                    </div>
                  ))}
                </div>
                <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                  <p className="font-medium">What happens when you open the file</p>
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    <li>The client is added to the book and becomes the active client.</li>
                    <li>{intake.accounts.filter((a) => a.institution).length} accounts are set up for reconciliation.</li>
                    <li>{taskPreview.length} recurring tasks are created for the current period.</li>
                    <li>The signed engagement letter is filed with an audit entry.</li>
                  </ul>
                </div>
                <Button
                  onClick={() => {
                    const id = createClientFromIntake();
                    if (!id) {
                      toast({
                        title: "A little more is needed",
                        description: "Enter the legal name and pick at least one service before opening the file.",
                        variant: "destructive",
                      });
                      return;
                    }
                    toast({ title: "Client file opened", description: `${intake.dba || intake.legalName} is now active in the workspace.` });
                    resetIntake();
                    navigate("/clients");
                  }}
                  data-testid="button-create-client"
                >
                  Open the client file
                </Button>
              </div>
            ) : null}
          </SectionCard>

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setIntakeStep(Math.max(0, step - 1))} data-testid="button-prev-step">
              <ChevronLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
            <span className="text-xs text-muted-foreground">
              Step {step + 1} of {STEPS.length}
            </span>
            <Button size="sm" disabled={step === STEPS.length - 1} onClick={() => setIntakeStep(Math.min(STEPS.length - 1, step + 1))} data-testid="button-next-step">
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function SignatureStep() {
  const { intake, setIntake } = useApp();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawing.current = true;
    const ctx = canvas.getContext("2d")!;
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(((e.clientX - rect.left) / rect.width) * canvas.width, ((e.clientY - rect.top) / rect.height) * canvas.height);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const rect = canvas.getBoundingClientRect();
    ctx.strokeStyle = getComputedStyle(canvas).color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineTo(((e.clientX - rect.left) / rect.width) * canvas.width, ((e.clientY - rect.top) / rect.height) * canvas.height);
    ctx.stroke();
    setHasInk(true);
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const canSign = intake.signatureMode === "typed" ? intake.signerName.trim().length > 2 : hasInk && intake.signerName.trim().length > 2;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-sm border border-border bg-muted p-0.5 sm:w-fit">
        {(["typed", "drawn"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setIntake({ signatureMode: m })}
            className={`flex-1 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none ${
              intake.signatureMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
            }`}
            data-testid={`button-sigmode-${m}`}
          >
            {m === "typed" ? "Type my name" : "Draw my signature"}
          </button>
        ))}
      </div>

      <Field label="Full legal name of the signer">
        <Input value={intake.signerName} onChange={(e) => setIntake({ signerName: e.target.value })} placeholder="Dana Whitfield" data-testid="input-signerName" />
      </Field>

      {intake.signatureMode === "typed" ? (
        <div className="rounded-md border border-border p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Signature</p>
          <p className="mt-2 text-2xl" style={{ fontFamily: "Georgia, serif", fontStyle: "italic" }} data-testid="text-typed-signature">
            {intake.signerName || "Your name appears here"}
          </p>
        </div>
      ) : (
        <div>
          <div className="relative rounded-md border border-border bg-card">
            <canvas
              ref={canvasRef}
              width={900}
              height={220}
              className="h-[140px] w-full touch-none text-foreground sm:h-[180px]"
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerLeave={end}
              data-testid="canvas-signature"
            />
            {!hasInk ? (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                Sign here with a finger, a stylus, or a mouse
              </p>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={clear} data-testid="button-clear-signature">
            <Eraser className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!canSign}
          onClick={() => setIntake({ signedAt: new Date().toISOString().slice(0, 19) })}
          data-testid="button-sign-engagement"
        >
          Sign the engagement letter
        </Button>
        {intake.signedAt ? (
          <Pill tone="good" testId="pill-signed">
            Signed {intake.signedAt.replace("T", " at ")}
          </Pill>
        ) : (
          <span className="text-xs text-muted-foreground">A timestamp and an audit entry are recorded the moment you sign.</span>
        )}
      </div>
    </div>
  );
}
