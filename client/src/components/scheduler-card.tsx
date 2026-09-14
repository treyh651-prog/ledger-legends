import { useEffect, useState } from "react";
import { AlarmClock, CircleAlert, Clock3, Hourglass } from "lucide-react";
import { EmptyState, Pill, SectionCard } from "@/components/kit";

/**
 * What the clock did, on the page the operator already has open.
 *
 * Every other card on this page reads the seeded demonstration data. This one
 * reads the live scheduler through /api/sched/status, because a card that
 * showed a plausible seeded scheduler would be worse than no card at all: the
 * one thing a person needs from this surface is to find out that something did
 * not run, and a mock cannot tell them that.
 *
 * On a machine with no scheduler configured, which is every developer
 * checkout, it says so plainly and shows nothing else. It does not render an
 * error state, because an unconfigured scheduler is not a fault.
 */

interface WindowNote {
  scheduleName: string;
  runType: string;
  localDay: string;
  status: string;
  detail: string | null;
}

interface ScheduleStatus {
  scheduleId: string;
  name: string;
  runType: string;
  tier: string;
  cadence: string;
  timezone: string;
  executionMode: string;
  frozenByHand: boolean;
  nextFireAt: string | null;
  lastWindowStart: string | null;
  lastWindowStatus: string | null;
  consecutiveFailures: number;
  lastFailureDetail: string | null;
}

interface StatusBody {
  configured: boolean;
  reason?: string;
  error?: string;
  status?: {
    asOf: string;
    catchUpDays: number;
    schedules: ScheduleStatus[];
    failing: ScheduleStatus[];
    waitingForApproval: WindowNote[];
    missed: WindowNote[];
    stalled: WindowNote[];
    counts: {
      schedules: number;
      enabled: number;
      succeeded: number;
      failed: number;
      skipped: number;
      outstanding: number;
    };
  };
}

function localTime(iso: string | null): string {
  if (iso === null) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SchedulerCard() {
  const [body, setBody] = useState<StatusBody | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/sched/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: StatusBody) => {
        if (live) setBody(j);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed || body === null) return null;

  if (!body.configured || body.status === undefined) {
    return (
      <SectionCard
        title="Scheduled runs"
        description="Windows the clock owed, and what happened to them."
        testId="card-scheduler"
      >
        <EmptyState
          title="No scheduler configured in this process"
          body={
            body.reason ??
            "Set SCHEDULER_FIRM_ID and SCHEDULER_ACTOR_ID to point this surface at a firm."
          }
          icon={<AlarmClock className="h-4 w-4" />}
        />
      </SectionCard>
    );
  }

  const s = body.status;
  const quiet =
    s.failing.length === 0 && s.missed.length === 0 && s.stalled.length === 0;

  return (
    <SectionCard
      title="Scheduled runs"
      description={`${String(s.counts.enabled)} enabled schedules, ${String(s.catchUpDays)} day catch up bound, as of ${localTime(s.asOf)}.`}
      testId="card-scheduler"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill tone="good">{s.counts.succeeded} succeeded</Pill>
          <Pill tone={s.counts.failed > 0 ? "risk" : "neutral"}>{s.counts.failed} failed</Pill>
          <Pill tone={s.counts.skipped > 0 ? "watch" : "neutral"}>{s.counts.skipped} skipped</Pill>
          <Pill tone={s.counts.outstanding > 0 ? "watch" : "neutral"}>
            {s.counts.outstanding} outstanding
          </Pill>
        </div>

        {s.failing.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Failing
            </p>
            <ul className="space-y-2">
              {s.failing.map((f) => (
                <li key={f.scheduleId} className="flex items-start gap-2">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="text-sm leading-snug">
                      {f.name} failed {f.consecutiveFailures} times in a row
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {f.lastFailureDetail ?? f.runType}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {s.missed.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recorded and not run
            </p>
            <ul className="space-y-2">
              {s.missed.slice(0, 6).map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <p className="text-sm leading-snug">
                      {w.localDay} {w.scheduleName}
                    </p>
                    <p className="text-xs text-muted-foreground">{w.detail ?? w.runType}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {s.waitingForApproval.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Prepared and waiting for a decision
            </p>
            <ul className="space-y-1">
              {s.waitingForApproval.slice(0, 6).map((w, i) => (
                <li key={i} className="text-sm">
                  {w.localDay} {w.scheduleName}
                  <span className="text-muted-foreground"> {w.runType}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {quiet ? (
          <EmptyState
            title="Every window landed"
            body="Nothing missed, nothing stalled, and no schedule has failed twice in a row."
            icon={<Clock3 className="h-4 w-4" />}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}
