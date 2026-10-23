import { useEffect, useMemo, useRef, useState } from "react";
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
  GitCompareArrows,
  Inbox,
  Lock,
  LayoutGrid,
  Layers,
  LineChart,
  Menu,
  MessageSquare,
  Moon,
  PieChart,
  Receipt,
  Repeat,
  ScanLine,
  ScrollText,
  Settings2,
  Sun,
  Table2,
  Timer,
  Upload,
  UserPlus,
  Users,
  Wand2,
  Columns3,
  KeyRound,
  LogOut,
  UserCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { useApp } from "@/store";
import { hasFeature, tierMeta, type FeatureId } from "@shared/tiers";
import { fmtPeriod } from "@/lib/money";
import { useAuth } from "@/lib/auth";
import { defaultPeriodFor, periodsFor, useActiveClient } from "@/lib/active-client";
import { usePortalClient } from "@/lib/use-portal-client";
import { usePortalHome } from "@/api";
import { isTierId } from "@shared/tiers";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Gauge;
  badge?: (ctx: { needsReview: number; openItems: number; overdue: number }) => number | undefined;
  /** Portal only. When the client's service level does not reach it, the row is marked. */
  feature?: FeatureId;
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
      { href: "/portal/intake", label: "Client setup wizard", icon: Wand2 },
      { href: "/portal/mapping-profiles", label: "Mapping profiles", icon: Columns3 },
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
      { href: "/access", label: "Access", icon: KeyRound },
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
    label: "My records",
    items: [
      { href: "/portal", label: "Portal home", icon: Gauge },
      { href: "/portal/statements", label: "Financial statements", icon: ScrollText, feature: "statements" },
      { href: "/portal/transactions", label: "My transactions", icon: Table2, feature: "transactions" },
      { href: "/portal/upload", label: "Send documents", icon: Upload, feature: "documents" },
      { href: "/portal/documents", label: "Document library", icon: FileText },
      { href: "/portal/requests", label: "What we need", icon: Inbox, badge: (c) => c.openItems || undefined, feature: "requests" },
      { href: "/portal/sign", label: "Signatures and W-9", icon: FileSignature },
      { href: "/portal/messages", label: "Messages", icon: MessageSquare, feature: "messages" },
      { href: "/portal/reports", label: "Monthly package", icon: BookOpen },
    ],
  },
  {
    label: "Read the numbers",
    items: [
      { href: "/portal/compare", label: "Month over month", icon: GitCompareArrows, feature: "compare" },
      { href: "/portal/budget", label: "Budget versus actual", icon: PieChart, feature: "budget" },
      { href: "/portal/aging", label: "Who owes what", icon: Banknote, feature: "aging" },
      { href: "/portal/open-period", label: "Month in progress", icon: Timer, feature: "open_period" },
    ],
  },
  {
    label: "Look ahead",
    items: [
      { href: "/portal/forecast", label: "Thirteen week cash", icon: LineChart, feature: "forecast" },
      { href: "/portal/scenarios", label: "Scenarios", icon: ScanLine, feature: "scenarios" },
      { href: "/portal/narrative", label: "The read on my month", icon: ScrollText, feature: "narrative" },
      { href: "/portal/entities", label: "My group", icon: Layers, feature: "consolidation" },
    ],
  },
  {
    label: "My service",
    items: [{ href: "/portal/tiers", label: "What each level includes", icon: BadgeCheck }],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { plane } = useApp();
  const [location] = useLocation();
  const groups = plane === "firm" ? FIRM_NAV : PORTAL_NAV;
  const { client } = useActiveClient();
  const portal = usePortalClient();
  const home = usePortalHome(plane === "portal" ? portal.clientId : null);
  const tier = home.data && isTierId(home.data.tier) ? home.data.tier : null;
  const hasClients = plane === "portal" ? portal.hasClients : client !== null;
  const ctx = {
    needsReview: client?.openSuspense ?? 0,
    openItems: plane === "portal" ? home.data?.openRequests.length ?? 0 : client?.openRequests ?? 0,
    overdue: client?.openTasks ?? 0,
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
              const gated = plane === "portal" && hasClients && it.feature && tier ? !hasFeature(tier, it.feature) : false;
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
                    {gated ? <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Higher service level" /> : null}
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

/**
 * Firm or client portal. Which planes show depends on who is signed in: a
 * client scoped user has no firm plane to switch to, so the control is not
 * drawn for them, and firm staff keep both. With sign in off (a developer
 * machine on the memory port) both planes show, as before.
 */
function PlaneSwitcher() {
  const { plane, setPlane } = useApp();
  const auth = useAuth();
  const [, navigate] = useLocation();
  const planes = (["firm", "portal"] as const).filter((p) => (p === "firm" ? auth.canUseFirmPlane : auth.canUsePortalPlane));
  if (planes.length < 2) return null;
  return (
    <div className="flex items-center rounded-sm border border-border bg-muted p-0.5" data-testid="switch-plane">
      {planes.map((p) => (
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


/** Who is signed in, which firm, and the way out. Hidden when sign in is off. */
function UserMenu() {
  const auth = useAuth();
  if (auth.status !== "signed-in" || !auth.me) return null;
  const firms = auth.me.memberships.filter((m) => m.scope === "firm");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account" data-testid="button-account">
          <UserCircle2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{auth.me.displayName ?? auth.me.email}</div>
          <div className="text-xs text-muted-foreground">{auth.me.email}</div>
          {auth.firm ? <div className="mt-1 text-xs text-muted-foreground">{auth.firm.firmName}, {auth.firm.role.replace("_", " ")}</div> : null}
        </DropdownMenuLabel>
        {firms.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Switch firm</DropdownMenuLabel>
            {firms.map((f) => (
              <DropdownMenuItem key={f.firmId} onClick={() => auth.setFirm(f.firmId)} data-testid={`menu-firm-${f.firmSlug}`}>
                {f.firmName}
                {auth.firm?.firmId === f.firmId ? <span className="ml-auto text-xs text-muted-foreground">current</span> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void auth.signOut()} data-testid="menu-sign-out">
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Portal sidebar band. Same tokens as the firm side, different surface, so the plane is obvious. */
function PortalTierBand() {
  const portal = usePortalClient();
  const home = usePortalHome(portal.clientId);
  if (!portal.hasClients || !home.data) {
    return (
      <div className="shrink-0 border-b border-border bg-primary/5 px-4 py-2.5">
        <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Client portal</p>
        <p className="mt-0.5 text-sm font-medium">No engagement loaded</p>
      </div>
    );
  }
  const tier = isTierId(home.data.tier) ? home.data.tier : null;
  return (
    <div className="shrink-0 border-b border-border bg-primary/5 px-4 py-2.5" data-testid="band-portal-tier">
      <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Client portal</p>
      <p className="mt-0.5 truncate text-sm font-medium">{home.data.client.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{tier ? `${tierMeta(tier).name} service level` : "No active engagement"}</p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { setActiveClient, period, setPeriod, theme, setTheme, plane, setPlane } = useApp();
  const { clients, client, clientId, hasClients } = useActiveClient();
  const periods = useMemo(() => periodsFor(client), [client]);
  // The period follows the client: its open period, or the current month when
  // none is open yet. A person can still pick another month from the list.
  const lastClientId = useRef<string | null>(null);
  useEffect(() => {
    if (clientId !== lastClientId.current) {
      lastClientId.current = clientId;
      setPeriod(defaultPeriodFor(client));
    }
  }, [clientId, client, setPeriod]);
  const [mobileNav, setMobileNav] = useState(false);
  const [routePath] = useLocation();
  // Three screens live under /portal and are firm side work all the same: the
  // client setup wizard, the mapping profile list, and the client setup record
  // the wizard lands on. A bookkeeper opens a client file, the client never
  // sees any of it, so the firm chrome has to stay up on those paths.
  const FIRM_SIDE_PORTAL_PATHS = ["/portal/intake", "/portal/mapping-profiles", "/portal/clients"];
  const firmSide = FIRM_SIDE_PORTAL_PATHS.some((p) => routePath.startsWith(p));
  const routePlane = routePath.startsWith("/portal") && !firmSide ? "portal" : "firm";
  useEffect(() => {
    if (plane !== routePlane) setPlane(routePlane);
  }, [routePlane, plane, setPlane]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden w-[238px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
          <Logo />
        </div>
        {plane === "portal" ? <PortalTierBand /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
          <NavList />
        </div>
      </aside>

      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        {/* Column layout, not a single scrolling box. Scrolling the whole drawer pushed the data source control to roughly 960px, off the bottom of a 812px viewport. Only the nav scrolls now, so the control stays pinned and visible. */}
        <SheetContent side="left" className="flex w-[264px] flex-col p-0">
          <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
            <Logo />
          </div>
          {plane === "portal" ? <PortalTierBand /> : null}
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
            <NavList onNavigate={() => setMobileNav(false)} />
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
            <Select value={clientId ?? ""} onValueChange={setActiveClient} disabled={!hasClients}>
              <SelectTrigger className="h-8 w-[150px] text-xs sm:w-[210px]" data-testid="select-client">
                <SelectValue placeholder="No clients yet" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="hidden h-8 w-[120px] text-xs sm:flex" data-testid="select-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
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
            <UserMenu />
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 sm:hidden">
          <PlaneSwitcher />
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-8 flex-1 text-xs" data-testid="select-period-mobile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods.map((p) => (
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
            {plane === "firm" ? "Firm workspace" : "Client portal preview"} for {client?.name || "no client yet"}, period{" "}
            {fmtPeriod(period)}
          </span>
        </div>

        <main
          className={cn("min-h-0 flex-1 overflow-y-auto", plane === "portal" ? "bg-muted/40" : "")}
          style={{ overscrollBehavior: "contain" }}
          data-testid="main-scroll"
        >
          <div className="mx-auto w-full max-w-[1400px] space-y-5 p-3 pb-16 sm:p-5">{children}</div>
        </main>
      </div>
    </div>
  );
}
