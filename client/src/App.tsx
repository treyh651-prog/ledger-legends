import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppProvider } from "@/store";
import { AppShell } from "@/components/shell";

import FirmOverview from "@/pages/firm-overview";
import ClientBook from "@/pages/client-book";
import Intake from "@/pages/intake";
import Transactions from "@/pages/transactions";
import Rules from "@/pages/rules";
import Reconcile from "@/pages/reconcile";
import Aging from "@/pages/aging";
import Journal from "@/pages/journal";
import Substantiation from "@/pages/substantiation";
import Statements from "@/pages/statements";
import CloseChecklist from "@/pages/close-checklist";
import Board from "@/pages/board";
import Team from "@/pages/team";
import Comms from "@/pages/comms";
import OpenItems from "@/pages/open-items";
import ReportPackage from "@/pages/report-package";
import Budget from "@/pages/budget";
import Forecast from "@/pages/forecast";
import Narrative from "@/pages/narrative";
import TaxForms from "@/pages/tax-forms";
import PortalHome from "@/pages/portal-home";
import PortalUpload from "@/pages/portal-upload";
import PortalDocuments from "@/pages/portal-documents";
import PortalRequests from "@/pages/portal-requests";
import PortalSign from "@/pages/portal-sign";
import PortalReports from "@/pages/portal-reports";
import PortalMessages from "@/pages/portal-messages";
import PortalStatements from "@/pages/portal-statements";
import PortalTransactions from "@/pages/portal-transactions";
import PortalCompare from "@/pages/portal-compare";
import PortalBudget from "@/pages/portal-budget";
import PortalAging from "@/pages/portal-aging";
import PortalOpenPeriod from "@/pages/portal-open-period";
import PortalForecast from "@/pages/portal-forecast";
import PortalNarrative from "@/pages/portal-narrative";
import PortalScenarios from "@/pages/portal-scenarios";
import PortalEntities from "@/pages/portal-entities";
import PortalTiers from "@/pages/portal-tiers";
import PortalIntake from "@/pages/portal-intake";
import PortalMappingProfiles from "@/pages/portal-mapping-profiles";
import PortalClientDetail from "@/pages/portal-client-detail";
import { ALWAYS_RENDER, EmptyWorkspace } from "@/components/empty-workspace";
import { useApp } from "@/store";

/**
 * One guard for every route. When the workspace has no clients, the screen renders its
 * own empty state instead of the page body. Doing it here means no page has to compute a
 * ratio against zero, which is the honest fix rather than sprinkling fallbacks.
 */
function Guard({ path, page: Page }: { path: string; page: () => JSX.Element }) {
  const { hasClients } = useApp();
  if (!hasClients && !ALWAYS_RENDER.includes(path)) return <EmptyWorkspace path={path} />;
  return <Page />;
}

function guarded(path: string, page: () => JSX.Element) {
  return () => <Guard path={path} page={page} />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/">{guarded("/", FirmOverview)}</Route>
      <Route path="/clients">{guarded("/clients", ClientBook)}</Route>
      <Route path="/intake">{guarded("/intake", Intake)}</Route>
      <Route path="/transactions">{guarded("/transactions", Transactions)}</Route>
      <Route path="/rules">{guarded("/rules", Rules)}</Route>
      <Route path="/reconcile">{guarded("/reconcile", Reconcile)}</Route>
      <Route path="/aging">{guarded("/aging", Aging)}</Route>
      <Route path="/journal">{guarded("/journal", Journal)}</Route>
      <Route path="/substantiation">{guarded("/substantiation", Substantiation)}</Route>
      <Route path="/statements">{guarded("/statements", Statements)}</Route>
      <Route path="/close">{guarded("/close", CloseChecklist)}</Route>
      <Route path="/board">{guarded("/board", Board)}</Route>
      <Route path="/team">{guarded("/team", Team)}</Route>
      <Route path="/comms">{guarded("/comms", Comms)}</Route>
      <Route path="/requests">{guarded("/requests", OpenItems)}</Route>
      <Route path="/package">{guarded("/package", ReportPackage)}</Route>
      <Route path="/budget">{guarded("/budget", Budget)}</Route>
      <Route path="/forecast">{guarded("/forecast", Forecast)}</Route>
      <Route path="/narrative">{guarded("/narrative", Narrative)}</Route>
      <Route path="/tax-forms">{guarded("/tax-forms", TaxForms)}</Route>
      <Route path="/portal">{guarded("/portal", PortalHome)}</Route>
      <Route path="/portal/upload">{guarded("/portal/upload", PortalUpload)}</Route>
      <Route path="/portal/documents">{guarded("/portal/documents", PortalDocuments)}</Route>
      <Route path="/portal/requests">{guarded("/portal/requests", PortalRequests)}</Route>
      <Route path="/portal/sign">{guarded("/portal/sign", PortalSign)}</Route>
      <Route path="/portal/reports">{guarded("/portal/reports", PortalReports)}</Route>
      <Route path="/portal/messages">{guarded("/portal/messages", PortalMessages)}</Route>
      <Route path="/portal/statements">{guarded("/portal/statements", PortalStatements)}</Route>
      <Route path="/portal/transactions">{guarded("/portal/transactions", PortalTransactions)}</Route>
      <Route path="/portal/compare">{guarded("/portal/compare", PortalCompare)}</Route>
      <Route path="/portal/budget">{guarded("/portal/budget", PortalBudget)}</Route>
      <Route path="/portal/aging">{guarded("/portal/aging", PortalAging)}</Route>
      <Route path="/portal/open-period">{guarded("/portal/open-period", PortalOpenPeriod)}</Route>
      <Route path="/portal/forecast">{guarded("/portal/forecast", PortalForecast)}</Route>
      <Route path="/portal/narrative">{guarded("/portal/narrative", PortalNarrative)}</Route>
      <Route path="/portal/scenarios">{guarded("/portal/scenarios", PortalScenarios)}</Route>
      <Route path="/portal/entities">{guarded("/portal/entities", PortalEntities)}</Route>
      <Route path="/portal/tiers">{guarded("/portal/tiers", PortalTiers)}</Route>
      {/* Module 1 intake. Firm side screens, so they sit in the practice nav. */}
      <Route path="/portal/intake">{guarded("/portal/intake", PortalIntake)}</Route>
      <Route path="/portal/mapping-profiles">{guarded("/portal/mapping-profiles", PortalMappingProfiles)}</Route>
      <Route path="/portal/clients/:id">{guarded("/portal/clients", PortalClientDetail)}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppShell>
              <AppRouter />
            </AppShell>
          </Router>
        </AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
