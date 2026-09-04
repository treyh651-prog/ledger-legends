import { Link } from "wouter";
import { ArrowRight, Building2, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard } from "@/components/kit";
import { PortalHero } from "@/components/portal/portal-kit";

/**
 * Empty mode copy, one entry per route. A cold workspace is a starting point, not a
 * failure, so every screen says what it is for and what the first move is. Nothing here
 * renders a chart, a table header, or a computed ratio, which is how the zero
 * denominator problem is avoided instead of patched.
 */

export interface EmptyCopy {
  title: string;
  purpose: string;
  first: string;
  cta?: { label: string; href: string };
}

const ADD_CLIENT = { label: "Start client intake", href: "/intake" };

export const FIRM_EMPTY: Record<string, EmptyCopy> = {
  "/": {
    title: "Your practice starts here",
    purpose: "This dashboard tracks close progress, cash positions, and what each client owes you across the whole book.",
    first: "Add your first client. Intake collects the entity details, the bank accounts, the systems, and the scope, then it writes the close checklist for you.",
    cta: ADD_CLIENT,
  },
  "/clients": {
    title: "No clients in the book yet",
    purpose: "The client book holds every engagement, the service level, the scope of work, and who leads it.",
    first: "Run intake once and the client appears here with its scope and fee already recorded.",
    cta: ADD_CLIENT,
  },
  "/transactions": {
    title: "No transactions to categorize",
    purpose: "This is the working queue. Bank activity lands here, rules suggest a category, and you confirm or recode in bulk.",
    first: "Add a client and connect a bank account. Activity flows into this queue as it posts.",
    cta: ADD_CLIENT,
  },
  "/rules": {
    title: "No categorization rules yet",
    purpose: "Rules turn a vendor pattern into a category so the same transaction never gets coded twice by hand.",
    first: "Categorize a few transactions first. You can promote any one of them into a rule from the queue.",
    cta: ADD_CLIENT,
  },
  "/reconcile": {
    title: "Nothing to reconcile",
    purpose: "Reconciliation matches the bank statement against the ledger, line by line, until the difference is zero.",
    first: "Add a client with a bank account, then upload or import a statement for the month you are closing.",
    cta: ADD_CLIENT,
  },
  "/aging": {
    title: "No receivables or payables",
    purpose: "Aging shows who owes the client money, who the client owes, and how late each one is.",
    first: "Add a client. Invoices and bills show up here as soon as they post.",
    cta: ADD_CLIENT,
  },
  "/journal": {
    title: "No journal entries posted",
    purpose: "The journal is the full record. Every entry here is balanced in whole cents and can be reversed but never edited away.",
    first: "Add a client and post the opening trial balance. That first entry starts the audit trail.",
    cta: ADD_CLIENT,
  },
  "/substantiation": {
    title: "No balances to substantiate",
    purpose: "Substantiation ties each balance sheet account to the document that supports it, so a reviewer can follow the number to its source.",
    first: "Add a client and close one month. Every account carried at a balance shows up here waiting for support.",
    cta: ADD_CLIENT,
  },
  "/statements": {
    title: "No statements to render",
    purpose: "Profit and loss, balance sheet, and cash flow, built straight from posted entries with no spreadsheet in between.",
    first: "Add a client and post activity. Statements appear for any period that has entries.",
    cta: ADD_CLIENT,
  },
  "/close": {
    title: "No close in progress",
    purpose: "The close checklist is the gate. Each task names an owner and a due date, and the period does not lock until the list is clear.",
    first: "Add a client. Intake writes the checklist from the scope you agreed to.",
    cta: ADD_CLIENT,
  },
  "/board": {
    title: "No work on the board",
    purpose: "The board is every open task across the practice, grouped by stage, so nothing sits without an owner.",
    first: "Add a client and the close tasks land here automatically.",
    cta: ADD_CLIENT,
  },
  "/team": {
    title: "No team members loaded",
    purpose: "Team tracks who is assigned to which client, how many hours are committed, and where the load is uneven.",
    first: "Add a client and assign a lead. Capacity math needs at least one person and one engagement.",
    cta: ADD_CLIENT,
  },
  "/comms": {
    title: "No client messages",
    purpose: "Every message in and out lives here, tied to the client and to the item it is about.",
    first: "Add a client and send the first note. Threads stay attached to the request they came from.",
    cta: ADD_CLIENT,
  },
  "/requests": {
    title: "No open requests",
    purpose: "Requests are the short list of what you are waiting on from clients, with a due date on each one.",
    first: "Add a client, then raise a request for the first document you need.",
    cta: ADD_CLIENT,
  },
  "/package": {
    title: "No report package to build",
    purpose: "The package assembles the statements, the narrative, and the support into one thing you can hand to a client or a lender.",
    first: "Add a client and close a period. A package needs a closed month behind it.",
    cta: ADD_CLIENT,
  },
  "/budget": {
    title: "No budget loaded",
    purpose: "Budget versus actual compares the plan to what posted, by account, for the period you are reviewing.",
    first: "Add a client and load a plan. Without a plan there is no variance to read.",
    cta: ADD_CLIENT,
  },
  "/forecast": {
    title: "No cash to forecast",
    purpose: "The thirteen week forecast projects cash in and cash out from open invoices, open bills, and the recent run rate.",
    first: "Add a client with cash activity. A forecast built on no history would be a guess.",
    cta: ADD_CLIENT,
  },
  "/narrative": {
    title: "No period to write about",
    purpose: "The narrative is the written read on a closed month, in plain language, with the numbers behind each point.",
    first: "Add a client and close a month. The narrative is generated from that close.",
    cta: ADD_CLIENT,
  },
  "/tax-forms": {
    title: "No vendors to report",
    purpose: "This screen tracks 1099 reportable vendors, W9 status, and year to date payments against the filing threshold.",
    first: "Add a client and post vendor payments. Reportable vendors surface once payments cross the threshold.",
    cta: ADD_CLIENT,
  },
};

export const PORTAL_EMPTY: Record<string, EmptyCopy> = {
  "/portal": {
    title: "Your portal is ready, your books are not started",
    purpose: "This is where your statements, your documents, and the short list of what we need from you will live.",
    first: "Your accountant sets up the engagement first. Once your books are open, this page fills in with your own numbers.",
  },
  "/portal/statements": {
    title: "No statements yet",
    purpose: "Your profit and loss, balance sheet, and cash flow for every closed month, in one place.",
    first: "Statements appear the first time a month is closed on your books.",
  },
  "/portal/transactions": {
    title: "No transactions yet",
    purpose: "Every transaction on your accounts with the category we used, so you can see exactly how a number was built.",
    first: "This fills in as your bank activity posts. Your own records are never held back from you.",
  },
  "/portal/upload": {
    title: "Nothing uploaded yet",
    purpose: "Send us receipts, statements, and anything else we asked for. Files stay here with a full history.",
    first: "You can upload before your books are open. Anything you send now is waiting for us when setup finishes.",
  },
  "/portal/documents": {
    title: "No documents on file",
    purpose: "Every file you sent and every file we prepared, with who touched it and when.",
    first: "Upload your first document and it lands here immediately.",
    cta: { label: "Go to upload", href: "/portal/upload" },
  },
  "/portal/requests": {
    title: "Nothing is waiting on you",
    purpose: "When we need a document or an answer, it shows up here with a date so nothing gets lost in email.",
    first: "There are no open requests. That is a good place to be.",
  },
  "/portal/sign": {
    title: "Nothing to sign",
    purpose: "Engagement letters and approvals come through here, and the signed copy stays in your documents.",
    first: "We will let you know when something needs your name on it.",
  },
  "/portal/reports": {
    title: "No report package yet",
    purpose: "A finished package pulls your statements and the write up into one document you can hand to a lender.",
    first: "Packages are built after a month closes.",
  },
  "/portal/messages": {
    title: "No messages yet",
    purpose: "Talk to the people doing your books here, in one thread, instead of scattered email.",
    first: "Send the first message any time. You do not need to wait for setup to finish.",
  },
  "/portal/compare": {
    title: "No months to compare",
    purpose: "This month against last month, line by line, with the accounts that moved called out.",
    first: "A comparison needs two closed months. It turns on as soon as the second one closes.",
  },
  "/portal/budget": {
    title: "No plan on file",
    purpose: "Where your spending landed against the plan, by account.",
    first: "Send us a budget and this screen starts tracking against it.",
  },
  "/portal/aging": {
    title: "Nothing outstanding",
    purpose: "Who owes you, who you owe, and how late each one is.",
    first: "This fills in as invoices and bills post to your books.",
  },
  "/portal/open-period": {
    title: "No month in progress",
    purpose: "The current month before it closes, marked as draft, so you are not waiting on the close to see where you stand.",
    first: "Draft numbers appear once activity starts posting in an open month.",
  },
  "/portal/forecast": {
    title: "No cash history to project",
    purpose: "Cash in and cash out by week for the next thirteen weeks, built from your open invoices, your open bills, and your run rate.",
    first: "A forecast needs posted cash activity behind it. We do not project from nothing.",
  },
  "/portal/narrative": {
    title: "No month written up yet",
    purpose: "A short written read on the month from the person who closed it.",
    first: "The narrative is written after a close.",
  },
  "/portal/scenarios": {
    title: "No base case to compare",
    purpose: "The same forecast under slower collections or higher spend, side by side, with the assumption written on each one.",
    first: "Scenarios start from your real forecast, so this turns on when there is cash activity to project.",
  },
  "/portal/entities": {
    title: "No entities on file",
    purpose: "If you run more than one company, this combines them into one set of statements.",
    first: "Tell us about each entity you own and we will set the group up.",
  },
};

// Screens that stand up with no clients, because they are how a client gets
// created in the first place, or because they carry no client rows at all.
export const ALWAYS_RENDER = ["/intake", "/portal/tiers", "/portal/intake", "/portal/mapping-profiles"];

export function emptyCopyFor(path: string): EmptyCopy | null {
  return FIRM_EMPTY[path] || PORTAL_EMPTY[path] || null;
}

/** Rendered in place of a screen when the workspace has no clients. */
export function EmptyWorkspace({ path }: { path: string }) {
  const copy = emptyCopyFor(path);
  const isPortal = path.startsWith("/portal");
  const fallback: EmptyCopy = {
    title: "Nothing here yet",
    purpose: "This screen reads from client records, and this workspace has none.",
    first: "Add a client to start.",
    cta: ADD_CLIENT,
  };
  const c = copy || fallback;

  if (isPortal) {
    return (
      <>
        <PortalHero
          title={c.title}
          subtitle={c.purpose}
          meta={<span className="text-xs text-muted-foreground">Empty workspace</span>}
          testId="hero-portal-empty"
        />
        <SectionCard title="What happens next" testId="card-portal-empty-next">
          <div className="space-y-3 p-4">
            <p className="text-sm leading-relaxed">{c.first}</p>
            {c.cta ? (
              <Button asChild size="sm" variant="outline" data-testid="button-empty-cta">
                <Link href={c.cta.href}>
                  {c.cta.label}
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null}
          </div>
        </SectionCard>
      </>
    );
  }

  return (
    <>
      <PageHeader title={c.title} subtitle={c.purpose} testId="header-empty-workspace" />
      <SectionCard testId="card-empty-workspace">
        <div className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center">
          <div className="rounded-md border border-border bg-muted p-2 text-muted-foreground">
            {path === "/" ? <Building2 className="h-5 w-5" /> : <Inbox className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">First step</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.first}</p>
          </div>
          {c.cta ? (
            <Button asChild size="sm" data-testid="button-empty-cta">
              <Link href={c.cta.href}>
                {c.cta.label}
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : null}
        </div>
      </SectionCard>
    </>
  );
}
