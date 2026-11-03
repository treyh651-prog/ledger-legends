import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useClients } from "@/api";
import { useEntityGroups, useConsolidatedPackages, useTriggerFirmRun, errorMessage, entityGroupKeys } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { EntityGroup } from "@shared/api";

type ComparisonBasis = "prior_period" | "prior_year" | "budget" | "none";
type ReportBasis = "accrual" | "cash";

/**
 * Group consolidation, firm-side setup. Entity groups are firm-controlled
 * data (CFG-CREATE-ENTITY-GROUP/CFG-EDIT-ENTITY-GROUP/CFG-SET-GROUP-MEMBERS),
 * not derived from which portal user can see which company -- that
 * membership-derived list is what portal-entities.tsx shows as its own
 * fallback. Building a package here is RPT-BUILD-CONSOLIDATED-PACKAGE,
 * reusing the preview/apply flow every other run-triggering screen uses.
 */
export default function EntityGroups() {
  const q = useEntityGroups();
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-entity-groups">
      <PageHeader
        title="Entity groups"
        subtitle={`${d ? `${d.items.length} group(s).` : ""} Two or more companies combined into one set of statements, with eliminations.`}
        actions={<CreateGroupDialog />}
      />
      {q.isPending ? null : d && d.items.length === 0 ? (
        <EmptyState title="No entity groups yet" body="Create a group to combine two or more companies' figures into one consolidated package." />
      ) : (
        d?.items.map((g) => <GroupCard key={g.id} group={g} />)
      )}
    </div>
  );
}

function CreateGroupDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const clients = useClients();
  const trigger = useTriggerFirmRun();
  const qc = useQueryClient();

  const save = async () => {
    setError(null);
    if (!name.trim() || selected.size === 0) {
      setError("A name and at least one member client are required.");
      return;
    }
    const scope = { name: name.trim(), memberClientIds: [...selected] };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-ENTITY-GROUP", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "CFG-CREATE-ENTITY-GROUP", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: entityGroupKeys.all });
      setOpen(false);
      setName("");
      setSelected(new Set());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="entity-group-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Create group
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create an entity group</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Group name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="entity-group-name" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Member clients</label>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-input p-2">
              {clients.data?.items.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setSelected(next);
                    }}
                    data-testid={`entity-group-member-${c.id}`}
                  />
                  {c.name}
                </label>
              )) ?? null}
            </div>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="entity-group-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupCard({ group }: { group: EntityGroup }) {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7) + "-01");
  const [packageId, setPackageId] = useState<string | null>(null);
  const pkgs = useConsolidatedPackages(group.id, period, packageId);
  const pkg = pkgs.data?.packages.find((p) => p.id === pkgs.data.selectedPackageId) ?? null;

  return (
    <SectionCard
      title={group.name}
      description={`${group.members.length} member(s): ${group.members.map((m) => m.clientName).join(", ")}${group.archivedAt ? " -- archived" : ""}`}
      testId={`card-entity-group-${group.id}`}
    >
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <EditMembersDialog group={group} />
          <RenameGroupDialog group={group} />
          <ArchiveGroupButton group={group} />
          <BuildConsolidatedDialog groupId={group.id} period={period} onBuilt={() => setPackageId(null)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label="Members" value={group.members.length} />
          <Kpi label="Period" value={fmtPeriod(period)} />
          <Kpi label="Package" value={pkg ? <Pill tone="info">{pkg.state}</Pill> : "None built"} />
          <Kpi label="Built" value={pkg ? fmtTimestamp(pkg.builtAt) : "--"} />
        </div>
        {pkg?.exceptionBanner ? <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">{pkg.exceptionBanner}</div> : null}
        {pkg ? (
          <DataGrid
            rows={pkgs.data?.sections.flatMap((s) => s.lines.map((l, i) => ({ ...l, sectionCode: s.sectionCode, sectionTitle: s.sectionTitle, key: `${s.id}:${i}` }))) ?? []}
            rowKey={(l) => l.key}
            testId={`grid-consolidated-${group.id}`}
            empty={<EmptyState title="No lines" body="This package rendered without lines." />}
            cols={[
              { key: "section", label: "Section", mobile: "title", render: (l) => <span className="text-xs text-muted-foreground">{l.sectionTitle}</span> },
              { key: "label", label: "Line", mobile: "row", render: (l) => <span className={l.accountNumber ? "pl-4" : "font-semibold"}>{l.accountNumber ? `${l.accountNumber} ` : ""}{l.label}</span> },
              { key: "amt", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.amountCents} signed /> },
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No consolidated package has been built for this period yet.</p>
        )}
      </div>
    </SectionCard>
  );
}

function EditMembersDialog({ group }: { group: EntityGroup }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const clients = useClients();
  const trigger = useTriggerFirmRun();
  const qc = useQueryClient();

  const save = async () => {
    setError(null);
    const scope = { groupId: group.id, memberClientIds: [...selected] };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-SET-GROUP-MEMBERS", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "CFG-SET-GROUP-MEMBERS", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: entityGroupKeys.all });
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
        if (next) {
          setSelected(new Set(group.members.map((m) => m.clientId)));
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`entity-group-edit-members-${group.id}`}>
          Edit members
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Members of {group.name}</DialogTitle>
        </DialogHeader>
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-input p-2">
          {clients.data?.items.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(c.id);
                  else next.delete(c.id);
                  setSelected(next);
                }}
              />
              {c.name}
            </label>
          )) ?? null}
        </div>
        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameGroupDialog({ group }: { group: EntityGroup }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerFirmRun();
  const qc = useQueryClient();

  const save = async () => {
    setError(null);
    const scope = { groupId: group.id, name: name.trim() };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-EDIT-ENTITY-GROUP", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status === "completed") {
        await trigger.mutateAsync({ runCode: "CFG-EDIT-ENTITY-GROUP", body: { mode: "apply", scope, previewRunId: preview.executionId } });
      }
      void qc.invalidateQueries({ queryKey: entityGroupKeys.all });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setName(group.name); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename group</DialogTitle>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveGroupButton({ group }: { group: EntityGroup }) {
  const trigger = useTriggerFirmRun();
  const qc = useQueryClient();

  const toggle = async () => {
    const scope = { groupId: group.id, archived: group.archivedAt === null };
    const preview = await trigger.mutateAsync({ runCode: "CFG-EDIT-ENTITY-GROUP", body: { mode: "preview", scope } });
    if (preview.status === "completed") {
      await trigger.mutateAsync({ runCode: "CFG-EDIT-ENTITY-GROUP", body: { mode: "apply", scope, previewRunId: preview.executionId } });
    }
    void qc.invalidateQueries({ queryKey: entityGroupKeys.all });
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void toggle()} disabled={trigger.isPending}>
      {group.archivedAt ? "Unarchive" : "Archive"}
    </Button>
  );
}

function BuildConsolidatedDialog({ groupId, period, onBuilt }: { groupId: string; period: string; onBuilt: () => void }) {
  const [open, setOpen] = useState(false);
  const [comparisonBasis, setComparisonBasis] = useState<ComparisonBasis>("prior_period");
  const [reportBasis, setReportBasis] = useState<ReportBasis>("accrual");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerFirmRun();
  const qc = useQueryClient();

  const build = async () => {
    setError(null);
    const scope = { groupId, period, comparisonBasis, reportBasis };
    try {
      const preview = await trigger.mutateAsync({ runCode: "RPT-BUILD-CONSOLIDATED-PACKAGE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "RPT-BUILD-CONSOLIDATED-PACKAGE", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "entity-groups", groupId, "consolidated-packages"] });
      setOpen(false);
      onBuilt();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid={`entity-group-build-${groupId}`}>
          Build consolidated package
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Build consolidated package</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">For {fmtPeriod(period)}. Refuses if intercompany balances across the group do not net to zero.</p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Report basis</label>
            <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={reportBasis} onChange={(e) => setReportBasis(e.target.value as ReportBasis)}>
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Comparison basis</label>
            <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={comparisonBasis} onChange={(e) => setComparisonBasis(e.target.value as ComparisonBasis)}>
              <option value="prior_period">Prior period</option>
              <option value="prior_year">Prior year</option>
              <option value="budget">Budget</option>
              <option value="none">None</option>
            </select>
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void build()} disabled={trigger.isPending} data-testid={`entity-group-confirm-build-${groupId}`}>
            Build
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
