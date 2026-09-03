import type { Account } from "./types";

// One shared chart of accounts template. Every client maps to it, which is how a
// practice keeps reporting comparable across a book of business.
export const ACCOUNTS: Account[] = [
  { id: "1010", code: "1010", name: "Operating Checking", type: "asset", subtype: "Cash and equivalents", cashLike: true },
  { id: "1020", code: "1020", name: "Reserve Savings", type: "asset", subtype: "Cash and equivalents", cashLike: true },
  { id: "1050", code: "1050", name: "Merchant Clearing", type: "asset", subtype: "Cash and equivalents", cashLike: true },
  { id: "1100", code: "1100", name: "Accounts Receivable", type: "asset", subtype: "Receivables" },
  { id: "1150", code: "1150", name: "Inventory", type: "asset", subtype: "Inventory" },
  { id: "1200", code: "1200", name: "Prepaid Expenses", type: "asset", subtype: "Other current assets" },
  { id: "1500", code: "1500", name: "Equipment and Fixtures", type: "asset", subtype: "Fixed assets" },
  { id: "1510", code: "1510", name: "Accumulated Depreciation", type: "asset", subtype: "Fixed assets", contra: true },
  // Clearing and suspense block, doc 00 Part 1. These are balance sheet holding
  // accounts. Work that is not resolved waits here where the close can see it,
  // never in an expense account where it would quietly reduce net income.
  { id: "1900", code: "1900", name: "Undeposited Funds", type: "asset", subtype: "Clearing and suspense" },
  { id: "1910", code: "1910", name: "Payment Processor Clearing", type: "asset", subtype: "Clearing and suspense" },
  { id: "1920", code: "1920", name: "Transfer Clearing", type: "asset", subtype: "Clearing and suspense" },
  { id: "1930", code: "1930", name: "Payroll Clearing", type: "asset", subtype: "Clearing and suspense" },
  { id: "1990", code: "1990", name: "Suspense", type: "asset", subtype: "Clearing and suspense", suspense: true },
  { id: "2010", code: "2010", name: "Business Credit Card", type: "liability", subtype: "Current liabilities" },
  { id: "2100", code: "2100", name: "Accounts Payable", type: "liability", subtype: "Current liabilities" },
  { id: "2200", code: "2200", name: "Sales Tax Payable", type: "liability", subtype: "Current liabilities" },
  { id: "2300", code: "2300", name: "Payroll Liabilities", type: "liability", subtype: "Current liabilities" },
  { id: "2400", code: "2400", name: "Deferred Revenue", type: "liability", subtype: "Current liabilities" },
  { id: "2500", code: "2500", name: "Equipment Loan", type: "liability", subtype: "Long term liabilities" },
  { id: "3000", code: "3000", name: "Owner Contributions", type: "equity", subtype: "Equity" },
  { id: "3100", code: "3100", name: "Owner Distributions", type: "equity", subtype: "Equity", contra: true },
  { id: "3200", code: "3200", name: "Retained Earnings", type: "equity", subtype: "Equity" },
  { id: "4000", code: "4000", name: "Product Sales", type: "revenue", subtype: "Operating revenue" },
  { id: "4010", code: "4010", name: "Service Revenue", type: "revenue", subtype: "Operating revenue" },
  { id: "4020", code: "4020", name: "Wholesale Revenue", type: "revenue", subtype: "Operating revenue" },
  { id: "4030", code: "4030", name: "Grants and Contributions", type: "revenue", subtype: "Operating revenue" },
  { id: "4900", code: "4900", name: "Refunds and Allowances", type: "revenue", subtype: "Operating revenue", contra: true },
  { id: "5000", code: "5000", name: "Cost of Goods Sold", type: "expense", subtype: "Cost of sales" },
  { id: "5050", code: "5050", name: "Subcontracted Labor", type: "expense", subtype: "Cost of sales" },
  { id: "5100", code: "5100", name: "Merchant Processing Fees", type: "expense", subtype: "Cost of sales" },
  { id: "6000", code: "6000", name: "Wages and Salaries", type: "expense", subtype: "Operating expenses" },
  { id: "6010", code: "6010", name: "Payroll Taxes", type: "expense", subtype: "Operating expenses" },
  { id: "6100", code: "6100", name: "Rent", type: "expense", subtype: "Operating expenses" },
  { id: "6110", code: "6110", name: "Utilities", type: "expense", subtype: "Operating expenses" },
  { id: "6120", code: "6120", name: "Insurance", type: "expense", subtype: "Operating expenses" },
  { id: "6130", code: "6130", name: "Software Subscriptions", type: "expense", subtype: "Operating expenses" },
  { id: "6140", code: "6140", name: "Advertising", type: "expense", subtype: "Operating expenses" },
  { id: "6160", code: "6160", name: "Repairs and Maintenance", type: "expense", subtype: "Operating expenses" },
  { id: "6170", code: "6170", name: "Vehicle and Fuel", type: "expense", subtype: "Operating expenses" },
  { id: "6180", code: "6180", name: "Supplies", type: "expense", subtype: "Operating expenses" },
  { id: "6190", code: "6190", name: "Professional Fees", type: "expense", subtype: "Operating expenses" },
  { id: "6200", code: "6200", name: "Bank Service Charges", type: "expense", subtype: "Operating expenses" },
  { id: "6210", code: "6210", name: "Meals", type: "expense", subtype: "Operating expenses" },
  { id: "6220", code: "6220", name: "Travel", type: "expense", subtype: "Operating expenses" },
  { id: "6300", code: "6300", name: "Depreciation", type: "expense", subtype: "Operating expenses" },
  { id: "7000", code: "7000", name: "Interest Expense", type: "expense", subtype: "Other expense" },
];

// The one suspense account. Doc 00 puts unresolved work in 1990 on the balance sheet.
export const SUSPENSE_ACCOUNT_ID = "1990";

// Accounts gate G01 requires at zero before a period can close.
export const G01_ACCOUNT_IDS = ["1910", "1920", "1930", "1990"];

export const ACCOUNT_BY_ID: Record<string, Account> = Object.fromEntries(
  ACCOUNTS.map((a) => [a.id, a]),
);

export function acct(id: string): Account {
  return ACCOUNT_BY_ID[id];
}

export function acctLabel(id: string): string {
  const a = ACCOUNT_BY_ID[id];
  return a ? `${a.code} ${a.name}` : id;
}

// Cash flow classification for the direct method statement.
export const CASH_FLOW_CLASS: Record<string, "operating" | "investing" | "financing"> = {
  "1100": "operating",
  "1150": "operating",
  "1200": "operating",
  "1900": "operating",
  "1910": "operating",
  "1920": "operating",
  "1930": "operating",
  "1990": "operating",
  "1500": "investing",
  "1510": "investing",
  "2010": "operating",
  "2100": "operating",
  "2200": "operating",
  "2300": "operating",
  "2400": "operating",
  "2500": "financing",
  "3000": "financing",
  "3100": "financing",
  "3200": "financing",
};

export function cashFlowClass(accountId: string): "operating" | "investing" | "financing" {
  const explicit = CASH_FLOW_CLASS[accountId];
  if (explicit) return explicit;
  return "operating";
}

export const BS_SECTIONS: { key: string; label: string; subtypes: string[] }[] = [
  { key: "current_assets", label: "Current assets", subtypes: ["Cash and equivalents", "Clearing and suspense", "Receivables", "Inventory", "Other current assets"] },
  { key: "fixed_assets", label: "Fixed assets", subtypes: ["Fixed assets"] },
  { key: "current_liabilities", label: "Current liabilities", subtypes: ["Current liabilities"] },
  { key: "long_term", label: "Long term liabilities", subtypes: ["Long term liabilities"] },
  { key: "equity", label: "Equity", subtypes: ["Equity"] },
];
