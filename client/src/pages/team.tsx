import { useMemo } from "react";
import { Users } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, Meter, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useFirmTasks, useFirmTeam, errorMessage } from "@/api";
import { fmtPeriod } from "@/lib/money";
import type { FirmMember } from "@shared/api";

interface MemberLoad {
  member: FirmMember;
  open: number;
  overdue: number;
  complete: number;
}

/**
 * The firm's members and what each one is carrying this period. Members come
 * from GET /api/firm/team (tenancy.memberships, firm scope, not revoked) and
 * the load from GET /api/firm/tasks. Capacity is not a column anywhere, so
 * the meter is each member's share of the open work, not a percentage of a
 * number nobody recorded. Invitations and roles are edited on the Access
 * screen.
 */
export default function Team() {
  const { period } = useApp();
  const team = useFirmTeam();
  const tasks = useFirmTasks(period);
  const today = new Date().toISOString().slice(0, 10);

  const loads = useMemo<MemberLoad[]>(() => {
    const items = tasks.data?.items ?? [];
    return (team.data?.items ?? []).map((member) => {
      const mine = items.filter((t) => t.assigneeId === member.userId);
      return {
        member,
        open: mine.filter((t) => t.state !== "complete").length,
        overdue: mine.filter((t) => t.state !== "complete" && t.dueDate < today).length,
        complete: mine.filter((t) => t.state === "complete").length,
      };
    });
  }, [team.data, tasks.data, today]);

  const items = tasks.data?.items ?? [];
  const unassigned = items.filter((t) => t.state !== "complete" && !t.assigneeId).length;
  const totalOpen = items.filter((t) => t.state !== "complete").length;

  if (team.isError) return <ErrorState message={errorMessage(team.error)} onRetry={() => void team.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-team">
      <PageHeader title="Team" subtitle={`Firm members and their open work for ${fmtPeriod(period)}. Roles and invitations live on the Access screen.`} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Members" value={team.data ? team.data.items.length : "…"} testId="kpi-members" />
        <Kpi label="Open tasks" value={tasks.data ? totalOpen : "…"} />
        <Kpi label="Unassigned" value={tasks.data ? unassigned : "…"} tone={unassigned > 0 ? "watch" : "neutral"} />
      </div>

      <SectionCard title="Members" description="Share of open work is each member's open tasks over the firm's open tasks.">
        <DataGrid<MemberLoad>
          rows={loads}
          loading={team.isPending || tasks.isPending}
          rowKey={(r) => r.member.userId}
          testId="grid-team"
          empty={<EmptyState icon={<Users className="h-5 w-5" />} title="No members yet" body="Invite someone from the Access screen." />}
          cols={[
            { key: "name", label: "Member", mobile: "title", render: (r) => <span className="font-medium">{r.member.displayName}</span> },
            { key: "email", label: "Email", mobile: "row", render: (r) => <span className="text-xs text-muted-foreground">{r.member.email}</span> },
            { key: "role", label: "Role", mobile: "row", render: (r) => <Pill tone="neutral">{r.member.role}</Pill> },
            { key: "open", label: "Open", mobile: "row", render: (r) => <span className="tnum">{r.open}</span> },
            {
              key: "overdue",
              label: "Overdue",
              mobile: "row",
              render: (r) => <span className={`tnum ${r.overdue > 0 ? "text-destructive" : ""}`}>{r.overdue}</span>,
            },
            { key: "complete", label: "Complete", mobile: "row", render: (r) => <span className="tnum">{r.complete}</span> },
            {
              key: "share",
              label: "Share of open work",
              mobile: "row",
              render: (r) => <Meter pct={totalOpen ? Math.round((r.open / totalOpen) * 100) : 0} tone={r.overdue > 0 ? "danger" : "primary"} />,
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
