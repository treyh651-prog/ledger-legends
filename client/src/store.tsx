import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CURRENT_PERIOD, datasetForMode, tasksForScope, TODAY } from "./data/seed";
import type { DataMode, Dataset } from "./data/seed";
import { SUSPENSE_ACCOUNT_ID } from "./data/coa";
import type {
  AuditAction,
  Client,
  DocRecord,
  DocStatus,
  JELine,
  JournalEntry,
  OpenItemStatus,
  Rule,
  ScopeKey,
  TaskStatus,
  Txn,
} from "./data/types";

export type Plane = "firm" | "portal";

export interface IntakeOwnerDraft {
  id: string;
  name: string;
  ownershipPct: string;
  role: string;
}

export interface IntakeAccountDraft {
  id: string;
  institution: string;
  nickname: string;
  last4: string;
  kind: string;
  currency: string;
  statementSource: string;
  needsReconciling: boolean;
}

export interface IntakeSystemDraft {
  id: string;
  kind: string;
  vendor: string;
  accessStatus: string;
}

export interface IntakePersonDraft {
  id: string;
  name: string;
  email: string;
  role: string;
  canApprovePayments: boolean;
  canApproveJournalEntries: boolean;
  mfaRequired: boolean;
}

export interface IntakeDraft {
  legalName: string;
  dba: string;
  entityType: string;
  ein: string;
  fiscalYearEnd: string;
  address: string;
  industry: string;
  primaryContactName: string;
  primaryContactEmail: string;
  owners: IntakeOwnerDraft[];
  scope: ScopeKey[];
  systems: IntakeSystemDraft[];
  accounts: IntakeAccountDraft[];
  priorFinancials: string;
  priorTrialBalance: string;
  existingCoa: string;
  cleanupItems: string[];
  outstandingRecs: string[];
  monthlyFee: string;
  cleanupFee: string;
  startDate: string;
  people: IntakePersonDraft[];
  signerName: string;
  signatureMode: "typed" | "drawn";
  signedAt?: string;
  credentialWarningShown: boolean;
}

export function emptyIntake(): IntakeDraft {
  return {
    legalName: "",
    dba: "",
    entityType: "LLC",
    ein: "",
    fiscalYearEnd: "December 31",
    address: "",
    industry: "",
    primaryContactName: "",
    primaryContactEmail: "",
    owners: [{ id: "od-1", name: "", ownershipPct: "100", role: "Owner" }],
    scope: [],
    systems: [
      { id: "sd-1", kind: "Accounting software", vendor: "", accessStatus: "No access" },
      { id: "sd-2", kind: "Payroll", vendor: "", accessStatus: "No access" },
    ],
    accounts: [
      { id: "ad-1", institution: "", nickname: "", last4: "", kind: "Checking", currency: "USD", statementSource: "Bank feed", needsReconciling: true },
    ],
    priorFinancials: "",
    priorTrialBalance: "",
    existingCoa: "",
    cleanupItems: [],
    outstandingRecs: [],
    monthlyFee: "",
    cleanupFee: "",
    startDate: "2026-09-01",
    people: [
      { id: "pd-1", name: "", email: "", role: "Owner", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
    ],
    signerName: "",
    signatureMode: "typed",
    credentialWarningShown: false,
  };
}

export type LoadMode = "normal" | "slow" | "error";

/**
 * Data mode is read from the URL query, for example ?data=test. It is held in React
 * state only. No storage of any kind, because the preview frame blocks it.
 */
export function readDataMode(): DataMode {
  if (typeof window === "undefined") return "demo";
  const raw = new URLSearchParams(window.location.search).get("data");
  if (raw === "empty" || raw === "test" || raw === "demo") return raw;
  return "demo";
}

function writeDataModeToUrl(mode: DataMode) {
  if (typeof window === "undefined" || !window.history) return;
  const url = new URL(window.location.href);
  if (mode === "demo") url.searchParams.delete("data");
  else url.searchParams.set("data", mode);
  window.history.replaceState(null, "", url.toString());
}

/**
 * Stand in used only when a workspace has no clients. Pages guard on hasClients before
 * they read any of this, so these values are never rendered as if they were real.
 */
const NO_CLIENT: Client = {
  id: "",
  legalName: "No client selected",
  dba: "No client selected",
  shortName: "No client",
  industry: "",
  entityType: "LLC",
  ein: "",
  fiscalYearEnd: "December 31",
  address: "",
  owners: [],
  contacts: [],
  systems: [],
  scope: [],
  classes: [],
  locations: [],
  jobs: [],
  currencies: ["USD"],
  priorRecords: { lastFinancials: "", priorTrialBalance: "", existingCoa: "", cleanupItems: [], outstandingRecs: [] },
  engagement: { monthlyFeeCents: 0, cleanupFeeCents: 0, startDate: TODAY, signedBy: "", signedAt: "", signatureMode: "typed" },
  onboardingStage: "Intake",
  lead: "",
  color: "hsl(215 16% 47%)",
};

interface AppState {
  ds: Dataset;
  plane: Plane;
  activeClientId: string;
  period: string;
  comparePeriod: string | null;
  loading: boolean;
  loadError: string | null;
  loadMode: LoadMode;
  dataMode: DataMode;
  hasClients: boolean;
  theme: "light" | "dark";
  intake: IntakeDraft;
  intakeStep: number;
}

interface AppApi extends AppState {
  setPlane: (p: Plane) => void;
  setActiveClient: (id: string) => void;
  setPeriod: (p: string) => void;
  setComparePeriod: (p: string | null) => void;
  setTheme: (t: "light" | "dark") => void;
  setLoadMode: (m: LoadMode) => void;
  setDataMode: (m: DataMode) => void;
  reload: () => void;
  activeClient: Client;
  // accounting actions
  categorize: (txnIds: string[], accountId: string, opts?: { klass?: string; location?: string; job?: string }) => void;
  acceptSuggestion: (txnId: string) => void;
  rejectSuggestion: (txnId: string) => void;
  excludeTxns: (txnIds: string[]) => void;
  createRuleFromTxn: (txnId: string, name: string, accountId: string) => Rule;
  toggleRule: (ruleId: string) => void;
  matchLine: (lineId: string, txnId: string) => void;
  unmatchLine: (lineId: string) => void;
  toggleCleared: (txnId: string) => void;
  postEntry: (input: { date: string; memo: string; lines: JELine[] }) => JournalEntry;
  reverseEntry: (entryId: string) => void;
  // portal actions
  addDocuments: (files: { name: string; sizeBytes: number; docType: string; period: string; bankAccountId?: string; openItemId?: string }[], actor: string, plane: Plane) => string[];
  updateDocument: (docId: string, patch: Partial<DocRecord>, action: AuditAction, detail: string, actor: string, plane: Plane) => void;
  logAudit: (docId: string | undefined, docName: string, action: AuditAction, detail: string, actor: string, plane: Plane) => void;
  setOpenItemStatus: (itemId: string, status: OpenItemStatus, reason?: string) => void;
  signDocument: (title: string, signerName: string, mode: "typed" | "drawn", role: string) => void;
  // practice actions
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  reassignTask: (taskId: string, assignee: string) => void;
  addMessage: (clientId: string, who: string, subject: string, body: string, direction: "Inbound" | "Outbound", linkedItemId?: string) => void;
  // intake actions
  setIntake: (patch: Partial<IntakeDraft>) => void;
  setIntakeStep: (n: number) => void;
  resetIntake: () => void;
  createClientFromIntake: () => string | null;
  intakeCompleteness: () => { pct: number; sections: { label: string; done: boolean }[] };
  intakeTaskPreview: () => { title: string; scopeSource: string; estHours: number }[];
}

const Ctx = createContext<AppApi | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [dataMode, setDataModeState] = useState<DataMode>(() => readDataMode());
  const [ds, setDs] = useState<Dataset>(() => datasetForMode(readDataMode()));
  const [plane, setPlane] = useState<Plane>("firm");
  const [activeClientId, setActiveClientId] = useState(() => datasetForMode(readDataMode()).clients[0]?.id || "");
  const [period, setPeriod] = useState(CURRENT_PERIOD);
  const [comparePeriod, setComparePeriod] = useState<string | null>("2026-06");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMode, setLoadMode] = useState<LoadMode>("normal");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [intake, setIntakeState] = useState<IntakeDraft>(emptyIntake);
  const [intakeStep, setIntakeStep] = useState(0);
  const seq = useRef(1000);
  const nextId = (prefix: string) => {
    seq.current += 1;
    return `${prefix}-${seq.current}`;
  };

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const runLoad = useCallback(
    (mode: LoadMode) => {
      setLoading(true);
      setLoadError(null);
      const delay = mode === "slow" ? 2200 : 420;
      const t = setTimeout(() => {
        if (mode === "error") {
          setLoadError("The mock data layer returned a 503 while fetching the workspace. Nothing was lost.");
          setLoading(false);
        } else {
          setLoading(false);
        }
      }, delay);
      return () => clearTimeout(t);
    },
    [],
  );

  useEffect(() => runLoad(loadMode), [loadMode, runLoad]);

  const setDataMode = useCallback((mode: DataMode) => {
    const next = datasetForMode(mode);
    setDataModeState(mode);
    setDs(next);
    setActiveClientId(next.clients[0]?.id || "");
    setPeriod(CURRENT_PERIOD);
    setComparePeriod("2026-06");
    writeDataModeToUrl(mode);
    runLoad("normal");
  }, [runLoad]);

  const mutate = useCallback((fn: (draft: Dataset) => void) => {
    setDs((prev) => {
      const next: Dataset = {
        ...prev,
        clients: [...prev.clients],
        bankAccounts: [...prev.bankAccounts],
        journalEntries: prev.journalEntries.map((j) => ({ ...j, lines: j.lines.map((l) => ({ ...l })) })),
        txns: prev.txns.map((t) => ({ ...t })),
        rules: prev.rules.map((r) => ({ ...r })),
        statementLines: prev.statementLines.map((l) => ({ ...l })),
        invoices: prev.invoices.map((i) => ({ ...i })),
        bills: prev.bills.map((b) => ({ ...b })),
        vendors: prev.vendors.map((v) => ({ ...v })),
        substantiations: prev.substantiations.map((s) => ({ ...s })),
        openItems: prev.openItems.map((o) => ({ ...o, documentIds: [...o.documentIds] })),
        documents: prev.documents.map((d) => ({ ...d })),
        audit: [...prev.audit],
        tasks: prev.tasks.map((t) => ({ ...t })),
        team: prev.team,
        comms: [...prev.comms],
        budgets: prev.budgets,
        signatures: [...prev.signatures],
        entitlements: [...prev.entitlements],
        closes: [...prev.closes],
        entityGroups: [...prev.entityGroups],
      };
      fn(next);
      return next;
    });
  }, []);

  /** Recode the ledger line that carries a bank transaction so the books stay balanced. */
  function recodeTxn(next: Dataset, txn: Txn, accountId: string, tags?: { klass?: string; location?: string; job?: string }) {
    const je = next.journalEntries.find((j) => j.id === txn.jeId);
    txn.categoryAccountId = accountId;
    if (tags?.klass) txn.klass = tags.klass;
    if (tags?.location) txn.location = tags.location;
    if (tags?.job) txn.job = tags.job;
    if (accountId === SUSPENSE_ACCOUNT_ID) {
      // Moving something back into 1990 keeps it unresolved, so it keeps a reason code
      // and the close gate keeps seeing it.
      txn.status = "needs_review";
      txn.confidence = 0;
      txn.suspenseReason = txn.suspenseReason || "SUS-03";
      txn.suspenseOpenedOn = txn.suspenseOpenedOn || txn.date;
    } else {
      txn.status = "categorized";
      txn.confidence = 100;
      // Out of suspense means the reason code no longer applies.
      txn.suspenseReason = undefined;
      txn.suspenseOpenedOn = undefined;
    }
    if (!je || je.lines.length !== 2) return;
    const bankLine = je.lines.find((l) => l.accountId === txn.glAccountId);
    const other = je.lines.find((l) => l !== bankLine);
    if (!other) return;
    other.accountId = accountId;
    if (tags?.klass) other.klass = tags.klass;
    if (tags?.location) other.location = tags.location;
    if (tags?.job) other.job = tags.job;
  }

  const api: AppApi = useMemo(() => {
    const activeClient = ds.clients.find((c) => c.id === activeClientId) || ds.clients[0] || NO_CLIENT;
    return {
      ds,
      plane,
      activeClientId,
      period,
      comparePeriod,
      loading,
      loadError,
      loadMode,
      dataMode,
      hasClients: ds.clients.length > 0,
      theme,
      intake,
      intakeStep,
      activeClient,
      setPlane,
      setActiveClient: setActiveClientId,
      setPeriod,
      setComparePeriod,
      setTheme,
      setLoadMode,
      setDataMode,
      reload: () => runLoad(loadMode),

      categorize: (txnIds, accountId, opts) =>
        mutate((next) => {
          for (const id of txnIds) {
            const t = next.txns.find((x) => x.id === id);
            if (t) recodeTxn(next, t, accountId, opts);
          }
        }),

      acceptSuggestion: (txnId) =>
        mutate((next) => {
          const t = next.txns.find((x) => x.id === txnId);
          if (t && t.suggestedAccountId) recodeTxn(next, t, t.suggestedAccountId);
        }),

      rejectSuggestion: (txnId) =>
        mutate((next) => {
          const t = next.txns.find((x) => x.id === txnId);
          if (t) {
            t.suggestedAccountId = undefined;
            t.suggestionReason = "Suggestion rejected, waiting on a manual category";
            t.confidence = 0;
          }
        }),

      excludeTxns: (txnIds) =>
        mutate((next) => {
          for (const id of txnIds) {
            const t = next.txns.find((x) => x.id === id);
            if (t) t.status = "excluded";
          }
        }),

      createRuleFromTxn: (txnId, name, accountId) => {
        const t = ds.txns.find((x) => x.id === txnId)!;
        const rule: Rule = {
          id: nextId("rule"),
          clientId: t.clientId,
          name,
          matchType: "Description contains",
          matchValue: t.description.split(" ").slice(0, 2).join(" "),
          accountId,
          klass: t.klass,
          hits: 1,
          createdBy: "Trey Hernandez",
          createdAt: TODAY,
          active: true,
        };
        mutate((next) => {
          next.rules = [rule, ...next.rules];
          const target = next.txns.find((x) => x.id === txnId);
          if (target) {
            recodeTxn(next, target, accountId);
            target.ruleId = rule.id;
          }
        });
        return rule;
      },

      toggleRule: (ruleId) =>
        mutate((next) => {
          const r = next.rules.find((x) => x.id === ruleId);
          if (r) r.active = !r.active;
        }),

      matchLine: (lineId, txnId) =>
        mutate((next) => {
          const l = next.statementLines.find((x) => x.id === lineId);
          if (l) l.matchedTxnId = txnId;
          const t = next.txns.find((x) => x.id === txnId);
          if (t) t.cleared = true;
        }),

      unmatchLine: (lineId) =>
        mutate((next) => {
          const l = next.statementLines.find((x) => x.id === lineId);
          if (l) l.matchedTxnId = undefined;
        }),

      toggleCleared: (txnId) =>
        mutate((next) => {
          const t = next.txns.find((x) => x.id === txnId);
          if (t) t.cleared = !t.cleared;
        }),

      postEntry: ({ date, memo, lines }) => {
        const entry: JournalEntry = {
          id: nextId("je"),
          ref: `JE-${date.slice(0, 7).replace("-", "")}-M${String(seq.current).slice(-3)}`,
          clientId: activeClientId,
          date,
          period: date.slice(0, 7),
          memo,
          source: "manual",
          lines,
          posted: true,
          createdBy: "Trey Hernandez",
        };
        mutate((next) => {
          next.journalEntries = [...next.journalEntries, entry];
        });
        return entry;
      },

      reverseEntry: (entryId) =>
        mutate((next) => {
          const original = next.journalEntries.find((j) => j.id === entryId);
          if (!original || original.reversedBy) return;
          const rev: JournalEntry = {
            id: nextId("je"),
            ref: original.ref + "-R",
            clientId: original.clientId,
            date: TODAY,
            period: TODAY.slice(0, 7),
            memo: `Reversal of ${original.ref}, ${original.memo}`,
            source: "reversal",
            lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
            posted: true,
            createdBy: "Trey Hernandez",
            reversalOf: original.id,
          };
          original.reversedBy = rev.id;
          next.journalEntries = [...next.journalEntries, rev];
        }),

      addDocuments: (files, actor, planeArg) => {
        const ids: string[] = [];
        mutate((next) => {
          for (const f of files) {
            const id = nextId("doc");
            ids.push(id);
            const duplicate = next.documents.some(
              (d) => d.clientId === activeClientId && d.name === f.name && d.sizeBytes === f.sizeBytes,
            );
            const doc: DocRecord = {
              id,
              clientId: activeClientId,
              name: f.name,
              sizeBytes: f.sizeBytes,
              mime: f.name.split(".").pop() || "bin",
              docType: f.docType,
              period: f.period,
              bankAccountId: f.bankAccountId,
              status: (duplicate ? "duplicate" : "uploaded") as DocStatus,
              progress: 100,
              uploadedBy: actor,
              uploadedAt: new Date().toISOString().slice(0, 19),
              openItemId: f.openItemId,
              note: duplicate ? "Same file name and size as an existing upload." : undefined,
            };
            next.documents = [doc, ...next.documents];
            next.audit = [
              {
                id: nextId("au"),
                clientId: activeClientId,
                docId: id,
                docName: f.name,
                actor,
                plane: planeArg === "firm" ? "Firm" : "Client portal",
                action: "uploaded",
                at: doc.uploadedAt,
                detail: `Uploaded and classified as ${f.docType} for ${f.period}`,
              },
              ...next.audit,
            ];
            if (f.openItemId && !duplicate) {
              const item = next.openItems.find((o) => o.id === f.openItemId);
              if (item) {
                item.status = "uploaded";
                item.documentIds = [...item.documentIds, id];
                item.rejectionReason = undefined;
              }
            }
          }
        });
        return ids;
      },

      updateDocument: (docId, patch, action, detail, actor, planeArg) =>
        mutate((next) => {
          const doc = next.documents.find((d) => d.id === docId);
          if (!doc) return;
          Object.assign(doc, patch);
          next.audit = [
            {
              id: nextId("au"),
              clientId: doc.clientId,
              docId,
              docName: doc.name,
              actor,
              plane: planeArg === "firm" ? "Firm" : "Client portal",
              action,
              at: new Date().toISOString().slice(0, 19),
              detail,
            },
            ...next.audit,
          ];
          if (doc.openItemId) {
            const item = next.openItems.find((o) => o.id === doc.openItemId);
            if (item) {
              if (patch.status === "accepted") item.status = "accepted";
              if (patch.status === "under_review") item.status = "under_review";
              if (patch.status === "rejected") {
                item.status = "rejected";
                item.rejectionReason = detail;
              }
            }
          }
        }),

      logAudit: (docId, docName, action, detail, actor, planeArg) =>
        mutate((next) => {
          next.audit = [
            {
              id: nextId("au"),
              clientId: activeClientId,
              docId,
              docName,
              actor,
              plane: planeArg === "firm" ? "Firm" : "Client portal",
              action,
              at: new Date().toISOString().slice(0, 19),
              detail,
            },
            ...next.audit,
          ];
        }),

      setOpenItemStatus: (itemId, status, reason) =>
        mutate((next) => {
          const item = next.openItems.find((o) => o.id === itemId);
          if (!item) return;
          item.status = status;
          item.rejectionReason = status === "rejected" ? reason : undefined;
        }),

      signDocument: (title, signerName, mode, role) =>
        mutate((next) => {
          const at = new Date().toISOString().slice(0, 19);
          next.signatures = [
            {
              id: nextId("sig"),
              clientId: activeClientId,
              documentTitle: title,
              signerName,
              signerRole: role,
              mode,
              signedAt: at,
              ip: "70.114.22.41",
            },
            ...next.signatures,
          ];
          next.audit = [
            {
              id: nextId("au"),
              clientId: activeClientId,
              docName: title,
              actor: signerName,
              plane: "Client portal",
              action: "signed",
              at,
              detail: `Signed by ${mode === "drawn" ? "drawn signature" : "typed name"} from the client portal`,
            },
            ...next.audit,
          ];
        }),

      setTaskStatus: (taskId, status) =>
        mutate((next) => {
          const t = next.tasks.find((x) => x.id === taskId);
          if (t) t.status = status;
        }),

      reassignTask: (taskId, assignee) =>
        mutate((next) => {
          const t = next.tasks.find((x) => x.id === taskId);
          if (t) t.assignee = assignee;
        }),

      addMessage: (clientId, who, subject, body, direction, linkedItemId) =>
        mutate((next) => {
          next.comms = [
            {
              id: nextId("cm"),
              clientId,
              at: new Date().toISOString().slice(0, 19),
              channel: "Portal message",
              direction,
              who,
              subject,
              body,
              linkedItemId,
            },
            ...next.comms,
          ];
        }),

      setIntake: (patch) => setIntakeState((prev) => ({ ...prev, ...patch })),
      setIntakeStep,
      resetIntake: () => {
        setIntakeState(emptyIntake());
        setIntakeStep(0);
      },

      createClientFromIntake: () => {
        if (!intake.legalName || !intake.scope.length) return null;
        const id = `new-${Date.now().toString(36)}`;
        const client: Client = {
          id,
          legalName: intake.legalName,
          dba: intake.dba || intake.legalName,
          shortName: intake.dba || intake.legalName,
          industry: intake.industry || "Not stated",
          entityType: intake.entityType as Client["entityType"],
          ein: intake.ein,
          fiscalYearEnd: intake.fiscalYearEnd,
          address: intake.address,
          owners: intake.owners.map((o, i) => ({ id: `${id}-ow-${i}`, name: o.name, ownershipPct: Number(o.ownershipPct) || 0, role: o.role })),
          contacts: intake.people.map((p, i) => ({
            id: `${id}-cc-${i}`,
            name: p.name,
            email: p.email,
            role: p.role,
            canApprovePayments: p.canApprovePayments,
            canApproveJournalEntries: p.canApproveJournalEntries,
            mfaRequired: p.mfaRequired,
          })),
          systems: intake.systems.map((s, i) => ({ id: `${id}-sy-${i}`, kind: s.kind as never, vendor: s.vendor, accessStatus: s.accessStatus as never })),
          scope: intake.scope,
          classes: ["General"],
          locations: ["Primary"],
          jobs: ["General"],
          currencies: ["USD"],
          priorRecords: {
            lastFinancials: intake.priorFinancials,
            priorTrialBalance: intake.priorTrialBalance,
            existingCoa: intake.existingCoa,
            cleanupItems: intake.cleanupItems,
            outstandingRecs: intake.outstandingRecs,
          },
          engagement: {
            monthlyFeeCents: Math.round(Number(intake.monthlyFee || 0) * 100),
            cleanupFeeCents: Math.round(Number(intake.cleanupFee || 0) * 100),
            startDate: intake.startDate,
            signedBy: intake.signedAt ? intake.signerName : undefined,
            signedAt: intake.signedAt,
            signatureMode: intake.signatureMode,
          },
          onboardingStage: "Intake",
          lead: "Trey Hernandez",
          color: "hsl(196 62% 42%)",
        };
        mutate((next) => {
          next.clients = [...next.clients, client];
          next.bankAccounts = [
            ...next.bankAccounts,
            ...intake.accounts
              .filter((a) => a.institution || a.nickname)
              .map((a, i) => ({
                id: `${id}-ba-${i}`,
                clientId: id,
                institution: a.institution,
                nickname: a.nickname,
                last4: a.last4,
                kind: a.kind as never,
                currency: a.currency,
                glAccountId: a.kind === "Credit card" ? "2010" : a.kind === "Savings" ? "1020" : a.kind === "Loan" ? "2500" : a.kind === "Merchant processor" ? "1050" : "1010",
                statementSource: a.statementSource as never,
                needsReconciling: a.needsReconciling,
              })),
          ];
          next.tasks = [
            ...next.tasks,
            ...tasksForScope(id, intake.scope, CURRENT_PERIOD, "Trey Hernandez", "newtask"),
          ];
          if (intake.signedAt) {
            next.signatures = [
              {
                id: `${id}-sig`,
                clientId: id,
                documentTitle: `Engagement letter and fee agreement, ${client.dba}`,
                signerName: intake.signerName,
                signerRole: intake.people[0]?.role || "Owner",
                mode: intake.signatureMode,
                signedAt: intake.signedAt,
                ip: "70.114.22.41",
              },
              ...next.signatures,
            ];
            next.audit = [
              {
                id: `${id}-au`,
                clientId: id,
                docName: `Engagement letter, ${client.dba}`,
                actor: intake.signerName,
                plane: "Client portal",
                action: "signed",
                at: intake.signedAt,
                detail: `Signed by ${intake.signatureMode === "drawn" ? "drawn signature" : "typed name"} during onboarding`,
              },
              ...next.audit,
            ];
          }
        });
        setActiveClientId(id);
        return id;
      },

      intakeCompleteness: () => {
        const sections = [
          { label: "Business profile", done: Boolean(intake.legalName && intake.ein && intake.address && intake.entityType) },
          { label: "Owners and contact", done: intake.owners.some((o) => o.name) && Boolean(intake.primaryContactName) },
          { label: "Engagement scope", done: intake.scope.length > 0 },
          { label: "Systems inventory", done: intake.systems.some((s) => s.vendor) },
          { label: "Accounts inventory", done: intake.accounts.some((a) => a.institution && a.last4) },
          { label: "Prior records", done: Boolean(intake.priorFinancials || intake.priorTrialBalance) },
          { label: "Engagement letter", done: Boolean(intake.monthlyFee && intake.startDate) },
          { label: "Signature", done: Boolean(intake.signedAt) },
          { label: "Access and roles", done: intake.people.some((p) => p.name && p.email) },
        ];
        const done = sections.filter((s) => s.done).length;
        return { pct: Math.round((done / sections.length) * 100), sections };
      },

      intakeTaskPreview: () =>
        tasksForScope("preview", intake.scope, CURRENT_PERIOD, "Unassigned", "preview").map((t) => ({
          title: t.title,
          scopeSource: t.scopeSource,
          estHours: t.estHours,
        })),
    };
  }, [ds, plane, activeClientId, period, comparePeriod, loading, loadError, loadMode, dataMode, setDataMode, theme, intake, intakeStep, mutate, runLoad]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useApp(): AppApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
