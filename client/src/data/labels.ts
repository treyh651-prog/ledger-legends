export const SCOPE_LABELS: Record<string, string> = {
  ap: "Accounts payable",
  ar: "Accounts receivable",
  payroll_je: "Payroll entries",
  sales_tax: "Sales tax",
  form_1099: "1099 filing",
  monthly_close: "Monthly close",
  cleanup: "Cleanup project",
  setup: "Setup",
};

export const SCOPE_OPTIONS: { key: string; label: string; blurb: string }[] = [
  { key: "monthly_close", label: "Monthly close", blurb: "Reconcile every account, post accruals, and issue statements." },
  { key: "ap", label: "Accounts payable", blurb: "Enter bills, run the aging, prepare a payment run." },
  { key: "ar", label: "Accounts receivable", blurb: "Issue invoices, apply receipts, chase past due balances." },
  { key: "payroll_je", label: "Payroll entries", blurb: "Book each payroll run and tie the liability accounts." },
  { key: "sales_tax", label: "Sales tax", blurb: "Reconcile taxable sales and prepare the filing worksheet." },
  { key: "form_1099", label: "1099 filing", blurb: "Track W-9 collection and prepare January filings." },
  { key: "cleanup", label: "Cleanup project", blurb: "Rebuild prior months before the recurring work starts." },
];

export const DOC_TYPES = [
  "Bank statement",
  "Credit card statement",
  "Receipt",
  "Vendor bill",
  "Customer invoice",
  "Payroll report",
  "Loan statement",
  "Merchant processor report",
  "Sales tax filing",
  "W-9",
  "Signed agreement",
  "Other",
];

export const ENTITY_TYPES = ["Sole Prop", "Partnership", "LLC", "S Corp", "C Corp", "Nonprofit"];

export const SYSTEM_KINDS = ["Accounting software", "Point of sale", "E commerce", "Payroll", "Other"];

export const ACCESS_STATUSES = ["No access", "Read only requested", "Read only granted", "Admin"];

export const BANK_KINDS = ["Checking", "Savings", "Credit card", "Loan", "Merchant processor"];

export const STATEMENT_SOURCES = ["Bank feed", "Portal", "CSV mapping", "PDF upload"];

export const CONTACT_ROLES = ["Owner", "Controller", "Office manager", "Operations lead", "Board treasurer", "Bookkeeper"];

export const TASK_STATUSES = ["Not started", "In progress", "Blocked", "Review", "Done"] as const;
