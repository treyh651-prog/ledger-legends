/**
 * The standard chart templates the intake wizard previews, and the practice
 * catalog and document request lists it says it will seed.
 *
 * This file is a mirror of server/runs/runs/intake-shared.ts, generated from it
 * so the two cannot disagree about an account number. The wizard shows what the
 * runs will write. It does not decide it, and nothing here is a second source
 * of truth: if a number moves on the server it has to be regenerated here, and
 * a mismatch is a defect rather than a preference.
 *
 * COMPLIANCE. A template picks which accounts a set of books opens with. It is
 * a bookkeeping convenience and never a statement about how a business ought to
 * be organised or taxed.
 *
 * CONSTRAINT. No model and no inference anywhere in this file. Every list below
 * is a literal, and the only arithmetic is the integer account block comparison
 * in blockOf.
 */

/** The engagement scope answers a template row may be conditioned on. */
export type ScopeKey =
  | "always"
  | "inventory"
  | "fixed_assets"
  | "payroll"
  | "vehicles"
  | "rentals";

export interface TemplateAccount {
  accountNumber: string;
  name: string;
  normalSide: "debit" | "credit";
  scopeKey: ScopeKey;
}

export interface ChartTemplate {
  /** The word the wizard puts in the URL and hands to the run. */
  industry: string;
  /** The published template id the run resolves the word to. */
  templateId: string;
  label: string;
  /** How many category rows the run will seed alongside the accounts. */
  categoryCount: number;
  accounts: readonly TemplateAccount[];
}

/** Doc 00 Part 1. These five are on every chart whatever the template says. */
export const MANDATORY_CLEARING_ACCOUNTS: readonly string[] = [
  "1900",
  "1910",
  "1920",
  "1930",
  "1990",
];

/** Doc 01 Part 2.4. The account every opening balance entry offsets to. */
export const OPENING_BALANCE_EQUITY_ACCOUNT = "3900";

export const CHART_TEMPLATES: readonly ChartTemplate[] = [
  {
    industry: "services",
    templateId: "TPL-SERVICE-STUDIO",
    label: "Services and studio",
    categoryCount: 65,
    accounts: [
      { accountNumber: "1000", name: "Operating checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1010", name: "Payroll checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1020", name: "Savings and reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1030", name: "Petty cash", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1100", name: "Accounts receivable, trade", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1190", name: "Allowance for doubtful accounts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1200", name: "Inventory, finished ware", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1210", name: "Inventory, materials and supplies", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1230", name: "Inventory, resale goods from other makers", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1300", name: "Prepaid insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1310", name: "Prepaid software and subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1390", name: "Other prepaid and current assets", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1400", name: "Employee advances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1410", name: "Other receivables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1500", name: "Furniture and fixtures", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1510", name: "Computer and office equipment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1520", name: "Leasehold improvements", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1530", name: "Studio and production equipment", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1540", name: "Tools and small machinery", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1600", name: "Accumulated depreciation, furniture and fixtures", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1610", name: "Accumulated depreciation, computer and office equipment", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1620", name: "Accumulated amortization, leasehold improvements", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1630", name: "Accumulated depreciation, studio and production equipment", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1640", name: "Accumulated depreciation, tools and small machinery", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1800", name: "Security deposits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1900", name: "Undeposited funds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1910", name: "Payment processor clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1920", name: "Transfer clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1930", name: "Payroll clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1990", name: "Suspense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "2000", name: "Accounts payable, trade", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2100", name: "Credit card payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2110", name: "Line of credit", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2200", name: "Accrued expenses", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2210", name: "Accrued interest payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2300", name: "Wages and salaries payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2310", name: "Payroll taxes payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2320", name: "Employee withholdings and benefit deductions payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2400", name: "Sales and use tax payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2500", name: "Deferred revenue and customer deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2510", name: "Gift certificates outstanding", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2520", name: "Unearned class and workshop tuition", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2600", name: "Current portion of long term debt", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2700", name: "Notes payable, long term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2900", name: "Due to related parties", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3000", name: "Owner capital", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3100", name: "Owner contributions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3200", name: "Owner draws", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "3900", name: "Accumulated earnings, prior years", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4000", name: "Service revenue, studio and direct", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4010", name: "Service revenue, online marketplace", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4020", name: "Service revenue, own website", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4100", name: "Wholesale and consignment revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4200", name: "Class and workshop tuition", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4300", name: "Commission and custom work", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4400", name: "Membership, shelf rental, and usage fees", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4500", name: "Teaching, residency, and guest fees", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4900", name: "Sales discounts and allowances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4910", name: "Returns and refunds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5000", name: "Cost of services, materials", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5010", name: "Production energy and utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5020", name: "Packaging and shipping materials", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5030", name: "Production loss, breakage and seconds", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "5040", name: "Outbound shipping cost", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6000", name: "Advertising and marketing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6010", name: "Bank service charges", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6020", name: "Merchant and payment processing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6030", name: "Licenses, registrations, and filing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6040", name: "Software and cloud subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6050", name: "Dues and memberships", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6060", name: "Insurance, general business", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6070", name: "Meals, subject to the 50 percent limit", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6080", name: "Office supplies", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6090", name: "Postage and courier", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6100", name: "Accounting and bookkeeping fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6110", name: "Legal fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6120", name: "Consulting and other professional fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6130", name: "Rent, facility", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6140", name: "Repairs and maintenance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6150", name: "Tools and equipment below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6160", name: "Telephone and internet", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6170", name: "Travel", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6180", name: "Utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6190", name: "Training and continuing education", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6300", name: "Wages and salaries", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6310", name: "Payroll taxes, employer", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6320", name: "Employee benefits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6330", name: "Workers compensation insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6340", name: "Contract labor and outside services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6420", name: "Online platform and marketplace fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6430", name: "Photography and listing services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6440", name: "Shared studio and equipment access fees paid to others", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6450", name: "Market, fair, and booth fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6460", name: "Consignment and gallery commissions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6800", name: "Depreciation expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6810", name: "Amortization expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6900", name: "Bad debt expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7900", name: "Penalties and fines, nondeductible", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7910", name: "Other nondeductible expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8000", name: "Interest income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8100", name: "Interest expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8200", name: "Gain or loss on disposal of assets", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8900", name: "Other income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "9000", name: "State income and franchise tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9900", name: "Memo, book to tax differences", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9910", name: "Memo, owner or shareholder basis tracking", normalSide: "debit", scopeKey: "always" },
    ],
  },
  {
    industry: "product",
    templateId: "TPL-RETAIL-WHOLESALE",
    label: "Product, retail and wholesale",
    categoryCount: 60,
    accounts: [
      { accountNumber: "1000", name: "Operating checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1010", name: "Payroll checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1020", name: "Savings and reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1030", name: "Petty cash", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1100", name: "Accounts receivable, trade", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1190", name: "Allowance for doubtful accounts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1200", name: "Inventory, raw goods", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1210", name: "Inventory, finished goods", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1220", name: "Inventory, packaging and shipping supplies", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1230", name: "Inventory, merchandise for resale", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1290", name: "Inventory valuation reserve, shrink and obsolescence", normalSide: "credit", scopeKey: "inventory" },
      { accountNumber: "1300", name: "Prepaid insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1310", name: "Prepaid software and subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1390", name: "Other prepaid and current assets", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1400", name: "Employee advances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1410", name: "Other receivables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1500", name: "Furniture and fixtures", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1510", name: "Computer and office equipment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1520", name: "Leasehold improvements", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1530", name: "Production equipment", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1540", name: "Delivery vehicles", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1600", name: "Accumulated depreciation, furniture and fixtures", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1610", name: "Accumulated depreciation, computer and office equipment", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1620", name: "Accumulated amortization, leasehold improvements", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1630", name: "Accumulated depreciation, production equipment", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1640", name: "Accumulated depreciation, delivery vehicles", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1800", name: "Security deposits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1900", name: "Undeposited funds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1910", name: "Payment processor clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1920", name: "Transfer clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1930", name: "Payroll clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1990", name: "Suspense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "2000", name: "Accounts payable, trade", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2100", name: "Credit card payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2110", name: "Line of credit", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2200", name: "Accrued expenses", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2210", name: "Accrued interest payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2300", name: "Wages and salaries payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2310", name: "Payroll taxes payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2320", name: "Employee withholdings and benefit deductions payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2400", name: "Sales and use tax payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2500", name: "Deferred revenue and customer deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2510", name: "Gift card and stored value liability", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2520", name: "Wholesale customer deposits and prepayments", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2600", name: "Current portion of long term debt", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2700", name: "Notes payable, long term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2900", name: "Due to related parties", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3000", name: "Member contributions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3100", name: "Member distributions and draws", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "3900", name: "Accumulated earnings, prior years", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4000", name: "Wholesale revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4010", name: "Wholesale revenue, private label", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4100", name: "Retail revenue, direct", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4110", name: "Retail revenue, online", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4120", name: "Retail revenue, subscription", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4200", name: "Merchandise and equipment revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4300", name: "Shipping and handling billed to customers", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4900", name: "Sales discounts and allowances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4910", name: "Returns and refunds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5000", name: "Cost of goods sold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5010", name: "Inventory shrink, spoilage, and adjustments", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "5020", name: "Outbound shipping and fulfillment cost", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6000", name: "Advertising and marketing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6010", name: "Bank service charges", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6020", name: "Merchant and payment processing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6030", name: "Licenses, registrations, and filing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6040", name: "Software and cloud subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6050", name: "Dues and memberships", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6060", name: "Insurance, general business", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6070", name: "Meals, subject to the 50 percent limit", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6080", name: "Office supplies", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6090", name: "Postage and courier", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6100", name: "Accounting and bookkeeping fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6110", name: "Legal fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6120", name: "Consulting and other professional fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6130", name: "Rent, facility", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6140", name: "Repairs and maintenance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6150", name: "Tools and equipment below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6160", name: "Telephone and internet", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6170", name: "Travel", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6180", name: "Utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6190", name: "Training and continuing education", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6300", name: "Wages and salaries", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6310", name: "Payroll taxes, employer", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6320", name: "Employee benefits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6330", name: "Workers compensation insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6340", name: "Contract labor and outside services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6400", name: "Wholesale commissions and broker fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6410", name: "Trade shows, markets, and sampling", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6420", name: "Online sales channel and marketplace fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6500", name: "Vehicle fuel", normalSide: "debit", scopeKey: "vehicles" },
      { accountNumber: "6510", name: "Vehicle repairs and maintenance", normalSide: "debit", scopeKey: "vehicles" },
      { accountNumber: "6520", name: "Vehicle insurance and registration", normalSide: "debit", scopeKey: "vehicles" },
      { accountNumber: "6530", name: "Retail supplies, not for resale", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6800", name: "Depreciation expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6810", name: "Amortization expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6900", name: "Bad debt expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7900", name: "Penalties and fines, nondeductible", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7910", name: "Other nondeductible expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8000", name: "Interest income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8100", name: "Interest expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8200", name: "Gain or loss on disposal of assets", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8900", name: "Other income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "9000", name: "State income and franchise tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9900", name: "Memo, book to tax differences", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9910", name: "Memo, owner or shareholder basis tracking", normalSide: "debit", scopeKey: "always" },
    ],
  },
  {
    industry: "restaurant",
    templateId: "TPL-RESTAURANT",
    label: "Restaurant and food service",
    categoryCount: 55,
    accounts: [
      { accountNumber: "1000", name: "Operating checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1010", name: "Payroll checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1020", name: "Savings and reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1030", name: "Petty cash", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1100", name: "Accounts receivable, trade", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1190", name: "Allowance for doubtful accounts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1200", name: "Inventory, food", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1210", name: "Inventory, beverage and alcohol", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1220", name: "Inventory, paper and disposables", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1300", name: "Prepaid insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1310", name: "Prepaid software and subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1390", name: "Other prepaid and current assets", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1400", name: "Employee advances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1410", name: "Other receivables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1500", name: "Furniture and fixtures", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1510", name: "Computer and office equipment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1520", name: "Leasehold improvements", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1530", name: "Kitchen equipment", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1540", name: "Furniture, fixtures, and smallwares", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1600", name: "Accumulated depreciation, furniture and fixtures", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1610", name: "Accumulated depreciation, computer and office equipment", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1620", name: "Accumulated amortization, leasehold improvements", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1630", name: "Accumulated depreciation, kitchen equipment", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1640", name: "Accumulated depreciation, furniture, fixtures, and smallwares", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1800", name: "Security deposits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1900", name: "Undeposited funds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1910", name: "Payment processor clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1920", name: "Transfer clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1930", name: "Payroll clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1990", name: "Suspense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "2000", name: "Accounts payable, trade", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2100", name: "Credit card payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2110", name: "Line of credit", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2200", name: "Accrued expenses", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2210", name: "Accrued interest payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2300", name: "Wages and salaries payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2310", name: "Payroll taxes payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2320", name: "Employee withholdings and benefit deductions payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2330", name: "Tips payable to staff", normalSide: "credit", scopeKey: "payroll" },
      { accountNumber: "2400", name: "Sales and use tax payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2500", name: "Deferred revenue and customer deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2510", name: "Gift card and stored value liability", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2520", name: "Catering and event deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2600", name: "Current portion of long term debt", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2700", name: "Notes payable, long term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2900", name: "Due to related parties", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3000", name: "Member contributions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3100", name: "Member distributions and draws", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "3900", name: "Accumulated earnings, prior years", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4000", name: "Food revenue, dine in", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4010", name: "Food revenue, takeout and delivery", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4100", name: "Beverage revenue, non alcoholic", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4110", name: "Beverage revenue, beer, wine, and spirits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4200", name: "Catering and private event revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4300", name: "Merchandise and retail revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4900", name: "Sales discounts and allowances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4910", name: "Returns and refunds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4920", name: "Comps, voids, and employee meals", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5000", name: "Cost of sales, food", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5010", name: "Cost of sales, beverage", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5020", name: "Cost of sales, paper and disposables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "5030", name: "Inventory waste and spoilage", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "6000", name: "Advertising and marketing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6010", name: "Bank service charges", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6020", name: "Merchant and payment processing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6030", name: "Licenses, registrations, and filing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6040", name: "Software and cloud subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6050", name: "Dues and memberships", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6060", name: "Insurance, general business", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6070", name: "Meals, subject to the 50 percent limit", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6080", name: "Office supplies", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6090", name: "Postage and courier", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6100", name: "Accounting and bookkeeping fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6110", name: "Legal fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6120", name: "Consulting and other professional fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6130", name: "Rent, facility", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6140", name: "Repairs and maintenance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6150", name: "Tools and equipment below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6160", name: "Telephone and internet", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6170", name: "Travel", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6180", name: "Utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6190", name: "Training and continuing education", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6300", name: "Wages and salaries", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6310", name: "Payroll taxes, employer", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6320", name: "Employee benefits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6330", name: "Workers compensation insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6340", name: "Contract labor and outside services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6400", name: "Delivery platform commissions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6410", name: "Linen, laundry, and uniforms", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6420", name: "Kitchen smallwares below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6430", name: "Cleaning, sanitation, and pest control", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6440", name: "Music, entertainment, and licensing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6450", name: "Health permits and food safety certification", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6800", name: "Depreciation expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6810", name: "Amortization expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6900", name: "Bad debt expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7900", name: "Penalties and fines, nondeductible", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7910", name: "Other nondeductible expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8000", name: "Interest income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8100", name: "Interest expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8200", name: "Gain or loss on disposal of assets", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8900", name: "Other income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "9000", name: "State income and franchise tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9900", name: "Memo, book to tax differences", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9910", name: "Memo, owner or shareholder basis tracking", normalSide: "debit", scopeKey: "always" },
    ],
  },
  {
    industry: "real_estate",
    templateId: "TPL-REAL-ESTATE",
    label: "Real estate and rentals",
    categoryCount: 55,
    accounts: [
      { accountNumber: "1000", name: "Operating checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1010", name: "Payroll checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1020", name: "Savings and reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1030", name: "Petty cash", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1100", name: "Accounts receivable, trade", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1150", name: "Tenant receivables", normalSide: "debit", scopeKey: "rentals" },
      { accountNumber: "1160", name: "Escrow and impound accounts", normalSide: "debit", scopeKey: "rentals" },
      { accountNumber: "1190", name: "Allowance for doubtful accounts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1300", name: "Prepaid insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1310", name: "Prepaid software and subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1390", name: "Other prepaid and current assets", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1400", name: "Employee advances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1410", name: "Other receivables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1500", name: "Furniture and fixtures", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1510", name: "Computer and office equipment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1520", name: "Leasehold improvements", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1560", name: "Land", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1570", name: "Buildings and improvements", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1580", name: "Land improvements", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1600", name: "Accumulated depreciation, furniture and fixtures", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1610", name: "Accumulated depreciation, computer and office equipment", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1620", name: "Accumulated amortization, leasehold improvements", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1670", name: "Accumulated depreciation, buildings and improvements", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1680", name: "Accumulated depreciation, land improvements", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1800", name: "Security deposits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1900", name: "Undeposited funds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1910", name: "Payment processor clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1920", name: "Transfer clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1930", name: "Payroll clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1990", name: "Suspense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "2000", name: "Accounts payable, trade", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2100", name: "Credit card payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2110", name: "Line of credit", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2200", name: "Accrued expenses", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2210", name: "Accrued interest payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2300", name: "Wages and salaries payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2310", name: "Payroll taxes payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2320", name: "Employee withholdings and benefit deductions payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2400", name: "Sales and use tax payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2450", name: "Tenant security deposits held", normalSide: "credit", scopeKey: "rentals" },
      { accountNumber: "2460", name: "Prepaid rent received", normalSide: "credit", scopeKey: "rentals" },
      { accountNumber: "2500", name: "Deferred revenue and customer deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2600", name: "Current portion of long term debt", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2700", name: "Notes payable, long term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2710", name: "Mortgages payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2900", name: "Due to related parties", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3000", name: "Member contributions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3100", name: "Member distributions and draws", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "3900", name: "Accumulated earnings, prior years", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4000", name: "Rental revenue, residential", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4010", name: "Rental revenue, commercial", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4020", name: "Rental revenue, short term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4100", name: "Tenant reimbursements and common area recovery", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4200", name: "Late fees and other tenant charges", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4300", name: "Assignment fee revenue", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4400", name: "Gain on sale of real property", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4900", name: "Sales discounts and allowances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4910", name: "Returns and refunds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6000", name: "Advertising and marketing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6010", name: "Bank service charges", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6020", name: "Merchant and payment processing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6030", name: "Licenses, registrations, and filing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6040", name: "Software and cloud subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6050", name: "Dues and memberships", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6060", name: "Insurance, general business", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6070", name: "Meals, subject to the 50 percent limit", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6080", name: "Office supplies", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6090", name: "Postage and courier", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6100", name: "Accounting and bookkeeping fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6110", name: "Legal fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6120", name: "Consulting and other professional fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6130", name: "Rent, facility", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6140", name: "Repairs and maintenance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6150", name: "Tools and equipment below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6160", name: "Telephone and internet", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6170", name: "Travel", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6180", name: "Utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6190", name: "Training and continuing education", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6300", name: "Wages and salaries", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6310", name: "Payroll taxes, employer", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6320", name: "Employee benefits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6330", name: "Workers compensation insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6340", name: "Contract labor and outside services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6700", name: "Property management fees", normalSide: "debit", scopeKey: "rentals" },
      { accountNumber: "6710", name: "Leasing commissions and tenant placement", normalSide: "debit", scopeKey: "rentals" },
      { accountNumber: "6720", name: "Property taxes", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6730", name: "Property insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6740", name: "Homeowners association and common area dues", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6750", name: "Turnover, make ready, and cleaning", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6760", name: "Landscaping and snow removal", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6770", name: "Eviction, collection, and legal costs", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6780", name: "Acquisition due diligence and inspection costs", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6800", name: "Depreciation expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6810", name: "Amortization expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6900", name: "Bad debt expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7900", name: "Penalties and fines, nondeductible", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7910", name: "Other nondeductible expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8000", name: "Interest income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8100", name: "Interest expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8200", name: "Gain or loss on disposal of assets", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8900", name: "Other income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "9000", name: "State income and franchise tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9900", name: "Memo, book to tax differences", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9910", name: "Memo, owner or shareholder basis tracking", normalSide: "debit", scopeKey: "always" },
    ],
  },
  {
    industry: "nonprofit",
    templateId: "TPL-NONPROFIT",
    label: "Nonprofit",
    categoryCount: 66,
    accounts: [
      { accountNumber: "1000", name: "Operating checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1010", name: "Payroll checking", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1020", name: "Savings and reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1030", name: "Petty cash", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1040", name: "Cash, restricted for donor restricted purposes", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1050", name: "Cash, board designated reserve", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1100", name: "Accounts receivable, trade", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1110", name: "Pledges receivable", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1120", name: "Discount and allowance on pledges receivable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1130", name: "Grants and contracts receivable", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1190", name: "Allowance for doubtful accounts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1230", name: "Inventory, gift shop and program merchandise", normalSide: "debit", scopeKey: "inventory" },
      { accountNumber: "1300", name: "Prepaid insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1310", name: "Prepaid software and subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1390", name: "Other prepaid and current assets", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1400", name: "Employee advances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1410", name: "Other receivables", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1500", name: "Furniture and fixtures", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1510", name: "Computer and office equipment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1520", name: "Leasehold improvements", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1530", name: "Studio, classroom, and program equipment", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1540", name: "Instruments and program technology", normalSide: "debit", scopeKey: "fixed_assets" },
      { accountNumber: "1600", name: "Accumulated depreciation, furniture and fixtures", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1610", name: "Accumulated depreciation, computer and office equipment", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1620", name: "Accumulated amortization, leasehold improvements", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "1630", name: "Accumulated depreciation, studio, classroom, and program equipment", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1640", name: "Accumulated depreciation, instruments and program technology", normalSide: "credit", scopeKey: "fixed_assets" },
      { accountNumber: "1800", name: "Security deposits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1820", name: "Investments, donor restricted endowment", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1900", name: "Undeposited funds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1910", name: "Payment processor clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1920", name: "Transfer clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1930", name: "Payroll clearing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "1990", name: "Suspense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "2000", name: "Accounts payable, trade", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2100", name: "Credit card payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2110", name: "Line of credit", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2200", name: "Accrued expenses", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2210", name: "Accrued interest payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2300", name: "Wages and salaries payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2310", name: "Payroll taxes payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2320", name: "Employee withholdings and benefit deductions payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2340", name: "Accrued paid time off", normalSide: "credit", scopeKey: "payroll" },
      { accountNumber: "2400", name: "Sales and use tax payable", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2500", name: "Deferred revenue and customer deposits", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2530", name: "Refundable advances, conditional grants and contributions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2540", name: "Deferred revenue, exchange transactions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2600", name: "Current portion of long term debt", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2700", name: "Notes payable, long term", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "2900", name: "Due to related parties", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3000", name: "Net assets without donor restrictions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "3100", name: "Net assets with donor restrictions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4000", name: "Contributions, individual", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4010", name: "Contributions, corporate and business", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4020", name: "Contributions in kind, goods", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4030", name: "Contributions in kind, services and use of facilities", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4100", name: "Foundation and private grants", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4110", name: "Government grants and contracts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4200", name: "Program service revenue, tuition and class fees", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4210", name: "Program service revenue, tickets and performances", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4220", name: "Program service revenue, school and agency contracts", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4300", name: "Special event revenue, contribution portion", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4310", name: "Special event revenue, exchange portion", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4320", name: "Direct benefit to donors", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4400", name: "Membership dues", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4500", name: "Gift shop and merchandise sales", normalSide: "credit", scopeKey: "inventory" },
      { accountNumber: "4700", name: "Net assets released from restrictions, without donor restrictions", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "4710", name: "Net assets released from restrictions, with donor restrictions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4900", name: "Sales discounts and allowances", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "4910", name: "Returns and refunds", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6000", name: "Advertising and marketing", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6010", name: "Bank service charges", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6020", name: "Merchant and payment processing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6030", name: "Licenses, registrations, and filing fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6040", name: "Software and cloud subscriptions", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6050", name: "Dues and memberships", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6060", name: "Insurance, general business", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6070", name: "Meals, subject to the 50 percent limit", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6080", name: "Office supplies", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6090", name: "Postage and courier", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6100", name: "Accounting and bookkeeping fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6110", name: "Legal fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6120", name: "Consulting and other professional fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6130", name: "Rent, facility", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6140", name: "Repairs and maintenance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6150", name: "Tools and equipment below the capitalization threshold", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6160", name: "Telephone and internet", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6170", name: "Travel", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6180", name: "Utilities", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6190", name: "Training and continuing education", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6300", name: "Wages and salaries", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6310", name: "Payroll taxes, employer", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6320", name: "Employee benefits", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6330", name: "Workers compensation insurance", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6340", name: "Contract labor and outside services", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6800", name: "Depreciation expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6810", name: "Amortization expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "6900", name: "Bad debt expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7000", name: "Grants, scholarships, and awards to others", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7010", name: "Program supplies and materials", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7020", name: "Teaching artist and instructor fees", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7030", name: "Student transportation", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7040", name: "Venue, rehearsal, and exhibition space rental", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7050", name: "Special event production costs", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7060", name: "Donor and constituent management software", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7070", name: "Board and volunteer expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7080", name: "Audit and annual information return preparation", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7090", name: "Insurance, directors and officers", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7900", name: "Penalties and fines, nondeductible", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "7910", name: "Other nondeductible expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8000", name: "Interest income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8010", name: "Realized and unrealized gain and loss on investments", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8100", name: "Interest expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "8200", name: "Gain or loss on disposal of assets", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "8900", name: "Other income", normalSide: "credit", scopeKey: "always" },
      { accountNumber: "9000", name: "State income and franchise tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9200", name: "Unrelated business income tax expense", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9900", name: "Memo, book to tax differences", normalSide: "debit", scopeKey: "always" },
      { accountNumber: "9910", name: "Memo, owner or shareholder basis tracking", normalSide: "debit", scopeKey: "always" },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* What the setup runs will seed, so the review step can list it              */
/* -------------------------------------------------------------------------- */

export interface CatalogPreview {
  catalogCode: string;
  title: string;
  role: string;
  frequency: "monthly" | "quarterly" | "annual";
  dueOffsetDays: number;
  scopeKey: string | null;
}

export const STANDARD_CATALOG_PREVIEW: readonly CatalogPreview[] = [
  {
    catalogCode: "MC-01-IMPORT",
    title: "Import and stage bank activity for the period",
    role: "preparer",
    frequency: "monthly",
    dueOffsetDays: 3,
    scopeKey: null,
  },
  {
    catalogCode: "MC-02-CODE",
    title: "Code the register and clear suspense",
    role: "preparer",
    frequency: "monthly",
    dueOffsetDays: 6,
    scopeKey: null,
  },
  {
    catalogCode: "MC-03-RECONCILE",
    title: "Reconcile every bank and card account",
    role: "preparer",
    frequency: "monthly",
    dueOffsetDays: 9,
    scopeKey: null,
  },
  {
    catalogCode: "MC-04-SUBLEDGER",
    title: "Tie the subledgers to the control accounts",
    role: "preparer",
    frequency: "monthly",
    dueOffsetDays: 11,
    scopeKey: null,
  },
  {
    catalogCode: "MC-05-REVIEW",
    title: "Review the close package and sign it off",
    role: "reviewer",
    frequency: "monthly",
    dueOffsetDays: 14,
    scopeKey: null,
  },
  {
    catalogCode: "MC-06-DELIVER",
    title: "Deliver the monthly package to the client portal",
    role: "preparer",
    frequency: "monthly",
    dueOffsetDays: 16,
    scopeKey: null,
  },
  {
    catalogCode: "QR-01-REVIEW",
    title: "Quarterly review of balances, accruals, and estimates",
    role: "reviewer",
    frequency: "quarterly",
    dueOffsetDays: 20,
    scopeKey: null,
  },
  {
    catalogCode: "QR-02-SALES-TAX",
    title: "Quarterly sales and use tax reconciliation",
    role: "preparer",
    frequency: "quarterly",
    dueOffsetDays: 20,
    scopeKey: "sales_tax",
  },
  {
    catalogCode: "AC-01-TRIAL-BALANCE",
    title: "Annual close, final trial balance and adjusting entries",
    role: "preparer",
    frequency: "annual",
    dueOffsetDays: 30,
    scopeKey: null,
  },
  {
    catalogCode: "AC-02-HANDOFF",
    title: "Annual close, build the accountant handoff package",
    role: "reviewer",
    frequency: "annual",
    dueOffsetDays: 40,
    scopeKey: null,
  },
  {
    catalogCode: "AC-03-1099",
    title: "Annual information return data set for vendor payments",
    role: "preparer",
    frequency: "annual",
    dueOffsetDays: 31,
    scopeKey: "form_1099",
  },
];

export interface RequestPreview {
  subjectKey: string;
  catalogCode: string;
  owner: string;
  detail: string;
}

/** Doc 02 module 1. The six things a new client is asked for on day one. */
export const STANDARD_REQUEST_PREVIEW: readonly RequestPreview[] = [
  {
    subjectKey: "articles-of-incorporation",
    catalogCode: "REQ-FORMATION",
    owner: "client",
    detail: "Formation document on file with the state, articles of incorporation or articles of organization. Needed to record the legal name and the formation date on the client record.",
  },
  {
    subjectKey: "chart-of-authorization",
    catalogCode: "REQ-AUTHORITY",
    owner: "client",
    detail: "Chart of authorization naming who may approve a payment and who may approve a journal entry, with the dollar limits that apply to each.",
  },
  {
    subjectKey: "ein-letter",
    catalogCode: "REQ-EIN",
    owner: "client",
    detail: "Employer identification number assignment letter. Needed so the number on the books matches the number of record.",
  },
  {
    subjectKey: "opening-bank-statements",
    catalogCode: "REQ-OPENING-STATEMENTS",
    owner: "client",
    detail: "Bank and card statements covering the cutover date for every account in scope, so the opening cash balance can be agreed to a statement.",
  },
  {
    subjectKey: "prior-year-trial-balance",
    catalogCode: "REQ-PRIOR-TB",
    owner: "client",
    detail: "Final trial balance for the year before the cutover date, from the prior bookkeeper or accountant, in a spreadsheet or a report export.",
  },
  {
    subjectKey: "w9-owner",
    catalogCode: "REQ-W9",
    owner: "client",
    detail: "Signed Form W-9 for the owner of record, held in the vault for the vendor and information reporting file.",
  },
];

/* -------------------------------------------------------------------------- */
/* Lookups and the account block rules                                        */
/* -------------------------------------------------------------------------- */

export function templateFor(industry: string): ChartTemplate | undefined {
  return CHART_TEMPLATES.find((t) => t.industry === industry);
}

/** The five words step 1 offers, in the order it offers them. */
export const INDUSTRY_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  CHART_TEMPLATES.map((t) => ({ value: t.industry, label: t.label }));

/**
 * Doc 00 Part 1. The account blocks, used only to group the preview so a person
 * reading step 3 can find the cash accounts without scrolling past the whole
 * chart. Integer comparison on a four digit number, nothing more.
 */
export function blockOf(accountNumber: string): string {
  const n = Number.parseInt(accountNumber, 10);
  if (Number.isNaN(n)) return "Other";
  if (n < 1100) return "Cash";
  if (n < 1200) return "Receivables";
  if (n < 1300) return "Inventory";
  if (n < 1500) return "Prepaid and other current";
  if (n < 1600) return "Fixed assets";
  if (n < 1900) return "Accumulated depreciation";
  if (n < 2000) return "Clearing and suspense";
  if (n < 3000) return "Liabilities";
  if (n < 4000) return "Equity";
  if (n < 5000) return "Revenue";
  if (n < 6000) return "Cost of goods sold";
  if (n < 8000) return "Operating expenses";
  if (n < 9000) return "Other income and expense";
  return "Tax and memo";
}

/** The order the blocks are shown in, which is account number order. */
export const BLOCK_ORDER: readonly string[] = [
  "Cash",
  "Receivables",
  "Inventory",
  "Prepaid and other current",
  "Fixed assets",
  "Accumulated depreciation",
  "Clearing and suspense",
  "Liabilities",
  "Equity",
  "Revenue",
  "Cost of goods sold",
  "Operating expenses",
  "Other income and expense",
  "Tax and memo",
  "Other",
];

/**
 * Doc 00 Part 1. Accumulated depreciation is the cost account plus one hundred.
 * Only 1500 through 1599 has a contra, and the answer is a number rather than a
 * guess, so an added fixed asset row on step 3 can be paired straight away.
 */
export function contraFor(accountNumber: string): string | null {
  const n = Number.parseInt(accountNumber, 10);
  if (Number.isNaN(n) || n < 1500 || n > 1599) return null;
  return String(n + 100);
}

/**
 * The accounts a template produces once the excluded rows are struck and the
 * added rows are folded in. A struck clearing account is put back, because the
 * run puts it back and step 3 has to show what will really happen rather than
 * what the person asked for.
 */
export function previewChart(
  industry: string,
  excluded: readonly string[],
  added: readonly TemplateAccount[],
): TemplateAccount[] {
  const template = templateFor(industry);
  if (template === undefined) return [];
  const struck = new Set(excluded);
  const byNumber = new Map<string, TemplateAccount>();

  for (const row of template.accounts) {
    if (struck.has(row.accountNumber) && !MANDATORY_CLEARING_ACCOUNTS.includes(row.accountNumber)) {
      continue;
    }
    byNumber.set(row.accountNumber, row);
  }
  for (const row of added) {
    byNumber.set(row.accountNumber, row);
    const contra = contraFor(row.accountNumber);
    if (contra !== null && !byNumber.has(contra)) {
      byNumber.set(contra, {
        accountNumber: contra,
        name: `Accumulated depreciation, ${row.name.toLowerCase()}`,
        normalSide: "credit",
        scopeKey: row.scopeKey,
      });
    }
  }

  return [...byNumber.values()].sort((a, b) =>
    a.accountNumber < b.accountNumber ? -1 : a.accountNumber > b.accountNumber ? 1 : 0,
  );
}

/** True when a person cannot strike this row, whatever the checkbox says. */
export function isForced(accountNumber: string): boolean {
  return MANDATORY_CLEARING_ACCOUNTS.includes(accountNumber);
}

/** The catalog rows that will be seeded once the struck codes are removed. */
export function previewCatalog(excluded: readonly string[]): CatalogPreview[] {
  const struck = new Set(excluded);
  return STANDARD_CATALOG_PREVIEW.filter((c) => !struck.has(c.catalogCode));
}

/** The asks that will be raised once the struck subjects are removed. */
export function previewRequests(excluded: readonly string[]): RequestPreview[] {
  const struck = new Set(excluded);
  return STANDARD_REQUEST_PREVIEW.filter((r) => !struck.has(r.subjectKey));
}
