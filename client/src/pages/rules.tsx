import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveClient } from "@/lib/active-client";
import { useRules, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { Rule } from "@shared/api";

/**
 * Coding rules, read from GET /api/firm/clients/:id/rules. The order shown is
 * the tie break order the cascade applies: priority descending, condition
 * count descending, id ascending.
 *
 * Name, priority, and active both run through CFG-EDIT-RULE. That run also
 * accepts conditions and the target category, but this screen does not build
 * an editor for either: a condition list or a category picker is a bigger UI
 * than a name and a number, and nothing today asks for it on this screen.
 */
export default function Rules() {
  const { client, clientId } = useActiveClient();
  const q = useRules(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-rules">
      <PageHeader title="Rules" subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} active rules, ${d.autoPostCount} with auto post on.` : ""}`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Active rules" value={d ? d.items.length : "…"} testId="kpi-rules" />
        <Kpi label="Auto post enabled" value={d ? d.autoPostCount : "…"} />
        <Kpi label="Accepted codings" value={d ? d.items.reduce((n, r) => n + r.acceptedCount, 0) : "…"} />
      </div>
      <SectionCard title="Rules in cascade order" description="The first rule whose conditions match wins.">
        <DataGrid<Rule>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(r) => r.id}
          testId="grid-rules"
          empty={<EmptyState title="No rules yet" body="Rules come from the firm library and from accepted codings; none has been written for this client." />}
          cols={[
            { key: "pri", label: "Priority", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.priority}</span> },
            { key: "name", label: "Rule", mobile: "title", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "cond", label: "Conditions", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.conditionCount}</span> },
            { key: "target", label: "Codes to", mobile: "row", render: (r) => <span>{r.targetCategoryName ?? r.targetCategoryId}</span> },
            { key: "scope", label: "Scope", mobile: "row", render: (r) => <Pill tone={r.scopeKind === "firm_library" ? "info" : "neutral"}>{r.scopeKind === "firm_library" ? "Firm library" : "Client"}</Pill> },
            { key: "acc", label: "Accepted / rejected", align: "right", mobile: "row", render: (r) => <span className="tnum text-xs">{r.acceptedCount} / {r.rejectedCount}</span> },
            {
              key: "auto",
              label: "Auto post",
              mobile: "value",
              render: (r) => (r.autoPostEnabled ? <Pill tone="good">Up to {usd(r.autoPostCeilingCents)}</Pill> : <Pill tone="neutral">Off</Pill>),
            },
            {
              key: "edit",
              label: "",
              mobile: "row",
              render: (r) => (clientId ? <EditRulePopover clientId={clientId} rule={r} /> : null),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function EditRulePopover({ clientId, rule }: { clientId: string; rule: Rule }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(rule.name);
  const [priority, setPriority] = useState(String(rule.priority));
  const [isActive, setIsActive] = useState(rule.isActive);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setName(rule.name);
    setPriority(String(rule.priority));
    setIsActive(rule.isActive);
    setError(null);
  };

  const save = async () => {
    setError(null);
    const fields: Record<string, unknown> = {};
    if (name.trim() !== rule.name) fields.name = name.trim();
    const parsedPriority = Number(priority);
    if (Number.isInteger(parsedPriority) && parsedPriority !== rule.priority) fields.priority = parsedPriority;
    if (isActive !== rule.isActive) fields.isActive = isActive;
    if (Object.keys(fields).length === 0) {
      setOpen(false);
      return;
    }
    const scope = { clientId, ruleId: rule.id, changeNote: "edited from the rules screen", fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-EDIT-RULE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-EDIT-RULE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.rules(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid={`rule-edit-${rule.id}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-testid={`rule-edit-name-${rule.id}`} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Priority</label>
          <Input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            data-testid={`rule-edit-priority-${rule.id}`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} data-testid={`rule-edit-active-${rule.id}`} />
          Active
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid={`rule-edit-save-${rule.id}`}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
