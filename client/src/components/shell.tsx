import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  BadgeCheck,
  Banknote,
  BookOpen,
  Building2,
  CalendarCheck,
  ClipboardList,
  FileSignature,
  FileText,
  Gauge,
  Inbox,
  LayoutGrid,
  Layers,
  LineChart,
  Menu,
  MessageSquare,
  Moon,
  PieChart,
  Receipt,
  Repeat,
  ScrollText,
  Settings2,
  Sun,
  Table2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { useApp } from "@/store";
import { PERIODS } from "@/data/seed";
import { fmtPeriod } from "@/lib/money";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Gauge;
  badge?: (ctx: { needsReview: number; openItems: number; overdue: number }) => number | undefined;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const FIRM_NAV: NavGroup[] = [
  {
    label: "Practice",
    items: [
      { href: "/", label: "Firm overview", icon: Gauge },
      { href: "/clients", label: "Client book", icon: Building2 },
      { href: "/intake", label: "New client intake", icon: UserPlus },
    ],
  },
  {
    label: "Accounting",
    items: [
      { href: "/transactions", label: "Transactions", icon: Table2, badge: (c) => c.needsReview || undefined },
      { href: "/rules", label: "Categorization rules", icon: Repeat },
      { href: "/reconcile", label: "Reconciliation", icon: BadgeCheck },
      { href: "/aging", label: "AR and AP aging", icon: Banknote },
      { href: "/journal", label: "Journal entries", icon: BookOpen },
      { href: "/substantiation", label: "Substantiation", icon: Layers },
      { href: "/statements", label: "Financial statements", icon: ScrollText },
    ],
  },
  {
    label: "Management",
    items: [
      { href: "/close", label: "Close checklist", icon: CalendarCheck },
      { href: "/board", label: "Workload board", icon: LayoutGrid, badge: (c) => c.overdue || undefined },
      { href: "/team", label: "Team capacity", icon: Users },
      { href: "/comms", label: "Communication log", icon: MessageSquare },
      { href: "/requests", label: "Open items", icon: ClipboardList, badge: (c) => c.openItems || undefined },
    ],
  },
  {
    label: "Reporting",
    items: [
      { href: "/package", label: "Report package", icon: FileText },
      { href: "/budget", label: "Budget versus actual", icon: PieChart },
      { href: "/forecast", label: "Cash forecast", icon: LineChart },
      { href: "/narrative", label: "Monthly narrative", icon: ScrollText },
      { href: "/tax-forms", label: "1099 and W-9 tracker", icon: Receipt },
    ],
  },
];

const PORTAL_NAV: NavGroup[] = [
  {
    label: "My books",
    items: [
      { href: "/portal", label: "Portal home", icon: Gauge },
      { href: "/portal/upload", label: "Send documents", icon: Upload },
      { href: "/portal/documents", label: "Document library", icon: FileText },
      { href: "/portal/requests", label: "What we need", icon: Inbox, badge: (c) => c.openItems || undefined },
      { href: "/portal/sign", label: "Signatures and W-9", icon: FileSignature },
      { href: "/portal/reports", label: "My reports", icon: ScrollText },
      { href: "/portal/messages", label: "Messages", icon: MessageSquare },
    ],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { plane, ds, activeClientId, period } = useApp();
  const [location] = useLocation();
  const groups = plane === "firm" ? FIRM_NAV : PORTAL_NAV;
  const ctx = {
    needsReview: ds.txns.filter((t) => t.clientId === activeClientId && t.status === "needs_review").length,
    openItems: ds.openItems.filter((o) => o.clientId === activeClientId && (o.status === "not_started" || o.status === "rejected")).length,
    overdue: ds.tasks.filter((t) => t.period === period && t.status !== "Done").length,
  };
  return (
    <nav className="flex flex-col gap-5 px-3 py-4" data-testid="nav-main">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g.label}</p>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const active = location === it.href;
              const badge = it.badge?.(ctx);
              const Icon = it.icon;
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                    data-testid={`link-${it.href === "/" ? "overview" : it.href.replace(/\//g, "-").replace(/^-/, "")}`}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "")} />
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {badge ? (
                      <span className="tnum rounded-sm bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                        {badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function PlaneSwitcher() {
  const { plane, setPlane } = useApp();
  const [, navigate] = useLocation();
  return (
    <div className="flex items-center rounded-sm border border-border bg-muted p-0.5" data-testid="switch-plane">
      {(["firm", "portal"] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            setPlane(p);
            navigate(p === "firm" ? "/" : "/portal");
          }}
          className={cn(
            "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
            plane === p ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`button-plane-${p}`}
        >
          {p === "firm" ? "Firm" : "Client portal"}
        </button>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { ds, activeClientId, setActiveClient, period, setPeriod, theme, setTheme, plane, loadMode, setLoadMode } = useApp();
  const [mobileNav, setMobileNav] = useState(false);
  const client = ds.clients.find((c) => c.id === activeClientId);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden w-[238px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
          <Logo />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
          <NavList />
        </div>
        <div className="shrink-0 border-t border-border px-3 py-3">
          <p className="px-1 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Data source</p>
          <Select value={loadMode} onValueChange={(v) => setLoadMode(v as typeof loadMode)}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-loadmode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">Mock data, normal</SelectItem>
              <SelectItem value="slow">Mock data, slow network</SelectItem>
              <SelectItem value="error">Mock data, failing</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </aside>

      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-[264px] overflow-y-auto p-0">
          <div className="flex h-14 items-center border-b border-border px-4">
            <Logo />
          </div>
          <NavList onNavigate={() => setMobileNav(false)} />
          <div className="border-t border-border px-3 py-3">
            <p className="px-1 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Data source</p>
            <Select value={loadMode} onValueChange={(v) => setLoadMode(v as typeof loadMode)}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-loadmode-mobile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Mock data, normal</SelectItem>
                <SelectItem value="slow">Mock data, slow network</SelectItem>
                <SelectItem value="error">Mock data, failing</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileNav(true)}
            data-testid="button-mobile-nav"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="lg:hidden">
            <Logo compact />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Select value={activeClientId} onValueChange={setActiveClient}>
              <SelectTrigger className="h-8 w-[150px] text-xs sm:w-[210px]" data-testid="select-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ds.clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.shortName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="hidden h-8 w-[120px] text-xs sm:flex" data-testid="select-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {fmtPeriod(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="hidden sm:block">
              <PlaneSwitcher />
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle color theme"
              data-testid="button-theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 sm:hidden">
          <PlaneSwitcher />
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-8 flex-1 text-xs" data-testid="select-period-mobile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {fmtPeriod(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {plane === "firm" ? "Firm workspace" : "Client portal preview"} for {client?.dba || "no client"}, period{" "}
            {fmtPeriod(period)}
          </span>
        </div>

        <main
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ overscrollBehavior: "contain" }}
          data-testid="main-scroll"
        >
          <div className="mx-auto w-full max-w-[1400px] space-y-5 p-3 pb-16 sm:p-5">{children}</div>
        </main>
      </div>
    </div>
  );
}
