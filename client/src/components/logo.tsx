export function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-label="Ledger Legends mark"
      role="img"
      data-testid="logo-mark"
    >
      {/* ledger spine */}
      <path d="M4 3.5v17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      {/* two equal bars, the debit and the credit, tied out */}
      <path d="M8.5 9.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path d="M8.5 14.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      {/* tie out square */}
      <rect x="8.5" y="18.5" width="4" height="4" fill="hsl(var(--primary))" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="logo">
      <Mark className="h-6 w-6 text-foreground" />
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight">Ledger Legends</span>
          <span className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Bookkeeping practice</span>
        </span>
      )}
    </div>
  );
}
