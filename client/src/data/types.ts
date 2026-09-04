export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  contra?: boolean;
  cashLike?: boolean;
  suspense?: boolean;
}

export type EntityType = "Sole Prop" | "Partnership" | "LLC" | "S Corp" | "C Corp" | "Nonprofit";

/**
 * The chart template the setup wizard started a client from. These are the same
 * keys INTAKE-BUILD-CHART accepts, so a client record and the run that built its
 * chart describe the template the same way.
 */
export type IndustryTemplateKey =
  | "services"
  | "product"
  | "restaurant"
  | "real_estate"
  | "nonprofit"
  | "contractor";

export interface Owner {
  id: string;
  name: string;
  ownershipPct: number;
  role: string;
}

export interface SystemRow {
  id: string;
  kind: "Accounting software" | "Point of sale" | "E commerce" | "Payroll" | "Other";
  vendor: string;
  accessStatus: "No access" | "Read only requested" | "Read only granted" | "Admin";
}

export interface BankAccount {
  id: string;
  clientId: string;
  institution: string;
  nickname: string;
  last4: string;
  kind: "Checking" | "Savings" | "Credit card" | "Loan" | "Merchant processor";
  currency: string;
  glAccountId: string;
  statementSource: "Bank feed" | "Portal" | "PDF upload";
  needsReconciling: boolean;
}

export interface ClientContact {
  id: string;
  name: string;
  email: string;
  role: string;
  canApprovePayments: boolean;
  canApproveJournalEntries: boolean;
  mfaRequired: boolean;
}

export type ScopeKey =
  | "ap"
  | "ar"
  | "payroll_je"
  | "sales_tax"
  | "form_1099"
  | "monthly_close"
  | "cleanup";

export interface Client {
  id: string;
  legalName: string;
  dba: string;
  shortName: string;
  industry: string;
  entityType: EntityType;
  ein: string;
  fiscalYearEnd: string;
  address: string;
  owners: Owner[];
  contacts: ClientContact[];
  systems: SystemRow[];
  scope: ScopeKey[];
  classes: string[];
  locations: string[];
  jobs: string[];
  currencies: string[];
  priorRecords: {
    lastFinancials: string;
    priorTrialBalance: string;
    existingCoa: string;
    cleanupItems: string[];
    outstandingRecs: string[];
  };
  engagement: {
    monthlyFeeCents: number;
    cleanupFeeCents: number;
    startDate: string;
    signedBy?: string;
    signedAt?: string;
    signatureMode?: "typed" | "drawn";
  };
  /** First day the firm keeps the books. Set by the wizard, blank on a client that predates it. */
  cutoverDate?: string;
  /** Which chart template the wizard built from. Blank on a client whose chart came in by hand. */
  industryTemplate?: IndustryTemplateKey;
  onboardingStage: "Intake" | "Cleanup" | "Live" | "Review";
  lead: string;
  color: string;
  /** Fixture kept for self checking. Shown with a badge so it is never read as a real client. */
  testCompany?: boolean;
}

export interface JELine {
  accountId: string;
  debit: number;
  credit: number;
  klass?: string;
  location?: string;
  job?: string;
  memo?: string;
}

export type JESource =
  | "opening"
  | "bank"
  | "invoice"
  | "bill"
  | "payroll"
  | "manual"
  | "depreciation"
  | "accrual"
  | "reversal";

export interface JournalEntry {
  id: string;
  ref: string;
  clientId: string;
  date: string;
  period: string;
  memo: string;
  source: JESource;
  lines: JELine[];
  posted: boolean;
  createdBy: string;
  reversalOf?: string;
  reversedBy?: string;
}

export type TxnStatus = "needs_review" | "categorized" | "excluded";

export interface Txn {
  id: string;
  clientId: string;
  date: string;
  period: string;
  description: string;
  vendor: string;
  amountCents: number;
  currency: string;
  fxRate: number;
  baseAmountCents: number;
  bankAccountId: string;
  glAccountId: string;
  categoryAccountId: string;
  suggestedAccountId?: string;
  suggestionReason?: string;
  confidence: number;
  status: TxnStatus;
  klass: string;
  location: string;
  job: string;
  cleared: boolean;
  reconciledPeriod?: string;
  jeId: string;
  ruleId?: string;
  isMirror?: boolean;
  memo?: string;
  /** Doc 00 Part 4 reason code, required while the amount sits in account 1990. */
  suspenseReason?: string;
  /** Date the item was parked in suspense, used for the escalation clock. */
  suspenseOpenedOn?: string;
}

export interface Rule {
  id: string;
  clientId: string;
  name: string;
  matchType: "Description contains" | "Vendor equals" | "Amount equals";
  matchValue: string;
  accountId: string;
  klass?: string;
  hits: number;
  createdBy: string;
  createdAt: string;
  active: boolean;
}

export interface StatementLine {
  id: string;
  clientId: string;
  bankAccountId: string;
  period: string;
  date: string;
  description: string;
  amountCents: number;
  matchedTxnId?: string;
}

export interface Invoice {
  id: string;
  clientId: string;
  number: string;
  customer: string;
  date: string;
  dueDate: string;
  amountCents: number;
  paidCents: number;
  klass: string;
  jeId: string;
}

export interface Bill {
  id: string;
  clientId: string;
  number: string;
  vendorId: string;
  vendor: string;
  date: string;
  dueDate: string;
  amountCents: number;
  paidCents: number;
  accountId: string;
  jeId: string;
}

export interface Vendor {
  id: string;
  clientId: string;
  name: string;
  taxClassification: string;
  w9OnFile: boolean;
  tinLast4?: string;
  ytdPaymentsCents: number;
  reportable: boolean;
  requestSentAt?: string;
}

export type TieStatus = "tied" | "variance" | "unsupported";

export interface Substantiation {
  id: string;
  clientId: string;
  accountId: string;
  period: string;
  supportType: string;
  supportedCents: number | null;
  documentIds: string[];
  preparedBy: string;
  reviewedBy?: string;
  note: string;
}

export type OpenItemStatus =
  | "not_started"
  | "uploaded"
  | "under_review"
  | "accepted"
  | "rejected";

export interface OpenItem {
  id: string;
  clientId: string;
  accountId?: string;
  period: string;
  title: string;
  detail: string;
  docType: string;
  requestedFrom: string;
  dueDate: string;
  status: OpenItemStatus;
  rejectionReason?: string;
  documentIds: string[];
  amountCents?: number;
}

export type DocStatus = "uploading" | "uploaded" | "under_review" | "accepted" | "rejected" | "duplicate";

export interface DocRecord {
  id: string;
  clientId: string;
  name: string;
  sizeBytes: number;
  mime: string;
  docType: string;
  period: string;
  bankAccountId?: string;
  status: DocStatus;
  progress: number;
  uploadedBy: string;
  uploadedAt: string;
  openItemId?: string;
  note?: string;
}

export type AuditAction =
  | "uploaded"
  | "viewed"
  | "downloaded"
  | "renamed"
  | "deleted"
  | "classified"
  | "accepted"
  | "rejected"
  | "signed"
  | "shared";

export interface AuditRow {
  id: string;
  clientId: string;
  docId?: string;
  docName: string;
  actor: string;
  plane: "Firm" | "Client portal";
  action: AuditAction;
  at: string;
  detail: string;
}

export type TaskStatus = "Not started" | "In progress" | "Blocked" | "Review" | "Done";

export interface Task {
  id: string;
  clientId: string;
  title: string;
  scopeSource: ScopeKey | "setup";
  period: string;
  dueDate: string;
  status: TaskStatus;
  assignee: string;
  estHours: number;
}

export interface TeamMember {
  id: string;
  name: string;
  initials: string;
  role: string;
  capacityHours: number;
  clients: string[];
}

export interface CommEntry {
  id: string;
  clientId: string;
  at: string;
  channel: "Email" | "Portal message" | "Call";
  direction: "Inbound" | "Outbound";
  who: string;
  subject: string;
  body: string;
  linkedItemId?: string;
}

export interface BudgetLine {
  clientId: string;
  accountId: string;
  period: string;
  amountCents: number;
}

export interface Signature {
  id: string;
  clientId: string;
  documentTitle: string;
  signerName: string;
  signerRole: string;
  mode: "typed" | "drawn";
  signedAt: string;
  ip: string;
}

/* ---------------- Portal entitlement, closes, and entity groups ---------------- */

/** Portal depth is bundled into the service level. There is no plan and no payment anywhere in this product. */
export type TierId = "ledger" | "ledger_plus" | "legend";

/**
 * Effective dated entitlement sourced from the engagement, per decision D1.
 * A row with no effectiveTo is the current grant for that client.
 */
export interface EntitlementGrant {
  id: string;
  clientId: string;
  tierId: TierId;
  effectiveFrom: string;
  effectiveTo?: string;
  setBy: string;
  reason: string;
}

export type CloseState = "open" | "closed";

/** A period close is a real record, not a checkbox. Locked follows a passed close. */
export interface PeriodClose {
  id: string;
  clientId: string;
  period: string;
  state: CloseState;
  preparedBy?: string;
  reviewedBy?: string;
  closedAt?: string;
  locked: boolean;
  withExceptions: boolean;
  exceptionNote?: string;
}

/** A set of entities one portal account can see. Consolidation reads only these members. */
export interface EntityGroup {
  id: string;
  name: string;
  primaryClientId: string;
  memberClientIds: string[];
}
