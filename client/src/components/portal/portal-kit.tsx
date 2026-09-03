import type { ReactNode } from "react";
import { Link } from "wouter";
import { CheckCircle2, Info, Lock, ShieldCheck } from "lucide-react";
import { Money, Pill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtPeriod } from "@/lib/money";
import { FEATURE_BY_ID, tierMeta, type FeatureId } from "@/data/entitlement";
import type { PeriodClose, TierId } from "@/data/types";
import type { FactStat, TruthfulFact } from "@/data/portal-facts";

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

export function ClosePill({ close, testId }: { close?: PeriodClose; testId?: string }) {
  if (!close) return <Pill tone="neutral" testId={testId}>No close record</Pill>;
  if (close.state === "open") {
    return (
      <Pill tone="watch" testId={testId}>
        {fmtPeriod(close.period)} still open
      </Pill>
    );
  }
  return (
    <Pill tone={close.withExceptions ? "watch" : "good"} testId={testId}>
      <ShieldCheck className="h-3 w-3" />
      {fmtPeriod(close.period)} closed{close.locked ? " and locked" : ""}
      {close.withExceptions ? ", with a noted exception" : ""}
    </Pill>
  );
}

function statValue(stat: FactStat) {
  if (typeof stat.cents === "number") return <Money cents={stat.cents} signed={stat.signed} testId="text-fact-value" />;
  if (typeof stat.count === "number") return <span className="tnum">{stat.count}</span>;
  return <span>{stat.text}</span>;
}

const TONE_TEXT: Record<string, string> = {
  good: "text-positive",
  watch: "text-warning",
  risk: "text-destructive",
  neutral: "",
};

/** The true number, rendered the same way everywhere it appears. */
export function FactPanel({ fact, testId }: { fact: TruthfulFact; testId?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{fact.headline.label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold tracking-tight", TONE_TEXT[fact.headline.tone || "neutral"])}>
        {statValue(fact.headline)}
      </p>
      {fact.supporting.length > 0 ? (
        <dl className={cn("mt-3 grid gap-2 border-t border-border pt-3", fact.supporting.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          {fact.supporting.map((s) => (
            <div key={s.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className={cn("text-sm font-medium", TONE_TEXT[s.tone || "neutral"])}>{statValue(s)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{fact.basis}</span>
      </p>
    </div>
  );
}

/**
 * The one locked state used across the portal.
 *
 * Two shapes, never a third. When the client has data, the true number is shown and only
 * the detail is held back. When there is no data behind the feature, it says that plainly
 * instead of putting a lock over an empty panel. Nothing here is blurred, sampled, or made up.
 */
export function LockedFeature({
  feature,
  fact,
  currentTier,
  className,
  testId,
}: {
  feature: FeatureId;
  fact: TruthfulFact;
  currentTier: TierId;
  className?: string;
  testId?: string;
}) {
  const meta = FEATURE_BY_ID[feature];
  const needed = tierMeta(meta.minTier);
  const current = tierMeta(currentTier);
  const detail = fact.lockedDetail.replace(/\.$/, "");
  return (
    <section
      className={cn("rounded-lg border border-dashed border-primary/40 bg-card", className)}
      data-testid={testId || `locked-${feature}`}
    >
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{meta.label}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{meta.summary}</p>
          </div>
        </div>
        <TierBadge tier={meta.minTier} className="self-start sm:self-auto" testId={`badge-need-${feature}`} />
      </header>
      <div className="space-y-3 p-4">
        {fact.hasData ? (
          <>
            <FactPanel fact={fact} testId={`fact-${feature}`} />
            <p className="text-sm leading-relaxed">
              That number is yours and it is current, taken from your own posted records. What opens at {needed.name}: {detail}.
            </p>
          </>
        ) : (
          <div className="rounded-md border border-border bg-muted/40 p-3" data-testid={`fact-empty-${feature}`}>
            <p className="text-sm font-medium">Nothing to unlock here yet</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{fact.emptyNote}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Part of {needed.name}: {detail}. It stays quiet until there is something real to show.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center">
          <p className="min-w-0 text-xs leading-relaxed text-muted-foreground sm:flex-1">
            You are on {current.name}. Your service level is set on your engagement, so ask us and we will change it. Nothing to buy here.
          </p>
          <Button asChild size="sm" variant="outline" className="self-start sm:self-auto" data-testid={`link-tiers-${feature}`}>
            <Link href="/portal/tiers">Compare service levels</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

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
