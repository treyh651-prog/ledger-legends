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

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={FirmOverview} />
      <Route path="/clients" component={ClientBook} />
      <Route path="/intake" component={Intake} />
      <Route path="/transactions" component={Transactions} />
      <Route path="/rules" component={Rules} />
      <Route path="/reconcile" component={Reconcile} />
      <Route path="/aging" component={Aging} />
      <Route path="/journal" component={Journal} />
      <Route path="/substantiation" component={Substantiation} />
      <Route path="/statements" component={Statements} />
      <Route path="/close" component={CloseChecklist} />
      <Route path="/board" component={Board} />
      <Route path="/team" component={Team} />
      <Route path="/comms" component={Comms} />
      <Route path="/requests" component={OpenItems} />
      <Route path="/package" component={ReportPackage} />
      <Route path="/budget" component={Budget} />
      <Route path="/forecast" component={Forecast} />
      <Route path="/narrative" component={Narrative} />
      <Route path="/tax-forms" component={TaxForms} />
      <Route path="/portal" component={PortalHome} />
      <Route path="/portal/upload" component={PortalUpload} />
      <Route path="/portal/documents" component={PortalDocuments} />
      <Route path="/portal/requests" component={PortalRequests} />
      <Route path="/portal/sign" component={PortalSign} />
      <Route path="/portal/reports" component={PortalReports} />
      <Route path="/portal/messages" component={PortalMessages} />
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
