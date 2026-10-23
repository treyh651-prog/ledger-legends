import type { ReactNode } from "react";
import { CheckCircle2, Info, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { tierMeta, type TierId } from "@shared/tiers";

/**
 * Portal furniture. The portal reads as its own product while using the same tokens as
 * the firm side, so nothing here introduces a new color.
 */

const TIER_DOT: Record<TierId, string> = {
  ledger: "bg-muted-foreground",
  ledger_plus: "bg-primary",
  legend: "bg-[hsl(var(--chart-4))]",
};

export function TierBadge({ tier, className, testId }: { tier: TierId; className?: string; testId?: string }) {
  const meta = tierMeta(tier);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-border bg-card px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
      data-testid={testId}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", TIER_DOT[tier])} />
      {meta.name}
    </span>
  );
}

/** Portal page header. Wider type and a tinted band, so the client side never looks like the firm side. */
export function PortalHero({
  title,
  subtitle,
  tier,
  actions,
  meta,
  testId,
}: {
  title: string;
  subtitle?: string;
  tier?: TierId;
  actions?: ReactNode;
  meta?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="rounded-lg border border-card-border bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5"
      data-testid={testId}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {tier ? <TierBadge tier={tier} testId="badge-portal-tier" /> : null}
            {meta}
          </div>
          <h1 className="mt-2 text-xl font-semibold leading-tight tracking-tight sm:text-2xl" data-testid="text-page-title">
            {title}
          </h1>
          {subtitle ? <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}



const TONE_TEXT: Record<string, string> = {
  good: "text-positive",
  watch: "text-warning",
  risk: "text-destructive",
  neutral: "",
};

/** The true number, rendered the same way everywhere it appears. */

/**
 * The one locked state used across the portal.
 *
 * Two shapes, never a third. When the client has data, the true number is shown and only
 * the detail is held back. When there is no data behind the feature, it says that plainly
 * instead of putting a lock over an empty panel. Nothing here is blurred, sampled, or made up.
 */

/** Small inline note for a feature the client does have, used to explain a limit honestly. */
export function PortalNote({ children, tone = "info", testId }: { children: ReactNode; tone?: "info" | "watch"; testId?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm leading-relaxed",
        tone === "watch" ? "border-warning/40 bg-warning-soft text-warning" : "border-border bg-muted/40 text-muted-foreground",
      )}
      data-testid={testId}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function IncludedRow({ label, included }: { label: string; included: boolean }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {included ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive" />
      ) : (
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className={included ? "" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}
