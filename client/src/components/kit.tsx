import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usd, signedUsd } from "@/lib/money";

/* ---------------- page furniture ---------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
  testId,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between" data-testid={testId}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  testId,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section className={cn("rounded-md border border-card-border bg-card", className)} data-testid={testId}>
      {title ? (
        <header className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "good" | "watch" | "risk";
  testId?: string;
}) {
  const bar = {
    neutral: "bg-border",
    good: "bg-positive",
    watch: "bg-warning",
    risk: "bg-destructive",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-md border border-card-border bg-card p-4" data-testid={testId}>
      <span className={cn("absolute left-0 top-0 h-full w-[3px]", bar)} />
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tnum mt-2 text-lg font-semibold leading-tight sm:text-xl">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const pillTones = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-positive-soft text-positive",
  watch: "bg-warning-soft text-warning",
  risk: "bg-danger-soft text-destructive",
  info: "bg-accent text-accent-foreground",
} as const;

export function Pill({
  children,
  tone = "neutral",
  className,
  testId,
}: {
  children: ReactNode;
  tone?: keyof typeof pillTones;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
        pillTones[tone],
        className,
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

export function Money({
  cents,
  signed = false,
  className,
  dim = false,
  testId,
}: {
  cents: number;
  signed?: boolean;
  className?: string;
  dim?: boolean;
  testId?: string;
}) {
  const text = signed ? signedUsd(cents) : usd(cents);
  return (
    <span
      className={cn(
        "tnum whitespace-nowrap",
        signed && cents < 0 ? "text-destructive" : "",
        dim && cents === 0 ? "text-muted-foreground" : "",
        className,
      )}
      data-testid={testId}
    >
      {text}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center" data-testid="state-empty">
      <div className="mb-1 rounded-md border border-border bg-muted p-2 text-muted-foreground">
        {icon || <Inbox className="h-4 w-4" />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {body ? <p className="max-w-md text-sm text-muted-foreground">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center" data-testid="state-error">
      <div className="rounded-md border border-destructive/40 bg-danger-soft p-2 text-destructive">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-medium">This view could not load</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry">
        <RefreshCw className="mr-2 h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}

export function LoadingRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" data-testid="state-loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cn("h-4", c === 0 ? "w-1/3" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------------- data grid ---------------- */

export type MobileRole = "title" | "sub" | "value" | "row" | "hide";

export interface Col<T> {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string;
  render: (row: T, index: number) => ReactNode;
  mobile?: MobileRole;
  headClassName?: string;
  cellClassName?: string;
}

export function DataGrid<T>({
  rows,
  cols,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  rowClassName,
  footer,
  dense,
  maxHeight,
  testId,
}: {
  rows: T[];
  cols: Col<T>[];
  rowKey: (row: T, i: number) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  footer?: ReactNode;
  dense?: boolean;
  maxHeight?: string;
  testId?: string;
}) {
  if (loading) return <LoadingRows rows={6} cols={Math.min(cols.length, 5)} />;
  if (error && onRetry) return <ErrorState message={error} onRetry={onRetry} />;
  if (!rows.length)
    return <>{empty || <EmptyState title="Nothing here yet" body="When records show up they will be listed here." />}</>;

  const pad = dense ? "px-3 py-1.5" : "px-3 py-2.5";
  const alignCls = (a?: string) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

  const titleCol = cols.find((c) => c.mobile === "title") || cols[0];
  const subCols = cols.filter((c) => c.mobile === "sub");
  const valueCol = cols.find((c) => c.mobile === "value");
  const rowCols = cols.filter((c) => c.mobile === "row");

  return (
    <div data-testid={testId}>
      {/* table for wide screens */}
      <div className="hidden md:block">
        <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border">
                {cols.map((c) => (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={cn(
                      "whitespace-nowrap bg-card px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                      alignCls(c.align),
                      c.headClassName,
                    )}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-border/70 last:border-0",
                    onRowClick ? "cursor-pointer hover-elevate" : "",
                    rowClassName?.(row),
                  )}
                  data-testid={`row-${rowKey(row, i)}`}
                >
                  {cols.map((c) => (
                    <td key={c.key} className={cn(pad, "align-middle", alignCls(c.align), c.cellClassName)}>
                      {c.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer ? <tfoot className="border-t border-border bg-muted/40">{footer}</tfoot> : null}
          </table>
        </div>
      </div>

      {/* stacked cards for narrow screens */}
      <ul className="divide-y divide-border md:hidden">
        {rows.map((row, i) => (
          <li
            key={rowKey(row, i)}
            className={cn("px-3 py-3", onRowClick ? "active-elevate cursor-pointer" : "")}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            data-testid={`card-${rowKey(row, i)}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-snug">{titleCol.render(row, i)}</div>
                {subCols.length ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {subCols.map((c) => (
                      <span key={c.key} className="inline-flex items-center gap-1">
                        {c.render(row, i)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {valueCol ? <div className="tnum shrink-0 text-right text-sm font-semibold">{valueCol.render(row, i)}</div> : null}
            </div>
            {rowCols.length ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {rowCols.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</dt>
                    <dd className="tnum truncate text-xs">{c.render(row, i)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        ))}
        {footer ? <li className="bg-muted/40 px-3 py-3 text-sm">{footer}</li> : null}
      </ul>
    </div>
  );
}

/* ---------------- misc small pieces ---------------- */

export function Meter({ pct, tone = "primary" }: { pct: number; tone?: "primary" | "warning" | "danger" }) {
  const bg = tone === "warning" ? "bg-warning" : tone === "danger" ? "bg-destructive" : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full transition-all", bg)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 break-words text-sm">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ToneDot({ tone }: { tone: "good" | "watch" | "risk" | "neutral" }) {
  const c = { good: "bg-positive", watch: "bg-warning", risk: "bg-destructive", neutral: "bg-muted-foreground" }[tone];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", c)} />;
}
