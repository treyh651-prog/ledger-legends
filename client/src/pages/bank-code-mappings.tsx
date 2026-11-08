import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useBankCodeMappings, useCategories, useTriggerRun, errorMessage, screenKeys } from "@/api";
import type { BankCodeMapping } from "@shared/api";

interface DraftRow {
  institutionId: string;
  bankCode: string;
  categoryId: string;
}

function emptyRow(): DraftRow {
  return { institutionId: "", bankCode: "", categoryId: "" };
}

/**
 * Audit rerun fix, item 6, the last of the 14 run types this round
 * covers. CFG-CREATE-BANKCODE-MAPPING has existed since the original
 * action audit with zero UI -- every bank code fell through to suspense
 * forever on every client, regardless of how repetitive the bank's own
 * coding turned out to be, confirmed by this run's own header comment.
 * The run itself is bulk ("a bank or card issuer's own code list rarely
 * arrives one entry at a time"), so this screen's create dialog is a
 * small repeatable row table, not a single-row form submitted N times.
 * No action button pairs with this screen -- TXN-MAP-BANKCODES is a
 * coding-cascade run, already reachable through the normal cascade.
 */
export default function BankCodeMappings() {
  const { client, clientId } = useActiveClient();
  const q = useBankCodeMappings(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const active = d?.items.filter((m) => m.isActive) ?? [];

  return (
    <div className="space-y-4" data-testid="page-bank-code-mappings">
      <PageHeader
        title="Bank code mappings"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} mappings.` : ""}`}
        actions={clientId ? <CreateMappingsDialog clientId={clientId} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Mappings" value={d ? d.items.length : "…"} testId="kpi-mappings" />
        <Kpi label="Active" value={d ? active.length : "…"} />
      </div>
      <SectionCard title="Mappings" description="What TXN-MAP-BANKCODES reads: a bank's own code, mapped through to a category on this client's books.">
        <DataGrid<BankCodeMapping>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(m) => m.id}
          testId="grid-bank-code-mappings"
          empty={<EmptyState title="No mappings yet" body="Add the bank's own code list before TXN-MAP-BANKCODES can use it." />}
          cols={[
            {
              key: "code",
              label: "Institution / code",
              mobile: "title",
              render: (m) => (
                <span className="font-medium tnum">
                  {m.institutionId} / {m.bankCode}
                </span>
              ),
            },
            { key: "category", label: "Category", mobile: "row", render: (m) => m.categoryName ?? m.categoryId },
            { key: "active", label: "Active", mobile: "value", render: (m) => <Pill tone={m.isActive ? "good" : "neutral"}>{m.isActive ? "Active" : "Inactive"}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function CreateMappingsDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DraftRow[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);
  const categories = useCategories(clientId);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setRows([emptyRow()]);
    setError(null);
  };

  const updateRow = (i: number, patch: Partial<DraftRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setError(null);
    const filled = rows.filter((r) => r.institutionId.trim() || r.bankCode.trim() || r.categoryId.trim());
    if (filled.length === 0) {
      setError("Add at least one mapping.");
      return;
    }
    for (const r of filled) {
      if (!r.institutionId.trim() || !r.bankCode.trim() || !r.categoryId.trim()) {
        setError("Every row needs an institution, a bank code, and a category.");
        return;
      }
    }
    const scope = {
      clientId,
      mappings: filled.map((r) => ({ institutionId: r.institutionId.trim(), bankCode: r.bankCode.trim(), categoryId: r.categoryId.trim() })),
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-BANKCODE-MAPPING", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-BANKCODE-MAPPING",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.bankCodeMappings(clientId) });
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
        <Button size="sm" data-testid="mapping-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add mappings
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add bank code mappings</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
          <p className="text-xs text-muted-foreground">One row per bank code. Institution id "*" is the wildcard, used only when no institution-specific row matches.</p>
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2" data-testid={`mapping-row-${i}`}>
                <div className="space-y-1">
                  {i === 0 ? <label className="text-xs font-medium text-muted-foreground">Institution id</label> : null}
                  <Input value={row.institutionId} onChange={(e) => updateRow(i, { institutionId: e.target.value })} placeholder="*" data-testid={`mapping-institution-${i}`} />
                </div>
                <div className="space-y-1">
                  {i === 0 ? <label className="text-xs font-medium text-muted-foreground">Bank code</label> : null}
                  <Input value={row.bankCode} onChange={(e) => updateRow(i, { bankCode: e.target.value })} placeholder="POS-DEBIT" data-testid={`mapping-code-${i}`} />
                </div>
                <div className="space-y-1">
                  {i === 0 ? <label className="text-xs font-medium text-muted-foreground">Category</label> : null}
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={row.categoryId}
                    onChange={(e) => updateRow(i, { categoryId: e.target.value })}
                    data-testid={`mapping-category-${i}`}
                  >
                    <option value="">Choose a category</option>
                    {(categories.data?.items ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button size="sm" variant="outline" onClick={() => removeRow(i)} disabled={rows.length === 1} data-testid={`mapping-remove-${i}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => setRows((prev) => [...prev, emptyRow()])} data-testid="mapping-add-row">
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add another row
          </Button>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="mapping-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
