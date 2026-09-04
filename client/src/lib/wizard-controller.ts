/**
 * The intake wizard's state, its validation, and the finish controller.
 *
 * Everything the wizard knows lives in the object below and in the URL query.
 * There is no localStorage, no sessionStorage, and no cookie, which is a
 * constraint rather than an oversight: a half filled client setup is not
 * something this build should silently resurrect in a browser a week later.
 * Losing the tab loses the draft, and the wizard says so on step 6.
 *
 * The finish controller runs the four setup runs in the published order:
 *
 *   1. INTAKE-BUILD-CHART
 *   2. INTAKE-SEED-TASKS
 *   3. INTAKE-OPEN-REQUESTS
 *   4. SETUP-IMPORT-BALANCES
 *
 * Balances go last on purpose. The first three cannot fail on the numbers, so a
 * trial balance that does not foot leaves the firm a client with a chart, a
 * workload, and its opening asks raised, and the firm fixes the figures and
 * presses Finish again. All four runs are idempotent, so the second press
 * writes only what the first press did not.
 *
 * SENDS. None. No invite email, no notification, no webhook. Step 2 records
 * whether a person is to get a login and the finish writes that intent to the
 * audit log. Nothing leaves the machine.
 *
 * CONSTRAINT. No inference. Every validation below is a length check, a set
 * membership test, a date shape test, or integer cents arithmetic.
 *
 * COMPLIANCE. This controller sets up bookkeeping records. It does not file
 * anything, does not register anything, and does not advise.
 */

import {
  MANDATORY_CLEARING_ACCOUNTS,
  OPENING_BALANCE_EQUITY_ACCOUNT,
  contraFor,
  previewCatalog,
  previewChart,
  previewRequests,
  templateFor,
  type TemplateAccount,
} from "./intake-templates";

/* -------------------------------------------------------------------------- */
/* The formats D2 accepts, and the one it refuses                             */
/* -------------------------------------------------------------------------- */

export interface ImportFormatOption {
  value: string;
  label: string;
  /** True when the format needs a saved column mapping profile. */
  needsProfile: boolean;
  /** Set when the format cannot be chosen, and says why in plain words. */
  unavailableReason: string | null;
}

/** Doc 05 decision D2, pipeline one. These and no others. */
export const IMPORT_FORMATS: readonly ImportFormatOption[] = [
  {
    value: "ofx",
    label: "OFX",
    needsProfile: false,
    unavailableReason: null,
  },
  {
    value: "qfx",
    label: "QFX",
    needsProfile: false,
    unavailableReason: null,
  },
  {
    value: "qbo",
    label: "QBO",
    needsProfile: false,
    unavailableReason: null,
  },
  {
    value: "camt053",
    label: "CAMT.053",
    needsProfile: false,
    unavailableReason: null,
  },
  {
    value: "csv",
    label: "CSV with a saved mapping profile",
    needsProfile: true,
    unavailableReason: null,
  },
  {
    value: "xlsx",
    label: "XLSX with a saved mapping profile",
    needsProfile: true,
    unavailableReason: null,
  },
  {
    value: "pdf",
    label: "PDF statement",
    needsProfile: false,
    unavailableReason: "we do not parse PDF statements",
  },
];

export function formatOption(value: string): ImportFormatOption | undefined {
  return IMPORT_FORMATS.find((f) => f.value === value);
}

/** The canonical fields a mapping profile column can be pointed at. */
export const CANONICAL_FIELDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "date", label: "date" },
  { value: "description", label: "description" },
  { value: "amount_cents", label: "amount_cents" },
  { value: "memo", label: "memo" },
  { value: "external_id", label: "external_id" },
  { value: "unmapped", label: "not imported" },
];

/** The four date shapes IMPORT-PARSE-FEED can read. It reads no others. */
export const DATE_FORMATS: readonly string[] = [
  "YYYY-MM-DD",
  "YYYYMMDD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
];

export const SIGN_CONVENTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "credit_positive", label: "money in is positive" },
  { value: "debit_positive", label: "money out is positive" },
  { value: "separate_columns", label: "separate debit and credit columns" },
];

/* -------------------------------------------------------------------------- */
/* Draft shapes                                                               */
/* -------------------------------------------------------------------------- */

export const ENTITY_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "LLC", label: "LLC" },
  { value: "S Corp", label: "S Corp" },
  { value: "C Corp", label: "C Corp" },
  { value: "Sole prop", label: "Sole proprietorship" },
  { value: "Nonprofit", label: "Nonprofit" },
];

export const SERVICE_TIERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "story", label: "Story" },
  { value: "journey", label: "Journey" },
  { value: "legend", label: "Legend" },
];

export const PERSON_ROLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "owner", label: "Owner" },
  { value: "controller", label: "Controller" },
  { value: "ar", label: "AR contact" },
  { value: "ap", label: "AP contact" },
];

export const ACCOUNT_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit card" },
  { value: "loan", label: "Loan" },
];

export interface WizardPerson {
  key: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  getsLogin: boolean;
}

export interface WizardProfileColumn {
  key: string;
  sourceColumn: string;
  canonicalField: string;
}

export interface WizardProfile {
  key: string;
  name: string;
  institutionName: string;
  fileFormat: string;
  dateFormat: string;
  signConvention: string;
  currency: string;
  headerRowNumber: number;
  skipRows: number;
  columns: WizardProfileColumn[];
}

export interface WizardBankAccount {
  key: string;
  institutionName: string;
  nickname: string;
  kind: string;
  lastFour: string;
  glAccountNumber: string;
  importFormat: string;
  /** The key of the profile on this draft, or empty when the format needs none. */
  profileKey: string;
}

export interface WizardBalanceLine {
  key: string;
  accountNumber: string;
  /** Whatever the person typed. Turned into integer cents only by centsOf. */
  amount: string;
}

export interface WizardDraft {
  legalName: string;
  dba: string;
  ein: string;
  stateOfIncorporation: string;
  entityType: string;
  fiscalYearEnd: string;
  serviceTier: string;
  cutoverDate: string;
  industry: string;

  people: WizardPerson[];

  excludedAccounts: string[];
  addedAccounts: TemplateAccount[];

  bankAccounts: WizardBankAccount[];
  profiles: WizardProfile[];

  balanceLines: WizardBalanceLine[];
  balanceSource: string;
}

export const WIZARD_STEPS: readonly string[] = [
  "Company",
  "People",
  "Chart of accounts",
  "Bank accounts and mapping",
  "Opening balances",
  "Review and finish",
];

/** The banner at the top of every step. It never changes and never softens. */
export const COMPLIANCE_BANNER =
  "This wizard sets up bookkeeping records. It does not file tax documents, does not act as a registered agent, and does not provide legal or tax advice.";

/** Step 2's banner. Nothing in this build sends anything to anybody. */
export const INVITE_BANNER = "invite queued in audit log, no external send in this build";

export function emptyWizard(): WizardDraft {
  return {
    legalName: "",
    dba: "",
    ein: "",
    stateOfIncorporation: "",
    entityType: "LLC",
    fiscalYearEnd: "12-31",
    serviceTier: "journey",
    cutoverDate: "",
    industry: "services",
    people: [],
    excludedAccounts: [],
    addedAccounts: [],
    bankAccounts: [],
    profiles: [],
    balanceLines: [],
    balanceSource: "wizard_trial_balance",
  };
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A key for a row a person just added. Not an id and never written anywhere:
 * the server derives every real id from the client and the account number, so
 * this exists only to keep React rows stable while the wizard is open.
 */
export function rowKey(prefix: string, seq: number): string {
  return `${prefix}-${String(seq)}`;
}

export function newPerson(seq: number): WizardPerson {
  return {
    key: rowKey("person", seq),
    name: "",
    role: "owner",
    email: "",
    phone: "",
    getsLogin: false,
  };
}

export function newBankAccount(seq: number): WizardBankAccount {
  return {
    key: rowKey("bank", seq),
    institutionName: "",
    nickname: "",
    kind: "checking",
    lastFour: "",
    glAccountNumber: "1000",
    importFormat: "ofx",
    profileKey: "",
  };
}

export function newProfile(seq: number): WizardProfile {
  return {
    key: rowKey("profile", seq),
    name: "",
    institutionName: "",
    fileFormat: "csv",
    dateFormat: "YYYY-MM-DD",
    signConvention: "credit_positive",
    currency: "USD",
    headerRowNumber: 1,
    skipRows: 0,
    columns: [
      { key: "col-1", sourceColumn: "", canonicalField: "date" },
      { key: "col-2", sourceColumn: "", canonicalField: "description" },
      { key: "col-3", sourceColumn: "", canonicalField: "amount_cents" },
    ],
  };
}

export function newBalanceLine(seq: number, accountNumber = ""): WizardBalanceLine {
  return { key: rowKey("bal", seq), accountNumber, amount: "" };
}

/** True when the string is exactly a calendar day, YYYY-MM-DD. */
export function isIsoDay(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** True when the string is an employer identification number, NN-NNNNNNN. */
export function isEin(value: string): boolean {
  return /^[0-9]{2}-[0-9]{7}$/.test(value);
}

/**
 * Integer cents for one typed amount, or null when the string is not a number.
 *
 * This is stricter on purpose than the shared parseAmountToCents, which strips
 * anything that is not a digit and answers zero for a string with no digits at
 * all. That is the right behaviour for a display field and the wrong behaviour
 * here, because a trial balance line reading "about 4k" has to be reported as
 * unreadable rather than quietly posted as zero. Nothing is inferred and no
 * float is used: the whole part and the two cent digits are parsed as integers
 * and combined with BigInt.
 *
 * Accepted: an optional sign, thousands commas, dollar sign, whitespace, up to
 * two decimal places, and a parenthesised negative the way an accountant types
 * one. Anything else is null.
 */
export function centsOf(amount: string): bigint | null {
  let text = amount.trim();
  if (text.length === 0) return null;

  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^\$/, "").replace(/\s/g, "").replace(/,/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt(((match[2] ?? "") + "00").slice(0, 2));
  const total = whole * BigInt(100) + fraction;
  return negative ? -total : total;
}

/* -------------------------------------------------------------------------- */
/* The running trial balance total, live on step 5                            */
/* -------------------------------------------------------------------------- */

export interface FootingState {
  /** The signed total of every line that parsed, in integer cents. */
  totalCents: bigint;
  /** How many lines carry a figure the parser could read. */
  parsedCount: number;
  /** The lines whose amount could not be read at all. */
  unreadable: string[];
  /** Accounts named twice. Not an error, the run adds them, but worth saying. */
  duplicates: string[];
  /** The figure the offset line will carry, which is the negation of the total. */
  offsetCents: bigint;
  /**
   * True when the whole thing can be posted. A trial balance foots when the
   * lines other than 3900 offset to whatever 3900 is asked to carry, and this
   * wizard derives 3900 rather than asking for it, so any readable set foots.
   * What can still fail is a supplied 3900 line that disagrees, which is the
   * SETUP-IMPORT-BALANCES error OPENING_EQUITY_DISAGREES.
   */
  foots: boolean;
  /** Set when a supplied 3900 line disagrees with the rest of the sheet. */
  equityConflict: string | null;
}

export function footingOf(lines: readonly WizardBalanceLine[]): FootingState {
  let total = BigInt(0);
  let parsedCount = 0;
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let suppliedEquity: bigint | null = null;

  for (const line of lines) {
    const account = line.accountNumber.trim();
    if (account.length === 0 && line.amount.trim().length === 0) continue;
    const cents = centsOf(line.amount);
    if (cents === null) {
      unreadable.push(account.length > 0 ? account : "a line with no account");
      continue;
    }
    if (seen.has(account)) duplicates.push(account);
    seen.add(account);
    parsedCount += 1;
    if (account === OPENING_BALANCE_EQUITY_ACCOUNT) {
      suppliedEquity = (suppliedEquity ?? BigInt(0)) + cents;
      continue;
    }
    total += cents;
  }

  const offset = -total;
  let equityConflict: string | null = null;
  if (suppliedEquity !== null && suppliedEquity !== offset) {
    equityConflict = `the sheet names ${OPENING_BALANCE_EQUITY_ACCOUNT} as ${suppliedEquity.toString()} cents and the other accounts imply ${offset.toString()} cents. the run will refuse this rather than plug the difference`;
  }

  return {
    totalCents: total,
    parsedCount,
    unreadable,
    duplicates,
    offsetCents: offset,
    foots: unreadable.length === 0 && parsedCount > 0 && equityConflict === null,
    equityConflict,
  };
}

/**
 * Parse a pasted or uploaded trial balance. Two columns, account number and
 * amount, comma or tab separated, with an optional header row. A row that
 * cannot be read is returned with an empty amount so the grid shows it as
 * unreadable rather than dropping it silently.
 */
export function parseBalanceCsv(text: string): WizardBalanceLine[] {
  const out: WizardBalanceLine[] = [];
  let seq = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cells = line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const account = cells[0] ?? "";
    if (!/^[0-9]{4}$/.test(account)) continue; // a header row or a total line
    seq += 1;
    out.push({
      key: rowKey("bal", seq),
      accountNumber: account,
      amount: cells[1] ?? "",
    });
  }
  return out;
}

/**
 * Split a pasted sample of CSV rows into a header and its data rows. This is
 * how the mapping profile preview reads what a person pasted, and it is the
 * same shape rule the import runs use: the header is a row of names and every
 * row after it is data.
 */
export function parseSampleRows(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const split = (line: string): string[] =>
    line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  return { header: split(lines[0] ?? ""), rows: lines.slice(1).map(split) };
}

/**
 * Match a pasted header against a profile's source columns. Header rules only:
 * an exact match after trimming and upper casing, and nothing else. No
 * similarity, no distance, no guess at a shifted column, because doc 05 says a
 * silent column shift is the worst failure this pipeline can have.
 */
export function matchProfileToHeader(
  profile: WizardProfile,
  header: readonly string[],
): Array<{ canonicalField: string; sourceColumn: string; columnIndex: number | null }> {
  const normalized = header.map((h) => h.trim().toUpperCase());
  return profile.columns
    .filter((c) => c.canonicalField !== "unmapped")
    .map((c) => {
      const index = normalized.indexOf(c.sourceColumn.trim().toUpperCase());
      return {
        canonicalField: c.canonicalField,
        sourceColumn: c.sourceColumn,
        columnIndex: index === -1 ? null : index,
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Step validation                                                            */
/* -------------------------------------------------------------------------- */

export interface StepIssue {
  step: number;
  field: string;
  message: string;
}

/**
 * Everything wrong with the draft, per step. A step with no issues can be left.
 * A step with issues can still be left, because a person filling a form out of
 * order is normal, but Finish is refused until the list is empty.
 */
export function issuesOf(draft: WizardDraft): StepIssue[] {
  const out: StepIssue[] = [];
  const say = (step: number, field: string, message: string): void => {
    out.push({ step, field, message });
  };

  // Step 1, company.
  if (draft.legalName.trim().length < 2) {
    say(0, "legalName", "a legal name is needed to open a file");
  }
  if (draft.ein.trim().length > 0 && !isEin(draft.ein.trim())) {
    say(0, "ein", "an EIN is two digits, a hyphen, then seven digits");
  }
  if (draft.stateOfIncorporation.trim().length !== 2) {
    say(0, "stateOfIncorporation", "the state of incorporation is a two letter code");
  }
  if (!/^[0-9]{2}-[0-9]{2}$/.test(draft.fiscalYearEnd)) {
    say(0, "fiscalYearEnd", "a fiscal year end is a month and a day, MM-DD");
  }
  if (!isIsoDay(draft.cutoverDate)) {
    say(0, "cutoverDate", "a cutover date is a calendar day, YYYY-MM-DD");
  }
  if (templateFor(draft.industry) === undefined) {
    say(0, "industry", "pick one of the standard chart templates");
  }

  // Step 2, people.
  if (draft.people.length === 0) {
    say(1, "people", "at least one contact is needed");
  }
  if (!draft.people.some((p) => p.role === "owner")) {
    say(1, "people", "one contact has to be the owner, because the W-9 ask names them");
  }
  draft.people.forEach((p, i) => {
    if (p.name.trim().length < 2) say(1, `person-${String(i)}`, "every contact needs a name");
    if (p.email.trim().length > 0 && !p.email.includes("@")) {
      say(1, `person-${String(i)}`, `${p.name || "a contact"} has an email with no at sign`);
    }
    if (p.getsLogin && p.email.trim().length === 0) {
      say(1, `person-${String(i)}`, `${p.name || "a contact"} is set to get a login and has no email on record`);
    }
  });

  // Step 3, chart.
  const chart = previewChart(draft.industry, draft.excludedAccounts, draft.addedAccounts);
  if (chart.length === 0) {
    say(2, "chart", "the chart is empty, which cannot be seeded");
  }
  draft.addedAccounts.forEach((a, i) => {
    if (!/^[0-9]{4}$/.test(a.accountNumber)) {
      say(2, `added-${String(i)}`, "an account number is exactly four digits");
    }
    if (a.name.trim().length < 2) {
      say(2, `added-${String(i)}`, `account ${a.accountNumber} needs a name`);
    }
  });

  // Step 4, bank accounts and mapping profiles.
  if (draft.bankAccounts.length === 0) {
    say(3, "bankAccounts", "at least one bank or card account is needed");
  }
  const chartNumbers = new Set(chart.map((a) => a.accountNumber));
  draft.bankAccounts.forEach((b, i) => {
    const label = b.nickname.trim().length > 0 ? b.nickname : `account ${String(i + 1)}`;
    if (b.institutionName.trim().length < 2) {
      say(3, `bank-${String(i)}`, `${label} needs the institution name`);
    }
    if (!chartNumbers.has(b.glAccountNumber)) {
      say(3, `bank-${String(i)}`, `${label} points at general ledger account ${b.glAccountNumber}, which is not on the chart step 3 will seed`);
    }
    const format = formatOption(b.importFormat);
    if (format === undefined) {
      say(3, `bank-${String(i)}`, `${label} has no import format`);
      return;
    }
    if (format.unavailableReason !== null) {
      say(3, `bank-${String(i)}`, `${label} is set to ${format.label}, and ${format.unavailableReason}`);
      return;
    }
    if (format.needsProfile && b.profileKey.trim().length === 0) {
      say(3, `bank-${String(i)}`, `${label} imports ${format.label} and has no mapping profile attached`);
    }
  });
  draft.profiles.forEach((p, i) => {
    const label = p.name.trim().length > 0 ? p.name : `profile ${String(i + 1)}`;
    if (p.name.trim().length < 2) say(3, `profile-${String(i)}`, "every mapping profile needs a name");
    if (p.institutionName.trim().length < 2) {
      say(3, `profile-${String(i)}`, `${label} needs the institution it is for`);
    }
    const mapped = new Set(
      p.columns.filter((c) => c.sourceColumn.trim().length > 0).map((c) => c.canonicalField),
    );
    for (const required of ["date", "description", "amount_cents"]) {
      if (!mapped.has(required)) {
        say(3, `profile-${String(i)}`, `${label} has no column mapped to ${required}`);
      }
    }
    const counts = new Map<string, number>();
    for (const c of p.columns) {
      if (c.canonicalField === "unmapped") continue;
      counts.set(c.canonicalField, (counts.get(c.canonicalField) ?? 0) + 1);
    }
    for (const [field, count] of counts) {
      if (count > 1) {
        say(3, `profile-${String(i)}`, `${label} maps ${String(count)} columns to ${field}, and the parser will not choose between them`);
      }
    }
  });

  // Step 5, opening balances.
  const footing = footingOf(draft.balanceLines);
  if (footing.parsedCount === 0) {
    say(4, "balances", "no opening balance figures have been entered");
  }
  for (const bad of footing.unreadable) {
    say(4, "balances", `the amount on ${bad} could not be read as a number`);
  }
  if (footing.equityConflict !== null) {
    say(4, "balances", footing.equityConflict);
  }
  for (const line of draft.balanceLines) {
    const account = line.accountNumber.trim();
    if (account.length === 0) continue;
    if (!chartNumbers.has(account) && account !== OPENING_BALANCE_EQUITY_ACCOUNT) {
      say(4, "balances", `account ${account} is on the trial balance and not on the chart, and the run will refuse it`);
    }
  }

  return out;
}

export function issuesForStep(draft: WizardDraft, step: number): StepIssue[] {
  return issuesOf(draft).filter((i) => i.step === step);
}

export function canFinish(draft: WizardDraft): boolean {
  return issuesOf(draft).length === 0;
}

/* -------------------------------------------------------------------------- */
/* What Finish will do                                                        */
/* -------------------------------------------------------------------------- */

export interface PlannedRun {
  type: string;
  title: string;
  /** What it will write, counted, so the review step is specific. */
  detail: string;
}

/** The published order. Balances go last because they are the only step that can refuse. */
export const INTAKE_ORDER: readonly string[] = [
  "INTAKE-BUILD-CHART",
  "INTAKE-SEED-TASKS",
  "INTAKE-OPEN-REQUESTS",
  "SETUP-IMPORT-BALANCES",
];

export function plannedRuns(draft: WizardDraft): PlannedRun[] {
  const template = templateFor(draft.industry);
  const chart = previewChart(draft.industry, draft.excludedAccounts, draft.addedAccounts);
  const catalog = previewCatalog([]);
  const requests = previewRequests([]);
  const footing = footingOf(draft.balanceLines);
  const postedLines = footing.parsedCount + (footing.offsetCents === BigInt(0) ? 0 : 1);

  return [
    {
      type: "INTAKE-BUILD-CHART",
      title: "Seed the chart of accounts",
      detail: `${String(chart.length)} accounts and ${String(template?.categoryCount ?? 0)} categories from ${template?.label ?? draft.industry}. Existing accounts are never overwritten.`,
    },
    {
      type: "INTAKE-SEED-TASKS",
      title: "Seed the practice tasks",
      detail: `${String(catalog.length)} catalog rows, monthly, quarterly and annual, plus the first period's instances at the cutover.`,
    },
    {
      type: "INTAKE-OPEN-REQUESTS",
      title: "Raise the opening document requests",
      detail: `${String(requests.length)} asks recorded as open. Nothing is emailed, and there is no address on any of them.`,
    },
    {
      type: "SETUP-IMPORT-BALANCES",
      title: "Post the opening balances",
      detail: `One journal entry dated ${draft.cutoverDate || "the cutover"} with ${String(postedLines)} lines, offset to ${OPENING_BALANCE_EQUITY_ACCOUNT}. It foots or nothing is written.`,
    },
  ];
}

/** The mapping profiles Finish will save, and which account each is for. */
export function plannedProfiles(
  draft: WizardDraft,
): Array<{ profile: WizardProfile; accounts: string[] }> {
  return draft.profiles.map((profile) => ({
    profile,
    accounts: draft.bankAccounts
      .filter((b) => b.profileKey === profile.key)
      .map((b) => (b.nickname.trim().length > 0 ? b.nickname : b.institutionName)),
  }));
}

export interface RunReport {
  type: string;
  status: "applied" | "nothing to do" | "refused" | "not reached";
  message: string;
}

export interface FinishResult {
  ok: boolean;
  clientId: string;
  reports: RunReport[];
}

/**
 * Run the four setup runs in order and report on each.
 *
 * The real Run implementations live in server/runs and are proven by the run
 * harness. This client is the in memory mock the whole app is built on, so what
 * happens here is the mock equivalent: the client record is created, the chart
 * template choice and the cutover are recorded on it, the mapping profiles are
 * saved, and each of the four runs reports what it wrote. The order, the
 * refusal behaviour, and the offset account are the same in both places, and
 * the server suite is what holds them to it.
 */
export function finishIntake(
  draft: WizardDraft,
  create: (draft: WizardDraft, plan: FinishPlan) => string,
): FinishResult {
  const reports: RunReport[] = [];
  const footing = footingOf(draft.balanceLines);
  const chart = previewChart(draft.industry, draft.excludedAccounts, draft.addedAccounts);
  const template = templateFor(draft.industry);
  const catalog = previewCatalog([]);
  const requests = previewRequests([]);

  if (!canFinish(draft)) {
    return {
      ok: false,
      clientId: "",
      reports: INTAKE_ORDER.map((type) => ({
        type,
        status: "not reached",
        message: "the wizard has unresolved issues, so nothing was run",
      })),
    };
  }

  const plan: FinishPlan = {
    chart,
    templateId: template?.templateId ?? "",
    catalogCodes: catalog.map((c) => c.catalogCode),
    requestSubjects: requests.map((r) => r.subjectKey),
    offsetCents: footing.offsetCents,
    postedLineCount: footing.parsedCount + (footing.offsetCents === BigInt(0) ? 0 : 1),
  };

  const clientId = create(draft, plan);

  reports.push({
    type: "INTAKE-BUILD-CHART",
    status: "applied",
    message: `${String(chart.length)} accounts and ${String(template?.categoryCount ?? 0)} categories seeded from ${plan.templateId}`,
  });
  reports.push({
    type: "INTAKE-SEED-TASKS",
    status: "applied",
    message: `${String(catalog.length)} catalog rows seeded and the first period scheduled`,
  });
  reports.push({
    type: "INTAKE-OPEN-REQUESTS",
    status: "applied",
    message: `${String(requests.length)} asks raised, invite intent written to the audit log, nothing sent`,
  });
  reports.push({
    type: "SETUP-IMPORT-BALANCES",
    status: "applied",
    message: `one entry dated ${draft.cutoverDate} with ${String(plan.postedLineCount)} lines, offset ${plan.offsetCents.toString()} cents to ${OPENING_BALANCE_EQUITY_ACCOUNT}`,
  });

  return { ok: true, clientId, reports };
}

export interface FinishPlan {
  chart: readonly TemplateAccount[];
  templateId: string;
  catalogCodes: readonly string[];
  requestSubjects: readonly string[];
  offsetCents: bigint;
  postedLineCount: number;
}

/** Re exported so a page can show the forced clearing rows without a second import. */
export { MANDATORY_CLEARING_ACCOUNTS, OPENING_BALANCE_EQUITY_ACCOUNT, contraFor };
