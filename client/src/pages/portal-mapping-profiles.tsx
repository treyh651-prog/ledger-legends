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
 */

import { useMemo, useState } from "react";
import { FileWarning } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { parseSampleRows } from "@/lib/wizard-controller";
import type { MappingProfile } from "@/data/types";

/** Where each canonical field lands in a pasted header row, or nothing. */
function matchAgainstHeader(
  profile: MappingProfile,
  header: readonly string[],
): Array<{ canonicalField: string; sourceColumn: string; columnIndex: number | null }> {
  const normalized = header.map((h) => h.trim().toUpperCase());
  return profile.columns
    .filter((c) => c.canonicalField !== "unmapped")
    .map((c) => {
      const index = normalized.indexOf(c.sourceColumn.trim().toUpperCase());
      return { canonicalField: c.canonicalField, sourceColumn: c.sourceColumn, columnIndex: index === -1 ? null : index };
    });
}

export default function PortalMappingProfiles() {
  const { ds } = useApp();
  const [sample, setSample] = useState("");
  const [selected, setSelected] = useState("");

  const parsed = useMemo(() => parseSampleRows(sample), [sample]);
  const profiles = ds.mappingProfiles;
  const active = profiles.find((p) => p.id === selected) ?? profiles[0];

  const clientName = (id: string): string => ds.clients.find((c) => c.id === id)?.dba ?? id;
  const accountLabel = (id: string): string => {
    const b = ds.bankAccounts.find((x) => x.id === id);
    return b === undefined ? id : `${b.institution} ${b.nickname} ${b.last4}`;
  };

  return (
    <>
      <PageHeader
        title="Mapping profiles"
        subtitle="Saved column layouts for the spreadsheet exports we import. One profile per institution layout, attached to the accounts that use it."
      />

      {profiles.length === 0 ? (
        <EmptyState
          title="No saved profiles"
          body="A profile is created on step four of the client setup wizard, at the moment an account is set to import from CSV or XLSX."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <SectionCard title="Saved profiles" description={`${String(profiles.length)} saved across the practice.`} bodyClassName="p-0">
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
                      <span className="font-medium">{p.name}</span>
                      <Pill tone="neutral">{p.fileFormat.toUpperCase()}</Pill>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {clientName(p.clientId)}, {String(p.columns.length)} columns, dates read as {p.dateFormat}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {p.bankAccountIds.length === 0
                        ? "Saved and not attached to an account"
                        : p.bankAccountIds.map(accountLabel).join(", ")}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>

          <div className="space-y-4">
            {active === undefined ? null : (
              <SectionCard title={`Columns, ${active.name}`} bodyClassName="p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Source column</th>
                      <th className="px-4 py-2 font-medium">Canonical field</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.columns.map((c) => (
                      <tr key={c.sourceColumn} className="border-b border-border/60" data-testid={`row-column-${c.sourceColumn}`}>
                        <td className="px-4 py-1.5">{c.sourceColumn}</td>
                        <td className="px-4 py-1.5">
                          {c.canonicalField === "unmapped" ? (
                            <span className="text-muted-foreground">not imported</span>
                          ) : (
                            <span className="tnum">{c.canonicalField}</span>
                          )}
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
