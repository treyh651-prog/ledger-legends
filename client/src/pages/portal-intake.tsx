/**
 * The client setup wizard, at /portal/intake.
 *
 * WHO IS AT THE KEYBOARD. The firm. This is a bookkeeper opening a file on a new
 * client, not the client filling in a questionnaire about itself. Everything on
 * screen is written that way: it says "the client", never "you".
 *
 * COMPLIANCE. The banner at the top is not decoration. This wizard writes
 * bookkeeping records. It does not form the entity, does not file anything with
 * a state or with the IRS, does not act as a registered agent, and does not
 * advise. Every field that touches entity type or fiscal year end asks what the
 * client already is, and never suggests what it ought to be. Read the help text
 * under those fields before changing them.
 *
 * NO SENDS. Step 2 collects who should get a portal login. Nothing is emailed.
 * The intent is written to the audit log and the banner on that step says so in
 * plain words.
 *
 * STATE. The draft lives in React state and the step number lives in the URL
 * query. Nothing is written to localStorage or sessionStorage, which the CI grep
 * guard enforces across the whole tree. A refresh keeps the step and loses the
 * draft, which is the honest behaviour for a form that has no server behind it
 * yet, and the review step says so.
 *
 * WHAT FINISH DOES. Hands the draft to the wizard controller, which runs the
 * four setup runs in registry order, then routes to the new client with a
 * success banner. Nothing is written until Finish is pressed.
 */

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, ArrowRight, Ban, Check, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import {
  BLOCK_ORDER,
  INDUSTRY_OPTIONS,
  blockOf,
  isForced,
  previewCatalog,
  previewChart,
  previewRequests,
  templateFor,
} from "@/lib/intake-templates";
import type { TemplateAccount } from "@/lib/intake-templates";
import {
  ACCOUNT_KINDS,
  CANONICAL_FIELDS,
  COMPLIANCE_BANNER,
  DATE_FORMATS,
  ENTITY_TYPE_OPTIONS,
  IMPORT_FORMATS,
  INVITE_BANNER,
  PERSON_ROLES,
  SERVICE_TIERS,
  SIGN_CONVENTIONS,
  WIZARD_STEPS,
  canFinish,
  emptyWizard,
  footingOf,
  formatOption,
  issuesForStep,
  newBalanceLine,
  newBankAccount,
  newPerson,
  newProfile,
  parseBalanceCsv,
  plannedProfiles,
  plannedRuns,
} from "@/lib/wizard-controller";
import type { WizardDraft, WizardProfile } from "@/lib/wizard-controller";
import { usd } from "@/lib/money";

/** Read the step out of the query string. Out of range values fall back to one. */
function readStep(): number {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("step");
  const n = raw === null ? 1 : Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > WIZARD_STEPS.length) return 0;
  return n - 1;
}

/** Put the step in the query string. History is replaced so back leaves the wizard. */
function writeStep(step: number): void {
  if (typeof window === "undefined" || !window.history) return;
  const url = new URL(window.location.href);
  if (step === 0) url.searchParams.delete("step");
  else url.searchParams.set("step", String(step + 1));
  window.history.replaceState(null, "", url.toString());
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Money for a bigint of cents, shown the way the rest of the app shows money. */
function centsLabel(cents: bigint): string {
  return usd(Number(cents) / 100);
}

export default function PortalIntake() {
  const { commitWizard } = useApp();
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState<WizardDraft>(emptyWizard);
  const [step, setStepState] = useState<number>(readStep);
  const [seq, setSeq] = useState(1);
  const [balanceCsv, setBalanceCsv] = useState("");
  const [openProfile, setOpenProfile] = useState<string>("");
  const [failure, setFailure] = useState<string>("");

  const patch = (p: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...p }));
  const bump = (): number => {
    const n = seq + 1;
    setSeq(n);
    return n;
  };
  const setStep = (n: number) => {
    setStepState(n);
    writeStep(n);
  };

  const template = templateFor(draft.industry);
  const chart = useMemo(
    () => previewChart(draft.industry, draft.excludedAccounts, draft.addedAccounts),
    [draft.industry, draft.excludedAccounts, draft.addedAccounts],
  );
  const footing = useMemo(() => footingOf(draft.balanceLines), [draft.balanceLines]);
  const issues = issuesForStep(draft, step);
  const runs = plannedRuns(draft);
  const profilePlan = plannedProfiles(draft);
  const catalog = previewCatalog([]);
  const requests = previewRequests([]);

  const updateProfile = (key: string, p: Partial<WizardProfile>) =>
    patch({ profiles: draft.profiles.map((x) => (x.key === key ? { ...x, ...p } : x)) });

  function finish() {
    const result = commitWizard(draft);
    if (!result.ok) {
      setFailure("The wizard still has unresolved issues, so nothing was written. Walk back through the steps marked below.");
      return;
    }
    navigate(`/portal/clients/${result.clientId}?setup=done`);
  }

  return (
    <>
      <PageHeader
        title="Client setup wizard"
        subtitle="Six steps. The firm fills this in while opening a file. Nothing is written until the last step."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(emptyWizard());
              setBalanceCsv("");
              setFailure("");
              setStep(0);
            }}
            data-testid="button-reset-wizard"
          >
            Start over
          </Button>
        }
      />

      {/* The compliance line. Fixed text, always first, never behind a toggle. */}
      <div
        className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        data-testid="banner-compliance"
      >
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <p>{COMPLIANCE_BANNER}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <SectionCard title="Steps" bodyClassName="p-2">
          <ol className="space-y-0.5">
            {WIZARD_STEPS.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors ${
                    i === step ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`button-step-${String(i)}`}
                >
                  <span className="tnum w-4 shrink-0 text-right text-[10px] text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{s}</span>
                </button>
              </li>
            ))}
          </ol>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title={`Step ${String(step + 1)} of ${String(WIZARD_STEPS.length)}, ${WIZARD_STEPS[step]}`} testId="card-wizard-step">
            {step === 0 ? (
              <div className="grid gap-4 sm:grid-cols-2" data-testid="step-company">
                <Field label="Legal name">
                  <Input value={draft.legalName} onChange={(e) => patch({ legalName: e.target.value })} placeholder="Northgate Mechanical Services LLC" data-testid="input-legalName" />
                </Field>
                <Field label="Doing business as">
                  <Input value={draft.dba} onChange={(e) => patch({ dba: e.target.value })} placeholder="Northgate Mechanical" data-testid="input-dba" />
                </Field>
                <Field label="EIN" hint="Nine digits as the client already holds them. We do not apply for one.">
                  <Input value={draft.ein} onChange={(e) => patch({ ein: e.target.value })} placeholder="45-2298137" data-testid="input-ein" />
                </Field>
                <Field label="State of incorporation" hint="Where the client says it is registered. We do not register anything and we are not its agent.">
                  <Input value={draft.stateOfIncorporation} onChange={(e) => patch({ stateOfIncorporation: e.target.value })} placeholder="WA" data-testid="input-state" />
                </Field>
                <Field label="Entity type" hint="What the client already is. This records a fact, it is not advice about what it should be.">
                  <Select value={draft.entityType} onValueChange={(v) => patch({ entityType: v })}>
                    <SelectTrigger data-testid="select-entityType"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ENTITY_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Fiscal year end" hint="Month and day the client already closes its year on. Recorded, not recommended.">
                  <Input value={draft.fiscalYearEnd} onChange={(e) => patch({ fiscalYearEnd: e.target.value })} placeholder="12-31" data-testid="input-fye" />
                </Field>
                <Field label="Service tier">
                  <Select value={draft.serviceTier} onValueChange={(v) => patch({ serviceTier: v })}>
                    <SelectTrigger data-testid="select-tier"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SERVICE_TIERS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Cutover date" hint="The first day the firm keeps the books. Opening balances are dated here.">
                  <Input value={draft.cutoverDate} onChange={(e) => patch({ cutoverDate: e.target.value })} placeholder="2026-07-01" data-testid="input-cutover" />
                </Field>
                <Field label="Industry template" hint="Which standard chart to build from. Nothing is seeded until the last step.">
                  <Select value={draft.industry} onValueChange={(v) => patch({ industry: v, excludedAccounts: [], addedAccounts: [] })}>
                    <SelectTrigger data-testid="select-industry"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INDUSTRY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="space-y-3" data-testid="step-people">
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs" data-testid="banner-invite">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <p>{INVITE_BANNER}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  No password is ever typed here and none is stored. Marking someone for a login records the intent only.
                </p>
                {draft.people.map((p) => (
                  <div key={p.key} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" data-testid={`row-person-${p.key}`}>
                    <Field label="Name">
                      <Input value={p.name} onChange={(e) => patch({ people: draft.people.map((x) => (x.key === p.key ? { ...x, name: e.target.value } : x)) })} data-testid={`input-person-name-${p.key}`} />
                    </Field>
                    <Field label="Role">
                      <Select value={p.role} onValueChange={(v) => patch({ people: draft.people.map((x) => (x.key === p.key ? { ...x, role: v } : x)) })}>
                        <SelectTrigger data-testid={`select-person-role-${p.key}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {PERSON_ROLES.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Email">
                      <Input value={p.email} onChange={(e) => patch({ people: draft.people.map((x) => (x.key === p.key ? { ...x, email: e.target.value } : x)) })} data-testid={`input-person-email-${p.key}`} />
                    </Field>
                    <Field label="Phone">
                      <Input value={p.phone} onChange={(e) => patch({ people: draft.people.map((x) => (x.key === p.key ? { ...x, phone: e.target.value } : x)) })} data-testid={`input-person-phone-${p.key}`} />
                    </Field>
                    <div className="flex items-center justify-between sm:col-span-2">
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={p.getsLogin}
                          onCheckedChange={(v) => patch({ people: draft.people.map((x) => (x.key === p.key ? { ...x, getsLogin: v === true } : x)) })}
                          data-testid={`check-person-login-${p.key}`}
                        />
                        <span>Should get a portal login</span>
                      </label>
                      <Button variant="ghost" size="sm" onClick={() => patch({ people: draft.people.filter((x) => x.key !== p.key) })} data-testid={`button-remove-person-${p.key}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => patch({ people: [...draft.people, newPerson(bump())] })} data-testid="button-add-person">
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add a contact
                </Button>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-3" data-testid="step-chart">
                <p className="text-xs text-muted-foreground">
                  {String(chart.length)} accounts will be seeded from {template?.label ?? draft.industry}, alongside{" "}
                  {String(template?.categoryCount ?? 0)} categories. Untick a row to leave it out. The clearing and suspense
                  accounts cannot be unticked because the close gates read them.
                </p>
                <div className="max-h-[420px] overflow-auto rounded-md border border-border">
                  {BLOCK_ORDER.filter((b) => (template?.accounts ?? []).some((a) => blockOf(a.accountNumber) === b)).map((block) => (
                    <div key={block}>
                      <div className="sticky top-0 border-b border-border bg-muted px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide">{block}</div>
                      {(template?.accounts ?? []).filter((a) => blockOf(a.accountNumber) === block).map((a) => {
                        const forced = isForced(a.accountNumber);
                        const on = forced || !draft.excludedAccounts.includes(a.accountNumber);
                        return (
                          <label key={a.accountNumber} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs" data-testid={`row-account-${a.accountNumber}`}>
                            <Checkbox
                              checked={on}
                              disabled={forced}
                              onCheckedChange={(v) =>
                                patch({
                                  excludedAccounts:
                                    v === true
                                      ? draft.excludedAccounts.filter((x) => x !== a.accountNumber)
                                      : [...draft.excludedAccounts, a.accountNumber],
                                })
                              }
                              data-testid={`check-account-${a.accountNumber}`}
                            />
                            <span className="tnum w-12 shrink-0 text-muted-foreground">{a.accountNumber}</span>
                            <span className="min-w-0 flex-1 truncate">{a.name}</span>
                            {forced ? <Pill tone="neutral">required</Pill> : null}
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <AddAccountRow
                  onAdd={(row) => patch({ addedAccounts: [...draft.addedAccounts, row] })}
                  added={draft.addedAccounts}
                  onRemove={(n) => patch({ addedAccounts: draft.addedAccounts.filter((x) => x.accountNumber !== n) })}
                />
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-4" data-testid="step-banks">
                {draft.bankAccounts.map((b) => {
                  const fmt = formatOption(b.importFormat);
                  return (
                    <div key={b.key} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" data-testid={`row-bank-${b.key}`}>
                      <Field label="Institution">
                        <Input value={b.institutionName} onChange={(e) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, institutionName: e.target.value } : x)) })} data-testid={`input-bank-institution-${b.key}`} />
                      </Field>
                      <Field label="Nickname">
                        <Input value={b.nickname} onChange={(e) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, nickname: e.target.value } : x)) })} data-testid={`input-bank-nickname-${b.key}`} />
                      </Field>
                      <Field label="Kind">
                        <Select value={b.kind} onValueChange={(v) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, kind: v } : x)) })}>
                          <SelectTrigger data-testid={`select-bank-kind-${b.key}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ACCOUNT_KINDS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Last four">
                        <Input value={b.lastFour} onChange={(e) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, lastFour: e.target.value } : x)) })} data-testid={`input-bank-last4-${b.key}`} />
                      </Field>
                      <Field label="Ledger account">
                        <Input value={b.glAccountNumber} onChange={(e) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, glAccountNumber: e.target.value } : x)) })} data-testid={`input-bank-gl-${b.key}`} />
                      </Field>
                      <Field label="Import format" hint={fmt?.unavailableReason ?? undefined}>
                        <Select value={b.importFormat} onValueChange={(v) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, importFormat: v } : x)) })}>
                          <SelectTrigger data-testid={`select-bank-format-${b.key}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {IMPORT_FORMATS.map((o) => (
                              <SelectItem key={o.value} value={o.value} disabled={o.unavailableReason !== null}>
                                {o.unavailableReason === null ? o.label : `${o.label}, unavailable, ${o.unavailableReason}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      {fmt?.unavailableReason !== null && fmt !== undefined ? (
                        <p className="flex items-center gap-1.5 text-xs text-danger sm:col-span-2" data-testid={`text-format-refused-${b.key}`}>
                          <Ban className="h-3.5 w-3.5" /> {fmt.unavailableReason}
                        </p>
                      ) : null}
                      {fmt?.needsProfile === true ? (
                        <Field label="Mapping profile">
                          <Select value={b.profileKey} onValueChange={(v) => patch({ bankAccounts: draft.bankAccounts.map((x) => (x.key === b.key ? { ...x, profileKey: v } : x)) })}>
                            <SelectTrigger data-testid={`select-bank-profile-${b.key}`}><SelectValue placeholder="Pick a saved profile" /></SelectTrigger>
                            <SelectContent>
                              {draft.profiles.map((p) => (
                                <SelectItem key={p.key} value={p.key}>{p.name.trim().length > 0 ? p.name : "Unnamed profile"}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                      <div className="flex justify-end sm:col-span-2">
                        <Button variant="ghost" size="sm" onClick={() => patch({ bankAccounts: draft.bankAccounts.filter((x) => x.key !== b.key) })} data-testid={`button-remove-bank-${b.key}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => patch({ bankAccounts: [...draft.bankAccounts, newBankAccount(bump())] })} data-testid="button-add-bank">
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add an account
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const p = newProfile(bump());
                      patch({ profiles: [...draft.profiles, p] });
                      setOpenProfile(p.key);
                    }}
                    data-testid="button-add-profile"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Create a mapping profile
                  </Button>
                </div>

                {draft.profiles.map((p) => (
                  <SectionCard
                    key={p.key}
                    title={p.name.trim().length > 0 ? p.name : "Unnamed mapping profile"}
                    description="Source columns matched to canonical fields by header text. There is no detection beyond the header words."
                    testId={`card-profile-${p.key}`}
                    actions={
                      <Button variant="ghost" size="sm" onClick={() => setOpenProfile(openProfile === p.key ? "" : p.key)} data-testid={`button-toggle-profile-${p.key}`}>
                        {openProfile === p.key ? "Collapse" : "Edit"}
                      </Button>
                    }
                  >
                    {openProfile === p.key ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <Field label="Profile name">
                            <Input value={p.name} onChange={(e) => updateProfile(p.key, { name: e.target.value })} data-testid={`input-profile-name-${p.key}`} />
                          </Field>
                          <Field label="Institution">
                            <Input value={p.institutionName} onChange={(e) => updateProfile(p.key, { institutionName: e.target.value })} data-testid={`input-profile-institution-${p.key}`} />
                          </Field>
                          <Field label="File format">
                            <Select value={p.fileFormat} onValueChange={(v) => updateProfile(p.key, { fileFormat: v })}>
                              <SelectTrigger data-testid={`select-profile-format-${p.key}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="csv">CSV</SelectItem>
                                <SelectItem value="xlsx">XLSX</SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field label="Date format">
                            <Select value={p.dateFormat} onValueChange={(v) => updateProfile(p.key, { dateFormat: v })}>
                              <SelectTrigger data-testid={`select-profile-dateformat-${p.key}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {DATE_FORMATS.map((f) => (
                                  <SelectItem key={f} value={f}>{f}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field label="Sign convention">
                            <Select value={p.signConvention} onValueChange={(v) => updateProfile(p.key, { signConvention: v })}>
                              <SelectTrigger data-testid={`select-profile-sign-${p.key}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {SIGN_CONVENTIONS.map((o) => (
                                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field label="Header row number">
                            <Input
                              value={String(p.headerRowNumber)}
                              onChange={(e) => updateProfile(p.key, { headerRowNumber: Number.parseInt(e.target.value, 10) || 1 })}
                              data-testid={`input-profile-headerrow-${p.key}`}
                            />
                          </Field>
                        </div>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border text-left text-muted-foreground">
                              <th className="py-1.5 font-medium">Source column</th>
                              <th className="py-1.5 font-medium">Canonical field</th>
                              <th className="py-1.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {p.columns.map((c) => (
                              <tr key={c.key} className="border-b border-border/60">
                                <td className="py-1.5 pr-2">
                                  <Input
                                    value={c.sourceColumn}
                                    onChange={(e) => updateProfile(p.key, { columns: p.columns.map((x) => (x.key === c.key ? { ...x, sourceColumn: e.target.value } : x)) })}
                                    placeholder="Posting Date"
                                    data-testid={`input-col-source-${p.key}-${c.key}`}
                                  />
                                </td>
                                <td className="py-1.5 pr-2">
                                  <Select value={c.canonicalField} onValueChange={(v) => updateProfile(p.key, { columns: p.columns.map((x) => (x.key === c.key ? { ...x, canonicalField: v } : x)) })}>
                                    <SelectTrigger data-testid={`select-col-field-${p.key}-${c.key}`}><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {CANONICAL_FIELDS.map((o) => (
                                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </td>
                                <td className="py-1.5 text-right">
                                  <Button variant="ghost" size="sm" onClick={() => updateProfile(p.key, { columns: p.columns.filter((x) => x.key !== c.key) })} data-testid={`button-remove-col-${p.key}-${c.key}`}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateProfile(p.key, { columns: [...p.columns, { key: `col-${String(bump())}`, sourceColumn: "", canonicalField: "memo" }] })}
                          data-testid={`button-add-col-${p.key}`}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" /> Add a column
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {String(p.columns.filter((c) => c.sourceColumn.trim().length > 0).length)} columns mapped, {p.fileFormat.toUpperCase()},{" "}
                        dates read as {p.dateFormat}.
                      </p>
                    )}
                  </SectionCard>
                ))}
              </div>
            ) : null}

            {step === 4 ? (
              <div className="space-y-3" data-testid="step-balances">
                <p className="text-xs text-muted-foreground">
                  Balances as at {draft.cutoverDate.length > 0 ? draft.cutoverDate : "the cutover date"}. Debits positive, credits
                  negative. Account 3900 is derived from everything else, so leave it out unless the prior books carry a figure for
                  it. If a supplied 3900 disagrees with the rest of the sheet the run refuses rather than plugging the difference.
                </p>
                <Field label="Paste a trial balance CSV" hint="Two columns, account number then amount. Header rows and total lines are ignored.">
                  <Textarea
                    value={balanceCsv}
                    onChange={(e) => setBalanceCsv(e.target.value)}
                    rows={4}
                    placeholder={"1010,245000.00\n2010,-7364.00"}
                    data-testid="input-balance-csv"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patch({ balanceLines: parseBalanceCsv(balanceCsv), balanceSource: "csv_paste" })}
                    data-testid="button-load-balance-csv"
                  >
                    Load the pasted rows
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => patch({ balanceLines: [...draft.balanceLines, newBalanceLine(bump())], balanceSource: "wizard_trial_balance" })} data-testid="button-add-balance">
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add a line
                  </Button>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-1.5 font-medium">Account</th>
                      <th className="py-1.5 font-medium">Amount</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.balanceLines.map((l) => (
                      <tr key={l.key} className="border-b border-border/60" data-testid={`row-balance-${l.key}`}>
                        <td className="w-28 py-1.5 pr-2">
                          <Input value={l.accountNumber} onChange={(e) => patch({ balanceLines: draft.balanceLines.map((x) => (x.key === l.key ? { ...x, accountNumber: e.target.value } : x)) })} data-testid={`input-balance-account-${l.key}`} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input value={l.amount} onChange={(e) => patch({ balanceLines: draft.balanceLines.map((x) => (x.key === l.key ? { ...x, amount: e.target.value } : x)) })} data-testid={`input-balance-amount-${l.key}`} />
                        </td>
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" size="sm" onClick={() => patch({ balanceLines: draft.balanceLines.filter((x) => x.key !== l.key) })} data-testid={`button-remove-balance-${l.key}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs" data-testid="panel-footing">
                  <p>
                    Lines read: <span className="tnum font-medium">{String(footing.parsedCount)}</span>. Running total:{" "}
                    <span className="tnum font-medium" data-testid="text-running-total">{centsLabel(footing.totalCents)}</span>.
                  </p>
                  <p className="mt-1">
                    Offset to 3900 opening balance equity:{" "}
                    <span className="tnum font-medium" data-testid="text-offset">{centsLabel(footing.offsetCents)}</span>.
                  </p>
                  {footing.unreadable.length > 0 ? (
                    <p className="mt-1 text-danger" data-testid="text-unreadable">
                      Cannot read the amount on {footing.unreadable.join(", ")}. Nothing is guessed and nothing is treated as zero.
                    </p>
                  ) : null}
                  {footing.duplicates.length > 0 ? (
                    <p className="mt-1 text-warning">Named twice, both lines will post: {footing.duplicates.join(", ")}.</p>
                  ) : null}
                  {footing.equityConflict !== null ? (
                    <p className="mt-1 text-danger" data-testid="text-equity-conflict">{footing.equityConflict}</p>
                  ) : null}
                  {footing.foots && footing.parsedCount > 0 ? (
                    <p className="mt-1 flex items-center gap-1.5 text-success" data-testid="text-foots">
                      <Check className="h-3.5 w-3.5" /> The entry foots once the offset line is added.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === 5 ? (
              <div className="space-y-3" data-testid="step-review">
                <p className="text-xs text-muted-foreground">
                  Nothing has been written yet. Finish runs these four in this order and stops at the first refusal.
                </p>
                <ol className="space-y-2">
                  {runs.map((r, i) => (
                    <li key={r.type} className="rounded-md border border-border p-3 text-xs" data-testid={`row-planned-run-${r.type}`}>
                      <div className="flex items-center gap-2">
                        <span className="tnum text-muted-foreground">{i + 1}</span>
                        <span className="font-medium">{r.title}</span>
                        <Pill tone="neutral">{r.type}</Pill>
                      </div>
                      <p className="mt-1 text-muted-foreground">{r.detail}</p>
                    </li>
                  ))}
                </ol>
                <SectionCard title="Mapping profiles that will be saved" bodyClassName="p-3">
                  {profilePlan.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None. No account on this client imports from a spreadsheet.</p>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {profilePlan.map((p) => (
                        <li key={p.profile.key} data-testid={`row-planned-profile-${p.profile.key}`}>
                          <span className="font-medium">{p.profile.name.trim().length > 0 ? p.profile.name : "Unnamed profile"}</span>{" "}
                          <span className="text-muted-foreground">
                            attached to {p.accounts.length === 0 ? "no account yet" : p.accounts.join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionCard>
                <p className="text-xs text-muted-foreground">
                  Also recorded: {String(catalog.length)} task catalog rows and {String(requests.length)} document asks. No email is
                  sent by any part of this. The draft lives in the browser tab only, so a refresh before Finish loses it.
                </p>
                {failure.length > 0 ? (
                  <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="text-finish-failure">{failure}</p>
                ) : null}
                <Button onClick={finish} disabled={!canFinish(draft)} data-testid="button-finish">
                  <Check className="mr-1 h-3.5 w-3.5" /> Finish and set the client up
                </Button>
              </div>
            ) : null}

            {issues.length > 0 ? (
              <ul className="mt-4 space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs" data-testid="list-step-issues">
                {issues.map((i) => (
                  <li key={`${i.field}-${i.message}`}>{i.message}</li>
                ))}
              </ul>
            ) : null}

            <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
              <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setStep(step - 1)} data-testid="button-back">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back
              </Button>
              <Button size="sm" disabled={step === WIZARD_STEPS.length - 1} onClick={() => setStep(step + 1)} data-testid="button-next">
                Next <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>
    </>
  );
}

/** The small form for adding an account the standard template does not carry. */
function AddAccountRow({
  onAdd,
  added,
  onRemove,
}: {
  onAdd: (row: TemplateAccount) => void;
  added: readonly TemplateAccount[];
  onRemove: (accountNumber: string) => void;
}) {
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const ok = /^[0-9]{4}$/.test(number) && name.trim().length > 0;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs font-medium">Add an account the template does not carry</p>
      <div className="grid gap-2 sm:grid-cols-[110px_1fr_auto]">
        <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="6450" data-testid="input-add-account-number" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Permit fees" data-testid="input-add-account-name" />
        <Button
          variant="outline"
          size="sm"
          disabled={!ok}
          onClick={() => {
            const n = Number.parseInt(number, 10);
            onAdd({
              accountNumber: number,
              name: name.trim(),
              // Liabilities, equity and revenue are credit balance blocks. Everything
              // else on the chart carries a debit balance in its normal state.
              normalSide: n >= 2000 && n < 5000 ? "credit" : "debit",
              scopeKey: "always",
            });
            setNumber("");
            setName("");
          }}
          data-testid="button-add-account"
        >
          Add
        </Button>
      </div>
      {added.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {added.map((a) => (
            <li key={a.accountNumber} className="flex items-center gap-2" data-testid={`row-added-account-${a.accountNumber}`}>
              <span className="tnum w-12 text-muted-foreground">{a.accountNumber}</span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <Button variant="ghost" size="sm" onClick={() => onRemove(a.accountNumber)} data-testid={`button-remove-added-${a.accountNumber}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
