/**
 * Saved mapping profiles, at /portal/mapping-profiles.
 *
 * A mapping profile is the answer to one question: when this institution hands
 * us a spreadsheet, which column is the date, which is the amount, and which is
 * everything else. Doc 05 decision D2 lists the formats we accept. CSV and XLSX
 * are accepted only through a saved profile like these, and PDF statements are
 * refused outright because there is no honest way to parse them.
 *
 * NO DETECTION. Matching is by header text and nothing else. Trim the header,
 * upper case it, compare it to the saved source column, done. If the bank
 * renames a column the preview below shows the field as missing and the import
 * stops and asks a person. It never shifts to the next column and hopes. A
 * silently shifted column is the worst failure this pipeline can produce
 * because the books still balance while every figure is wrong.
 *
 * The preview takes rows the user pastes. Nothing is uploaded and nothing is
 * sent anywhere.
 *
 * Profiles are read from GET /api/firm/clients/:id/setup for the client in
 * the header, which is import.mapping_profiles with its active column rows.
 * Nothing on this screen writes; a profile is written by the import runs.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileWarning, Plus } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useClientSetup, useTriggerRun, errorMessage, firmKeys } from "@/api";
import { parseSampleRows } from "@/lib/sample-rows";
import type { SetupBankAccount, SetupMappingProfile } from "@shared/api";

/**
 * Which source column each of a profile's own named fields points at.
 * import.mapping_profile_columns exists in the schema but nothing has ever
 * written to it (CFG-EDIT-MAPPING-PROFILE and CFG-CREATE-MAPPING-PROFILE
 * both checked; neither does), and its five-value canonical field vocabulary
 * (date/description/amount_cents/memo/external_id) does not even cover
 * everything a profile row itself carries (debit and credit columns have no
 * slot in it at all). The profile row's own eight column-name fields are
 * the live source of truth, so this reads directly from those instead.
 */
function namedColumnsOf(profile: SetupMappingProfile): Array<{ field: string; sourceColumn: string }> {
  const out: Array<{ field: string; sourceColumn: string }> = [
    { field: "date", sourceColumn: profile.dateColumn },
    { field: "description", sourceColumn: profile.descriptionColumn },
  ];
  if (profile.amountColumn) out.push({ field: "amount", sourceColumn: profile.amountColumn });
  if (profile.debitColumn) out.push({ field: "debit", sourceColumn: profile.debitColumn });
  if (profile.creditColumn) out.push({ field: "credit", sourceColumn: profile.creditColumn });
  return out;
}

/** Where each of a profile's named fields lands in a pasted header row, or nothing. */
function matchAgainstHeader(
  profile: SetupMappingProfile,
  header: readonly string[],
): Array<{ canonicalField: string; sourceColumn: string; columnIndex: number | null }> {
  const normalized = header.map((h) => h.trim().toUpperCase());
  return namedColumnsOf(profile).map(({ field, sourceColumn }) => {
    const index = normalized.indexOf(sourceColumn.trim().toUpperCase());
    return { canonicalField: field, sourceColumn, columnIndex: index === -1 ? null : index };
  });
}

export default function PortalMappingProfiles() {
  const { client, clientId } = useActiveClient();
  const q = useClientSetup(clientId);
  const [sample, setSample] = useState("");
  const [selected, setSelected] = useState("");

  const parsed = useMemo(() => parseSampleRows(sample), [sample]);
  const profiles = q.data?.mappingProfiles ?? [];
  const active = profiles.find((p) => p.id === selected) ?? profiles[0];
  const banks = q.data?.bankAccounts ?? [];
  const nameOf = (p: SetupMappingProfile): string => `${p.institutionName} ${p.accountNumber}`;
  const accountLabel = (accountNumber: string): string => {
    const b = banks.find((x) => x.accountNumber === accountNumber);
    return b === undefined ? accountNumber : `${b.nickname} ${b.accountNumber}`;
  };

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (clientId && q.isPending) return <LoadingRows rows={4} cols={3} />;

  return (
    <>
      <PageHeader
        title="Mapping profiles"
        subtitle={`Saved column layouts for the spreadsheet exports we import for ${client?.name ?? "this client"}. One profile per institution layout, attached to the account that uses it.`}
        actions={clientId ? <CreateMappingProfileDialog clientId={clientId} bankAccounts={banks} /> : null}
      />

      {profiles.length === 0 ? (
        <EmptyState
          title="No saved profiles"
          body="A profile is written to import.mapping_profiles when the first CSV or XLSX for an account is mapped, or created directly below."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <SectionCard title="Saved profiles" description={`${String(profiles.length)} saved on this client.`} bodyClassName="p-0">
            <ul className="divide-y divide-border">
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.id)}
                    className={`w-full px-4 py-3 text-left text-xs transition-colors ${p.id === active?.id ? "bg-accent" : "hover:bg-accent/50"}`}
                    data-testid={`button-profile-${p.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{nameOf(p)}</span>
                      <Pill tone="neutral">{p.fileFormat.toUpperCase()}</Pill>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      version {p.version}, {String(namedColumnsOf(p).length)} columns, dates read as {p.dateFormat}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">{accountLabel(p.accountNumber)}</p>
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>

          <div className="space-y-4">
            {active === undefined ? null : (
              <SectionCard title={`Columns, ${nameOf(active)}`} bodyClassName="p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Source column</th>
                      <th className="px-4 py-2 font-medium">Canonical field</th>
                    </tr>
                  </thead>
                  <tbody>
                    {namedColumnsOf(active).map((c) => (
                      <tr key={c.field} className="border-b border-border/60" data-testid={`row-column-${c.field}`}>
                        <td className="px-4 py-1.5">{c.sourceColumn}</td>
                        <td className="px-4 py-1.5">
                          <span className="tnum">{c.field}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionCard>
            )}

            <SectionCard
              title="Preview against pasted rows"
              description="Paste a header row and a few data rows. Nothing is uploaded and nothing leaves this tab."
            >
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Sample rows</Label>
                <Textarea
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                  rows={5}
                  placeholder={"Posting Date,Description,Amount,Check Number,Reference\n07/03/2026,FERGUSON ENTERPRISES,-1284.55,,INB88213"}
                  data-testid="input-sample-rows"
                />
              </div>

              {active !== undefined && parsed.header.length > 0 ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="mb-1.5 text-xs font-medium">Where each field lands</p>
                    <ul className="space-y-1 text-xs">
                      {matchAgainstHeader(active, parsed.header).map((m) => (
                        <li key={m.canonicalField} className="flex items-center gap-2" data-testid={`row-match-${m.canonicalField}`}>
                          <span className="tnum w-28 shrink-0">{m.canonicalField}</span>
                          {m.columnIndex === null ? (
                            <span className="flex items-center gap-1.5 text-danger">
                              <FileWarning className="h-3.5 w-3.5" />
                              column {m.sourceColumn} is not in this header, so an import would stop and ask
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              column {String(m.columnIndex + 1)}, {parsed.header[m.columnIndex]}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="overflow-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-muted text-left">
                          {matchAgainstHeader(active, parsed.header).map((m) => (
                            <th key={m.canonicalField} className="px-2 py-1.5 font-medium">{m.canonicalField}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.rows.slice(0, 8).map((row, ri) => (
                          <tr key={`row-${String(ri)}`} className="border-b border-border/60" data-testid={`row-preview-${String(ri)}`}>
                            {matchAgainstHeader(active, parsed.header).map((m) => (
                              <td key={m.canonicalField} className="px-2 py-1.5">
                                {m.columnIndex === null ? <span className="text-danger">missing</span> : row[m.columnIndex] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </SectionCard>
          </div>
        </div>
      )}
    </>
  );
}

const SIGN_CONVENTIONS = ["debit_positive", "credit_positive", "separate_columns"] as const;

/**
 * Column names must be picked from a header the firm actually pasted, never
 * typed blind: a column name string that does not exactly match the real
 * file's header is the "silently shifted column" failure doc 05 Part 3
 * refuses to allow, the same reasoning the read only preview above already
 * follows. headerFingerprint itself is never computed here -- the run
 * derives it server side from the exact pasted header, the same function
 * IMPORT-PARSE-FEED uses to check a real file against it.
 */
function CreateMappingProfileDialog({ clientId, bankAccounts }: { clientId: string; bankAccounts: readonly SetupBankAccount[] }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [fileFormat, setFileFormat] = useState<"csv" | "xlsx">("csv");
  const [dateFormat, setDateFormat] = useState("MM/DD/YYYY");
  const [currency, setCurrency] = useState("USD");
  const [signConvention, setSignConvention] = useState<(typeof SIGN_CONVENTIONS)[number]>("debit_positive");
  const [dateColumn, setDateColumn] = useState("");
  const [descriptionColumn, setDescriptionColumn] = useState("");
  const [amountColumn, setAmountColumn] = useState("");
  const [debitColumn, setDebitColumn] = useState("");
  const [creditColumn, setCreditColumn] = useState("");
  const [bankIdColumn, setBankIdColumn] = useState("");
  const [checkNumberColumn, setCheckNumberColumn] = useState("");
  const [bankCodeColumn, setBankCodeColumn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const parsed = useMemo(() => parseSampleRows(sample), [sample]);

  const reset = () => {
    setSample("");
    setInstitutionName("");
    setAccountNumber(bankAccounts[0]?.accountNumber ?? "");
    setFileFormat("csv");
    setDateFormat("MM/DD/YYYY");
    setCurrency("USD");
    setSignConvention("debit_positive");
    setDateColumn("");
    setDescriptionColumn("");
    setAmountColumn("");
    setDebitColumn("");
    setCreditColumn("");
    setBankIdColumn("");
    setCheckNumberColumn("");
    setBankCodeColumn("");
    setError(null);
  };

  const save = async () => {
    setError(null);
    if (!institutionName.trim() || !accountNumber || !dateColumn || !descriptionColumn) {
      setError("Institution, account, date column, and description column are required.");
      return;
    }
    if (signConvention === "separate_columns" ? !debitColumn || !creditColumn : !amountColumn) {
      setError(signConvention === "separate_columns" ? "Debit and credit columns are required." : "An amount column is required.");
      return;
    }
    const scope = {
      clientId,
      changeNote: "created from the mapping profiles screen",
      fields: {
        institutionName: institutionName.trim(),
        accountNumber,
        fileFormat,
        headerCells: parsed.header,
        dateColumn,
        dateFormat: dateFormat.trim(),
        descriptionColumn,
        amountColumn: signConvention === "separate_columns" ? null : amountColumn,
        debitColumn: signConvention === "separate_columns" ? debitColumn : null,
        creditColumn: signConvention === "separate_columns" ? creditColumn : null,
        signConvention,
        currency: currency.trim().toUpperCase(),
        bankIdColumn: bankIdColumn || null,
        checkNumberColumn: checkNumberColumn || null,
        bankCodeColumn: bankCodeColumn || null,
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-MAPPING-PROFILE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-MAPPING-PROFILE",
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

  const columnSelect = (value: string, onChange: (v: string) => void, testId: string, allowEmpty = false) => (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    >
      <option value="">{allowEmpty ? "Not in this file" : "Choose a column…"}</option>
      {parsed.header.map((h, i) => (
        <option key={`${h}-${String(i)}`} value={h}>
          {h}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" data-testid="profile-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Create profile
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a mapping profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Paste the real header row and a sample row or two</Label>
            <Textarea
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              rows={4}
              placeholder={"Posting Date,Description,Amount,Check Number,Reference\n07/03/2026,FERGUSON ENTERPRISES,-1284.55,,INB88213"}
              data-testid="profile-create-sample"
            />
            <p className="text-xs text-muted-foreground">Columns below are picked from this header, never typed blind, so a saved profile always matches the real file.</p>
          </div>

          {parsed.header.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Institution</label>
                  <Input value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} data-testid="profile-create-institution" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Account</label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    data-testid="profile-create-account"
                  >
                    <option value="">Choose an account…</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.accountNumber}>
                        {a.nickname} {a.accountNumber}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">File format</label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={fileFormat}
                    onChange={(e) => setFileFormat(e.target.value as "csv" | "xlsx")}
                    data-testid="profile-create-format"
                  >
                    <option value="csv">CSV</option>
                    <option value="xlsx">Excel</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Date format</label>
                  <Input value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} data-testid="profile-create-date-format" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Currency</label>
                  <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} data-testid="profile-create-currency" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Date column</label>
                  {columnSelect(dateColumn, setDateColumn, "profile-create-date-column")}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Description column</label>
                  {columnSelect(descriptionColumn, setDescriptionColumn, "profile-create-description-column")}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Amount is</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={signConvention}
                  onChange={(e) => setSignConvention(e.target.value as (typeof SIGN_CONVENTIONS)[number])}
                  data-testid="profile-create-sign-convention"
                >
                  <option value="debit_positive">One column, money out is positive</option>
                  <option value="credit_positive">One column, money in is positive</option>
                  <option value="separate_columns">Separate debit and credit columns</option>
                </select>
              </div>
              {signConvention === "separate_columns" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Debit column</label>
                    {columnSelect(debitColumn, setDebitColumn, "profile-create-debit-column")}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Credit column</label>
                    {columnSelect(creditColumn, setCreditColumn, "profile-create-credit-column")}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Amount column</label>
                  {columnSelect(amountColumn, setAmountColumn, "profile-create-amount-column")}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Bank id column (optional)</label>
                  {columnSelect(bankIdColumn, setBankIdColumn, "profile-create-bank-id-column", true)}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Check number column (optional)</label>
                  {columnSelect(checkNumberColumn, setCheckNumberColumn, "profile-create-check-number-column", true)}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Bank code column (optional)</label>
                  {columnSelect(bankCodeColumn, setBankCodeColumn, "profile-create-bank-code-column", true)}
                </div>
              </div>
            </>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending || parsed.header.length === 0} data-testid="profile-create-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
