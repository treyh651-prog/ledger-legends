/**
 * Shared data and arithmetic for module 1, the four client setup runs.
 *
 * Spec: docs/02-run-specifications.md Module 1, and docs/01-categories-and-charts.md
 * for the chart templates and the category taxonomy this file encodes.
 *
 * Four runs sit on top of this file. INTAKE-BUILD-CHART seeds the chart of
 * accounts and the category layer from a standard template, INTAKE-SEED-TASKS
 * seeds the practice task catalog and the first period of task instances,
 * INTAKE-OPEN-REQUESTS raises the opening document requests, and
 * SETUP-IMPORT-BALANCES posts the opening balance journal entry at the cutover
 * date. All four are one shot per client and every one of them is idempotent,
 * which is what lets a wizard that failed halfway be run again from the top.
 *
 * SENDS. None. Every run in module 1 writes rows. A document request is a row
 * that says what the firm is waiting for. Nothing is transmitted, there is no
 * address column on any row this file describes, and no run reads one.
 *
 * CONSTRAINT. No model, no score, no string distance, no inference. A template
 * is a literal table below, the account block rules are integer comparisons on
 * a four digit account number, and the contra pairing rule is cost plus one
 * hundred exactly as doc 00 Part 1 states it.
 *
 * COMPLIANCE. Nothing here registers an entity, files a return, or gives tax or
 * legal advice. Entity type and fiscal year end select which equity block and
 * which task cadence a client gets. They are descriptive of records the firm
 * keeps, never a recommendation about how a business should be organised.
 */

import type { Cents, Ulid } from "../contract";
import type { RunTx } from "../db";
import type {
  CategoryRow,
  ChartAccountRow,
  DocumentRequestRow,
  OpeningBalanceRow,
  PracticeTaskCatalogRow,
  PracticeTaskRow,
} from "../tables";
import { loadCloseData, type CloseData } from "./close-shared";

/**
 * Doc 00 Part 2. The default capitalization threshold, 2,500 dollars. Re
 * exported from the coding cascade rather than declared twice, because two
 * declarations of the same threshold is how the two of them drift apart.
 */
export { DEFAULT_CAPITALIZE_OVER_CENTS } from "./coding-cascade";

/** Doc 01 Part 2.4. The offset every opening balance entry balances against. */
export const OPENING_BALANCE_EQUITY_ACCOUNT = "3900";

/** Doc 00 Part 1. These five exist on every chart whatever the template says. */
export const MANDATORY_CLEARING_ACCOUNTS: readonly string[] = [
  "1900",
  "1910",
  "1920",
  "1930",
  "1990",
];

/** The engagement scope answers a template row may be conditioned on. */
export type TemplateScopeKey =
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
  scopeKey: TemplateScopeKey;
}

export interface TemplateCategory {
  id: string; // "CAT-" plus slug
  name: string;
  accountNumber: string;
  normalSide: "debit" | "credit";
  taxTreatment: CategoryRow["taxTreatment"];
  class1099: CategoryRow["class1099"];
  requiresReceiptOverCents: Cents | null;
  requiresClass: boolean;
  capitalizeOverCents: Cents | null;
  restrictionRelevant: boolean;
}

export interface ChartTemplate {
  id: string; // "TPL-" plus slug
  version: number;
  label: string;
  /** Doc 01 Part 6.2. The nonprofit replaces the whole 3000 block. */
  replacesEquityBlock: boolean;
  accounts: readonly TemplateAccount[];
  categories: readonly TemplateCategory[];
}

/** Short helper so the tables below read as tables rather than as object soup. */
function acct(
  accountNumber: string,
  name: string,
  normalSide: "debit" | "credit",
  scopeKey: TemplateScopeKey = "always",
): TemplateAccount {
  return { accountNumber, name, normalSide, scopeKey };
}

interface CatOptions {
  tax?: CategoryRow["taxTreatment"];
  c1099?: CategoryRow["class1099"];
  receiptOver?: number | null;
  requiresClass?: boolean;
  capitalizeOver?: number | null;
  restriction?: boolean;
}

function cat(
  slug: string,
  name: string,
  accountNumber: string,
  normalSide: "debit" | "credit",
  o: CatOptions = {},
): TemplateCategory {
  return {
    id: `CAT-${slug}`,
    name,
    accountNumber,
    normalSide,
    taxTreatment: o.tax ?? "not_applicable",
    class1099: o.c1099 ?? "none",
    requiresReceiptOverCents:
      o.receiptOver === undefined || o.receiptOver === null
        ? null
        : BigInt(o.receiptOver),
    requiresClass: o.requiresClass ?? false,
    capitalizeOverCents:
      o.capitalizeOver === undefined || o.capitalizeOver === null
        ? null
        : BigInt(o.capitalizeOver),
    restrictionRelevant: o.restriction ?? false,
  };
}

/**
 * Doc 01 Part 2. The shared core, on every template, on every entity type.
 * The one exception is the 3900 line, which the nonprofit template drops in
 * favour of the two net asset accounts. See replacesEquityBlock.
 */
export const SHARED_CORE_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1000", "Operating checking", "debit"),
  acct("1010", "Payroll checking", "debit"),
  acct("1020", "Savings and reserve", "debit"),
  acct("1030", "Petty cash", "debit"),
  acct("1100", "Accounts receivable, trade", "debit"),
  acct("1190", "Allowance for doubtful accounts", "credit"),
  acct("1300", "Prepaid insurance", "debit"),
  acct("1310", "Prepaid software and subscriptions", "debit"),
  acct("1390", "Other prepaid and current assets", "debit"),
  acct("1400", "Employee advances", "debit"),
  acct("1410", "Other receivables", "debit"),
  acct("1500", "Furniture and fixtures", "debit"),
  acct("1510", "Computer and office equipment", "debit"),
  acct("1520", "Leasehold improvements", "debit"),
  acct("1600", "Accumulated depreciation, furniture and fixtures", "credit"),
  acct("1610", "Accumulated depreciation, computer and office equipment", "credit"),
  acct("1620", "Accumulated amortization, leasehold improvements", "credit"),
  acct("1800", "Security deposits", "debit"),
  acct("1900", "Undeposited funds", "debit"),
  acct("1910", "Payment processor clearing", "debit"),
  acct("1920", "Transfer clearing", "debit"),
  acct("1930", "Payroll clearing", "debit"),
  acct("1990", "Suspense", "debit"),
  acct("2000", "Accounts payable, trade", "credit"),
  acct("2100", "Credit card payable", "credit"),
  acct("2110", "Line of credit", "credit"),
  acct("2200", "Accrued expenses", "credit"),
  acct("2210", "Accrued interest payable", "credit"),
  acct("2300", "Wages and salaries payable", "credit"),
  acct("2310", "Payroll taxes payable", "credit"),
  acct("2320", "Employee withholdings and benefit deductions payable", "credit"),
  acct("2400", "Sales and use tax payable", "credit"),
  acct("2500", "Deferred revenue and customer deposits", "credit"),
  acct("2600", "Current portion of long term debt", "credit"),
  acct("2700", "Notes payable, long term", "credit"),
  acct("2900", "Due to related parties", "credit"),
  acct("3900", "Accumulated earnings, prior years", "credit"),
  acct("4900", "Sales discounts and allowances", "debit"),
  acct("4910", "Returns and refunds", "debit"),
  acct("6000", "Advertising and marketing", "debit"),
  acct("6010", "Bank service charges", "debit"),
  acct("6020", "Merchant and payment processing fees", "debit"),
  acct("6030", "Licenses, registrations, and filing fees", "debit"),
  acct("6040", "Software and cloud subscriptions", "debit"),
  acct("6050", "Dues and memberships", "debit"),
  acct("6060", "Insurance, general business", "debit"),
  acct("6070", "Meals, subject to the 50 percent limit", "debit"),
  acct("6080", "Office supplies", "debit"),
  acct("6090", "Postage and courier", "debit"),
  acct("6100", "Accounting and bookkeeping fees", "debit"),
  acct("6110", "Legal fees", "debit"),
  acct("6120", "Consulting and other professional fees", "debit"),
  acct("6130", "Rent, facility", "debit"),
  acct("6140", "Repairs and maintenance", "debit"),
  acct("6150", "Tools and equipment below the capitalization threshold", "debit"),
  acct("6160", "Telephone and internet", "debit"),
  acct("6170", "Travel", "debit"),
  acct("6180", "Utilities", "debit"),
  acct("6190", "Training and continuing education", "debit"),
  acct("6300", "Wages and salaries", "debit"),
  acct("6310", "Payroll taxes, employer", "debit"),
  acct("6320", "Employee benefits", "debit"),
  acct("6330", "Workers compensation insurance", "debit"),
  acct("6340", "Contract labor and outside services", "debit"),
  acct("6800", "Depreciation expense", "debit"),
  acct("6810", "Amortization expense", "debit"),
  acct("6900", "Bad debt expense", "debit"),
  acct("7900", "Penalties and fines, nondeductible", "debit"),
  acct("7910", "Other nondeductible expense", "debit"),
  acct("8000", "Interest income", "credit"),
  acct("8100", "Interest expense", "debit"),
  acct("8200", "Gain or loss on disposal of assets", "credit"),
  acct("8900", "Other income", "credit"),
  acct("9000", "State income and franchise tax expense", "debit"),
  acct("9900", "Memo, book to tax differences", "debit"),
  acct("9910", "Memo, owner or shareholder basis tracking", "debit"),
];

/**
 * Doc 01 Part 7.1. The universal category spine, on every template.
 *
 * Two spine entries in the doc are behaviours rather than rows.
 * CAT-REFUND-FROM-VENDOR mirrors whichever expense category the original
 * purchase used, and CAT-FIXED-ASSET-ADDITION resolves to whichever template
 * asset account applies. Neither has one account number, so neither can be one
 * category row, and seeding a placeholder for them would create a category that
 * codes to the wrong account. See NOTES.md entry 124.
 */
export const UNIVERSAL_SPINE_CATEGORIES: readonly TemplateCategory[] = [
  cat("TRANSFER", "Internal transfer", "1920", "debit", { tax: "transfer" }),
  cat("CC-PAYMENT", "Credit card payment", "2100", "debit", { tax: "transfer" }),
  cat("LOC-DRAW", "Line of credit advance", "2110", "credit"),
  cat("LOC-REPAYMENT", "Line of credit repayment", "2110", "debit"),
  cat("LOAN-PROCEEDS", "Loan proceeds", "2700", "credit"),
  cat("LOAN-PRINCIPAL", "Loan principal", "2600", "debit"),
  cat("LOAN-INTEREST", "Loan interest", "8100", "debit", { tax: "deductible" }),
  cat("PROCESSOR-GROSS", "Processor gross settlement", "1910", "debit"),
  cat("PROCESSOR-FEE", "Processor fee", "6020", "debit", { tax: "deductible" }),
  cat("PROCESSOR-NET-DEPOSIT", "Processor net deposit", "1910", "credit"),
  cat("UNDEPOSITED", "Cash and checks in hand", "1900", "debit"),
  cat("PAYROLL-NET-PAY", "Payroll net pay", "1930", "debit"),
  cat("PAYROLL-TAX-REMIT", "Payroll tax remittance", "2310", "debit"),
  cat("SALES-TAX-REMIT", "Sales tax remittance", "2400", "debit"),
  cat("AR-COLLECTION", "Customer payment on invoice", "1100", "credit"),
  cat("AP-PAYMENT", "Vendor payment on bill", "2000", "debit"),
  cat("CUSTOMER-DEPOSIT", "Customer deposit received", "2500", "credit"),
  cat("BANK-FEE", "Bank service charge", "6010", "debit", { tax: "deductible" }),
  cat("INTEREST-INCOME", "Interest earned", "8000", "credit"),
  cat("CHARGEBACK", "Chargeback pending research", "1910", "debit"),
  cat("PENALTY-FINE", "Penalty or fine", "7900", "debit", { tax: "nondeductible" }),
  cat("ASSET-DISPOSAL", "Asset disposal proceeds", "8200", "credit"),
  cat("DUE-TO-RELATED", "Due to a related party", "2900", "credit"),
  cat("STATE-TAX-PAYMENT", "State income or franchise tax", "9000", "debit", {
    tax: "nondeductible",
  }),
];

/* -------------------------------------------------------------------------- */
/* The templates                                                              */
/* -------------------------------------------------------------------------- */

/** Doc 01 Part 5. Service and studio work. */
const SERVICE_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1200", "Inventory, finished ware", "debit", "inventory"),
  acct("1210", "Inventory, materials and supplies", "debit", "inventory"),
  acct("1230", "Inventory, resale goods from other makers", "debit", "inventory"),
  acct("1530", "Studio and production equipment", "debit", "fixed_assets"),
  acct("1540", "Tools and small machinery", "debit", "fixed_assets"),
  acct("1630", "Accumulated depreciation, studio and production equipment", "credit", "fixed_assets"),
  acct("1640", "Accumulated depreciation, tools and small machinery", "credit", "fixed_assets"),
  acct("2510", "Gift certificates outstanding", "credit"),
  acct("2520", "Unearned class and workshop tuition", "credit"),
  acct("3000", "Owner capital", "credit"),
  acct("3100", "Owner contributions", "credit"),
  acct("3200", "Owner draws", "debit"),
  acct("4000", "Service revenue, studio and direct", "credit"),
  acct("4010", "Service revenue, online marketplace", "credit"),
  acct("4020", "Service revenue, own website", "credit"),
  acct("4100", "Wholesale and consignment revenue", "credit"),
  acct("4200", "Class and workshop tuition", "credit"),
  acct("4300", "Commission and custom work", "credit"),
  acct("4400", "Membership, shelf rental, and usage fees", "credit"),
  acct("4500", "Teaching, residency, and guest fees", "credit"),
  acct("5000", "Cost of services, materials", "debit"),
  acct("5010", "Production energy and utilities", "debit"),
  acct("5020", "Packaging and shipping materials", "debit"),
  acct("5030", "Production loss, breakage and seconds", "debit", "inventory"),
  acct("5040", "Outbound shipping cost", "debit"),
  acct("6420", "Online platform and marketplace fees", "debit"),
  acct("6430", "Photography and listing services", "debit"),
  acct("6440", "Shared studio and equipment access fees paid to others", "debit"),
  acct("6450", "Market, fair, and booth fees", "debit"),
  acct("6460", "Consignment and gallery commissions", "debit"),
];

const SERVICE_CATEGORIES: readonly TemplateCategory[] = [
  cat("REV-STUDIO-RETAIL", "Studio and direct revenue", "4000", "credit"),
  cat("REV-MARKETPLACE", "Marketplace revenue", "4010", "credit"),
  cat("REV-WEBSITE", "Own website revenue", "4020", "credit"),
  cat("REV-WHOLESALE-GALLERY", "Wholesale and gallery revenue", "4100", "credit"),
  cat("REV-TUITION", "Class and workshop tuition", "4200", "credit"),
  cat("REV-COMMISSION-WORK", "Commission and custom work", "4300", "credit"),
  cat("REV-STUDIO-MEMBERSHIP", "Membership revenue", "4400", "credit"),
  cat("REV-FIRING-FEES", "Usage and firing fees", "4400", "credit"),
  cat("REV-TEACHING-OUTSIDE", "Teaching and residency fees", "4500", "credit"),
  cat("REFUND-CUSTOMER", "Customer refund", "4910", "debit"),
  cat("CLAY", "Raw material, clay and body", "5000", "debit", { tax: "deductible" }),
  cat("GLAZE-CHEMICALS", "Glaze and chemicals", "5000", "debit", { tax: "deductible" }),
  cat("KILN-FURNITURE-CONSUMABLE", "Kiln furniture, consumable", "5000", "debit", {
    tax: "deductible",
    capitalizeOver: 250000,
  }),
  cat("FREIGHT-IN", "Inbound freight", "5000", "debit", { tax: "deductible" }),
  cat("RESALE-GOODS", "Goods bought for resale", "5000", "debit", { tax: "deductible" }),
  cat("KILN-ENERGY", "Production energy", "5010", "debit", { tax: "deductible" }),
  cat("PACKAGING-SHIP-SUPPLIES", "Packaging and shipping supplies", "5020", "debit", {
    tax: "deductible",
  }),
  cat("BREAKAGE-SECONDS", "Breakage and seconds", "5030", "debit", { tax: "deductible" }),
  cat("SHIPPING-OUT", "Outbound shipping", "5040", "debit", { tax: "deductible" }),
  cat("MATERIALS-INVENTORY-PURCHASE", "Materials into inventory", "1210", "debit", {
    tax: "deductible",
  }),
  cat("PLATFORM-FEES", "Platform and marketplace fees", "6420", "debit", { tax: "deductible" }),
  cat("PRODUCT-PHOTOGRAPHY", "Photography and listing services", "6430", "debit", {
    tax: "deductible",
    c1099: "nec",
  }),
  cat("STUDIO-ACCESS-PAID", "Shared studio access paid", "6440", "debit", {
    tax: "deductible",
    c1099: "misc_rent",
  }),
  cat("MARKET-BOOTH-FEES", "Market and booth fees", "6450", "debit", {
    tax: "deductible",
    receiptOver: 7500,
  }),
  cat("GALLERY-COMMISSION", "Gallery commission", "6460", "debit", {
    tax: "deductible",
    c1099: "misc_other",
  }),
  cat("STUDIO-RENT", "Studio rent", "6130", "debit", { tax: "deductible", c1099: "misc_rent" }),
  cat("KILN-PURCHASE", "Kiln or production equipment purchase", "1530", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("WHEEL-TOOL-PURCHASE", "Tool or machinery purchase", "1540", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("SMALL-TOOLS", "Small tools below threshold", "6150", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    capitalizeOver: 250000,
  }),
  cat("MEALS-CLIENT", "Client meals", "6070", "debit", { tax: "meals_50", receiptOver: 2500 }),
  cat("CONTRACT-ASSISTANT", "Contract assistant", "6340", "debit", {
    tax: "deductible",
    c1099: "nec",
    receiptOver: 0,
  }),
  cat("OWNER-DRAW", "Owner draw", "3200", "debit", { tax: "owner_draw" }),
  cat("OWNER-CONTRIBUTION", "Owner contribution", "3100", "credit", {
    tax: "owner_contribution",
  }),
  cat("OWNER-HEALTH-INSURANCE", "Owner health insurance", "3200", "debit", {
    tax: "owner_draw",
  }),
  cat("OWNER-RETIREMENT", "Owner retirement contribution", "3200", "debit", {
    tax: "owner_draw",
  }),
  cat("OWNER-SE-TAX-PAYMENT", "Owner self employment tax payment", "3200", "debit", {
    tax: "owner_draw",
  }),
  cat("PERSONAL-EXPENSE", "Personal expense paid by the business", "3200", "debit", {
    tax: "personal",
  }),
  cat("INVENTORY-OWNER-USE", "Inventory withdrawn for owner use", "3200", "debit", {
    tax: "owner_draw",
  }),
  cat("GIFT-CERT-SOLD", "Gift certificate sold", "2510", "credit"),
  cat("TUITION-PREPAID", "Tuition received in advance", "2520", "credit"),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { tax: "deductible", c1099: "attorney" }),
];

/** Doc 01 Part 3. Product, retail, and wholesale. */
const PRODUCT_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1200", "Inventory, raw goods", "debit", "inventory"),
  acct("1210", "Inventory, finished goods", "debit", "inventory"),
  acct("1220", "Inventory, packaging and shipping supplies", "debit", "inventory"),
  acct("1230", "Inventory, merchandise for resale", "debit", "inventory"),
  acct("1290", "Inventory valuation reserve, shrink and obsolescence", "credit", "inventory"),
  acct("1530", "Production equipment", "debit", "fixed_assets"),
  acct("1540", "Delivery vehicles", "debit", "fixed_assets"),
  acct("1630", "Accumulated depreciation, production equipment", "credit", "fixed_assets"),
  acct("1640", "Accumulated depreciation, delivery vehicles", "credit", "fixed_assets"),
  acct("2510", "Gift card and stored value liability", "credit"),
  acct("2520", "Wholesale customer deposits and prepayments", "credit"),
  acct("3000", "Member contributions", "credit"),
  acct("3100", "Member distributions and draws", "debit"),
  acct("4000", "Wholesale revenue", "credit"),
  acct("4010", "Wholesale revenue, private label", "credit"),
  acct("4100", "Retail revenue, direct", "credit"),
  acct("4110", "Retail revenue, online", "credit"),
  acct("4120", "Retail revenue, subscription", "credit"),
  acct("4200", "Merchandise and equipment revenue", "credit"),
  acct("4300", "Shipping and handling billed to customers", "credit"),
  acct("5000", "Cost of goods sold", "debit"),
  acct("5010", "Inventory shrink, spoilage, and adjustments", "debit", "inventory"),
  acct("5020", "Outbound shipping and fulfillment cost", "debit"),
  acct("6400", "Wholesale commissions and broker fees", "debit"),
  acct("6410", "Trade shows, markets, and sampling", "debit"),
  acct("6420", "Online sales channel and marketplace fees", "debit"),
  acct("6500", "Vehicle fuel", "debit", "vehicles"),
  acct("6510", "Vehicle repairs and maintenance", "debit", "vehicles"),
  acct("6520", "Vehicle insurance and registration", "debit", "vehicles"),
  acct("6530", "Retail supplies, not for resale", "debit"),
];

const PRODUCT_CATEGORIES: readonly TemplateCategory[] = [
  cat("REV-WHOLESALE", "Wholesale revenue", "4000", "credit"),
  cat("REV-WHOLESALE-PRIVATE-LABEL", "Private label revenue", "4010", "credit"),
  cat("REV-RETAIL-DIRECT", "Retail revenue, direct", "4100", "credit"),
  cat("REV-RETAIL-ONLINE", "Retail revenue, online", "4110", "credit"),
  cat("REV-SUBSCRIPTION", "Subscription revenue", "4120", "credit"),
  cat("REV-MERCH", "Merchandise revenue", "4200", "credit"),
  cat("REV-SHIPPING-BILLED", "Shipping billed to customers", "4300", "credit"),
  cat("DISCOUNT-WHOLESALE", "Wholesale discount", "4900", "debit"),
  cat("REFUND-CUSTOMER", "Customer refund", "4910", "debit"),
  cat("PRODUCT-PURCHASE", "Product purchased for sale", "5000", "debit", { tax: "deductible" }),
  cat("FREIGHT-IN", "Inbound freight", "5000", "debit", { tax: "deductible" }),
  cat("PACKAGING", "Packaging that ships with the product", "5000", "debit", {
    tax: "deductible",
  }),
  cat("LABELS", "Labels", "5000", "debit", { tax: "deductible" }),
  cat("PRODUCTION-LABOR", "Production labor", "5000", "debit", { tax: "deductible" }),
  cat("COGS-MERCH", "Merchandise cost of sale", "5000", "debit", { tax: "deductible" }),
  cat("COGS-BROKER-FEE", "Broker fee in product cost", "5000", "debit", {
    tax: "deductible",
    c1099: "nec",
  }),
  cat("INVENTORY-SHRINK", "Inventory shrink", "5010", "debit", { tax: "deductible" }),
  cat("SHIPPING-OUT", "Outbound shipping", "5020", "debit", { tax: "deductible" }),
  cat("INVENTORY-PURCHASE-RAW", "Raw goods into inventory", "1200", "debit", {
    tax: "deductible",
  }),
  cat("INVENTORY-PURCHASE-PACKAGING", "Packaging into inventory", "1220", "debit", {
    tax: "deductible",
  }),
  cat("BROKER-COMMISSION", "Broker commission", "6400", "debit", {
    tax: "deductible",
    c1099: "nec",
  }),
  cat("TRADE-SHOW", "Trade show and sampling", "6410", "debit", {
    tax: "deductible",
    receiptOver: 7500,
  }),
  cat("PLATFORM-FEES", "Platform and marketplace fees", "6420", "debit", { tax: "deductible" }),
  cat("RETAIL-SUPPLIES", "Retail supplies", "6530", "debit", {
    tax: "deductible",
    receiptOver: 7500,
  }),
  cat("VEHICLE-FUEL", "Vehicle fuel", "6500", "debit", { tax: "deductible" }),
  cat("VEHICLE-REPAIR", "Vehicle repair", "6510", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    capitalizeOver: 250000,
  }),
  cat("VEHICLE-INSURANCE", "Vehicle insurance", "6520", "debit", { tax: "deductible" }),
  cat("PRODUCTION-EQUIPMENT", "Production equipment purchase", "1530", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("DELIVERY-VEHICLE", "Delivery vehicle purchase", "1540", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 0,
  }),
  cat("MEALS-CLIENT", "Client meals", "6070", "debit", { tax: "meals_50", receiptOver: 2500 }),
  cat("RENT-FACILITY", "Facility rent", "6130", "debit", {
    tax: "deductible",
    c1099: "misc_rent",
  }),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { tax: "deductible", c1099: "attorney" }),
  cat("MEMBER-DRAW", "Member draw", "3100", "debit", { tax: "owner_draw" }),
  cat("MEMBER-CONTRIBUTION", "Member contribution", "3000", "credit", {
    tax: "owner_contribution",
  }),
  cat("GIFT-CARD-SOLD", "Gift card sold", "2510", "credit"),
  cat("WHOLESALE-DEPOSIT", "Wholesale deposit received", "2520", "credit"),
];

/** Doc 01 Part 4. Contractor and job cost work. Kept for the doc's own client. */
const CONTRACTOR_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1120", "Retainage receivable", "debit"),
  acct("1130", "Contract assets, costs in excess of billings", "debit"),
  acct("1140", "Uninstalled materials at job sites", "debit"),
  acct("1200", "Inventory, materials and parts", "debit", "inventory"),
  acct("1530", "Service vehicles", "debit", "fixed_assets"),
  acct("1540", "Field equipment and tools", "debit", "fixed_assets"),
  acct("1550", "Shop and yard equipment", "debit", "fixed_assets"),
  acct("1630", "Accumulated depreciation, service vehicles", "credit", "fixed_assets"),
  acct("1640", "Accumulated depreciation, field equipment and tools", "credit", "fixed_assets"),
  acct("1650", "Accumulated depreciation, shop and yard equipment", "credit", "fixed_assets"),
  acct("2010", "Retainage payable, subcontractors", "credit"),
  acct("2230", "Accrued job costs", "credit"),
  acct("2340", "Accrued paid time off", "credit", "payroll"),
  acct("2350", "Union and prevailing wage fringe payable", "credit", "payroll"),
  acct("2510", "Contract liabilities, billings in excess of costs", "credit"),
  acct("3000", "Common stock", "credit"),
  acct("3010", "Additional paid in capital", "credit"),
  acct("3100", "Shareholder distributions", "debit"),
  acct("4000", "Contract revenue, new construction", "credit"),
  acct("4010", "Contract revenue, retrofit and tenant improvement", "credit"),
  acct("4020", "Contract revenue, change orders", "credit"),
  acct("4100", "Service and repair revenue", "credit"),
  acct("4110", "Maintenance agreement revenue", "credit"),
  acct("4200", "Equipment and parts sales revenue", "credit"),
  acct("4990", "Contract revenue adjustment, over and under billings", "credit"),
  acct("5000", "Job cost, direct labor", "debit"),
  acct("5010", "Job cost, labor burden", "debit"),
  acct("5020", "Job cost, materials and equipment", "debit"),
  acct("5030", "Job cost, subcontractors", "debit"),
  acct("5040", "Job cost, permits and inspections", "debit"),
  acct("5050", "Job cost, equipment and crane rental", "debit"),
  acct("5060", "Job cost, freight and delivery", "debit"),
  acct("5070", "Job cost, travel, lodging, and per diem", "debit"),
  acct("5080", "Job cost, warranty and rework", "debit"),
  acct("5090", "Job cost, other direct", "debit"),
  acct("5100", "Job cost, small tools and consumables", "debit"),
  acct("6350", "Officer compensation, shareholder employee", "debit", "payroll"),
  acct("6360", "Shareholder health insurance included in W-2 wages", "debit", "payroll"),
  acct("6500", "Vehicle fuel", "debit", "vehicles"),
  acct("6510", "Vehicle repairs and maintenance", "debit", "vehicles"),
  acct("6520", "Vehicle insurance and registration", "debit", "vehicles"),
  acct("6540", "Equipment repairs and maintenance", "debit"),
  acct("6600", "Bonding, licensing, and company permits", "debit"),
  acct("6610", "Builders risk and installation floater insurance", "debit"),
  acct("6620", "Safety, protective equipment, and field training", "debit"),
];

const CONTRACTOR_CATEGORIES: readonly TemplateCategory[] = [
  cat("REV-CONTRACT-NEW", "Contract revenue, new construction", "4000", "credit", {
    requiresClass: true,
  }),
  cat("REV-CONTRACT-RETROFIT", "Contract revenue, retrofit", "4010", "credit", {
    requiresClass: true,
  }),
  cat("REV-CHANGE-ORDER", "Change order revenue", "4020", "credit", { requiresClass: true }),
  cat("REV-SERVICE", "Service and repair revenue", "4100", "credit", { requiresClass: true }),
  cat("REV-MAINTENANCE-AGREEMENT", "Maintenance agreement revenue", "4110", "credit", {
    requiresClass: true,
  }),
  cat("REV-EQUIPMENT-SALE", "Equipment and parts revenue", "4200", "credit", {
    requiresClass: true,
  }),
  cat("WIP-REVENUE-ADJ", "Work in progress revenue adjustment", "4990", "credit", {
    requiresClass: true,
  }),
  cat("JOB-LABOR", "Job cost, direct labor", "5000", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("JOB-LABOR-BURDEN", "Job cost, labor burden", "5010", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("JOB-MATERIALS", "Job cost, materials", "5020", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
    capitalizeOver: 250000,
  }),
  cat("JOB-SUBCONTRACTOR", "Job cost, subcontractor", "5030", "debit", {
    tax: "deductible",
    c1099: "nec",
    receiptOver: 0,
    requiresClass: true,
  }),
  cat("JOB-PERMITS", "Job cost, permits", "5040", "debit", {
    tax: "deductible",
    receiptOver: 0,
    requiresClass: true,
  }),
  cat("JOB-EQUIPMENT-RENTAL", "Job cost, equipment rental", "5050", "debit", {
    tax: "deductible",
    c1099: "misc_rent",
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("JOB-FREIGHT", "Job cost, freight", "5060", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("JOB-TRAVEL", "Job cost, travel", "5070", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("JOB-WARRANTY", "Job cost, warranty and rework", "5080", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("JOB-OTHER-DIRECT", "Job cost, other direct", "5090", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("JOB-SMALL-TOOLS", "Job cost, small tools", "5100", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
    capitalizeOver: 250000,
  }),
  cat("RETAINAGE-BILLED", "Retainage billed", "1120", "debit", { requiresClass: true }),
  cat("RETAINAGE-SUB-WITHHELD", "Retainage withheld from a sub", "2010", "credit", {
    requiresClass: true,
  }),
  cat("UNINSTALLED-MATERIALS", "Uninstalled materials", "1140", "debit", {
    receiptOver: 0,
    requiresClass: true,
  }),
  cat("PARTS-INVENTORY-PURCHASE", "Parts into inventory", "1200", "debit", {
    tax: "deductible",
  }),
  cat("OFFICER-COMP", "Officer compensation", "6350", "debit", { tax: "deductible" }),
  cat("SHAREHOLDER-HEALTH-W2", "Shareholder health in W-2 wages", "6360", "debit", {
    tax: "deductible",
  }),
  cat("SHAREHOLDER-DISTRIBUTION", "Shareholder distribution", "3100", "debit", {
    tax: "owner_draw",
  }),
  cat("SHAREHOLDER-CAPITAL", "Shareholder capital contribution", "3010", "credit", {
    tax: "owner_contribution",
  }),
  cat("VEHICLE-FUEL", "Vehicle fuel", "6500", "debit", { tax: "deductible" }),
  cat("VEHICLE-REPAIR", "Vehicle repair", "6510", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    capitalizeOver: 250000,
  }),
  cat("VEHICLE-INSURANCE", "Vehicle insurance", "6520", "debit", { tax: "deductible" }),
  cat("EQUIPMENT-REPAIR", "Equipment repair", "6540", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    capitalizeOver: 250000,
  }),
  cat("BONDING", "Bonding and surety", "6600", "debit", { tax: "deductible" }),
  cat("BUILDERS-RISK", "Builders risk insurance", "6610", "debit", { tax: "deductible" }),
  cat("SAFETY-PPE", "Safety and protective equipment", "6620", "debit", {
    tax: "deductible",
    receiptOver: 7500,
  }),
  cat("SERVICE-VEHICLE-PURCHASE", "Service vehicle purchase", "1530", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 0,
  }),
  cat("FIELD-EQUIPMENT-PURCHASE", "Field equipment purchase", "1540", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("SHOP-EQUIPMENT-PURCHASE", "Shop equipment purchase", "1550", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("MEALS-CREW", "Crew meals", "6070", "debit", {
    tax: "meals_50",
    receiptOver: 2500,
    requiresClass: true,
  }),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { tax: "deductible", c1099: "attorney" }),
  cat("SHOP-RENT", "Shop rent", "6130", "debit", { tax: "deductible", c1099: "misc_rent" }),
  cat("UNION-FRINGE", "Union and prevailing wage fringe", "2350", "credit"),
];

/**
 * Restaurant and food service. Built on the same shared core and the same block
 * rules as the four templates doc 01 publishes. The accounting problems are
 * food and beverage cost read separately, tips that are a liability rather than
 * revenue, and comps that are contra revenue rather than an expense.
 */
const RESTAURANT_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1200", "Inventory, food", "debit", "inventory"),
  acct("1210", "Inventory, beverage and alcohol", "debit", "inventory"),
  acct("1220", "Inventory, paper and disposables", "debit", "inventory"),
  acct("1530", "Kitchen equipment", "debit", "fixed_assets"),
  acct("1540", "Furniture, fixtures, and smallwares", "debit", "fixed_assets"),
  acct("1630", "Accumulated depreciation, kitchen equipment", "credit", "fixed_assets"),
  acct("1640", "Accumulated depreciation, furniture, fixtures, and smallwares", "credit", "fixed_assets"),
  acct("2330", "Tips payable to staff", "credit", "payroll"),
  acct("2510", "Gift card and stored value liability", "credit"),
  acct("2520", "Catering and event deposits", "credit"),
  acct("3000", "Member contributions", "credit"),
  acct("3100", "Member distributions and draws", "debit"),
  acct("4000", "Food revenue, dine in", "credit"),
  acct("4010", "Food revenue, takeout and delivery", "credit"),
  acct("4100", "Beverage revenue, non alcoholic", "credit"),
  acct("4110", "Beverage revenue, beer, wine, and spirits", "credit"),
  acct("4200", "Catering and private event revenue", "credit"),
  acct("4300", "Merchandise and retail revenue", "credit"),
  acct("4920", "Comps, voids, and employee meals", "debit"),
  acct("5000", "Cost of sales, food", "debit"),
  acct("5010", "Cost of sales, beverage", "debit"),
  acct("5020", "Cost of sales, paper and disposables", "debit"),
  acct("5030", "Inventory waste and spoilage", "debit", "inventory"),
  acct("6400", "Delivery platform commissions", "debit"),
  acct("6410", "Linen, laundry, and uniforms", "debit"),
  acct("6420", "Kitchen smallwares below the capitalization threshold", "debit"),
  acct("6430", "Cleaning, sanitation, and pest control", "debit"),
  acct("6440", "Music, entertainment, and licensing", "debit"),
  acct("6450", "Health permits and food safety certification", "debit"),
];

const RESTAURANT_CATEGORIES: readonly TemplateCategory[] = [
  cat("REV-FOOD-DINEIN", "Food revenue, dine in", "4000", "credit"),
  cat("REV-FOOD-TAKEOUT", "Food revenue, takeout and delivery", "4010", "credit"),
  cat("REV-BEVERAGE-NA", "Beverage revenue, non alcoholic", "4100", "credit"),
  cat("REV-BEVERAGE-ALCOHOL", "Beverage revenue, alcohol", "4110", "credit"),
  cat("REV-CATERING", "Catering and event revenue", "4200", "credit"),
  cat("REV-MERCH", "Merchandise revenue", "4300", "credit"),
  cat("COMPS-VOIDS", "Comps, voids, and employee meals", "4920", "debit"),
  cat("REFUND-CUSTOMER", "Customer refund", "4910", "debit"),
  cat("FOOD-PURCHASE", "Food purchase", "5000", "debit", { tax: "deductible" }),
  cat("BEVERAGE-PURCHASE", "Beverage purchase", "5010", "debit", { tax: "deductible" }),
  cat("PAPER-DISPOSABLES", "Paper and disposables", "5020", "debit", { tax: "deductible" }),
  cat("WASTE-SPOILAGE", "Waste and spoilage", "5030", "debit", { tax: "deductible" }),
  cat("FOOD-INVENTORY-PURCHASE", "Food into inventory", "1200", "debit", { tax: "deductible" }),
  cat("BEVERAGE-INVENTORY-PURCHASE", "Beverage into inventory", "1210", "debit", {
    tax: "deductible",
  }),
  cat("DELIVERY-COMMISSION", "Delivery platform commission", "6400", "debit", {
    tax: "deductible",
  }),
  cat("LINEN-UNIFORMS", "Linen, laundry, and uniforms", "6410", "debit", { tax: "deductible" }),
  cat("SMALLWARES", "Smallwares below threshold", "6420", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    capitalizeOver: 250000,
  }),
  cat("CLEANING-SANITATION", "Cleaning and sanitation", "6430", "debit", {
    tax: "deductible",
    c1099: "nec",
  }),
  cat("MUSIC-LICENSING", "Music and entertainment licensing", "6440", "debit", {
    tax: "deductible",
  }),
  cat("HEALTH-PERMITS", "Health permits and food safety", "6450", "debit", {
    tax: "deductible",
    receiptOver: 0,
  }),
  cat("TIPS-COLLECTED", "Tips collected for staff", "2330", "credit"),
  cat("TIPS-PAID-OUT", "Tips paid out to staff", "2330", "debit"),
  cat("GIFT-CARD-SOLD", "Gift card sold", "2510", "credit"),
  cat("CATERING-DEPOSIT", "Catering deposit received", "2520", "credit"),
  cat("KITCHEN-EQUIPMENT-PURCHASE", "Kitchen equipment purchase", "1530", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("FIXTURE-PURCHASE", "Furniture and fixture purchase", "1540", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
  }),
  cat("RESTAURANT-RENT", "Restaurant rent", "6130", "debit", {
    tax: "deductible",
    c1099: "misc_rent",
  }),
  cat("MEALS-CLIENT", "Client meals", "6070", "debit", { tax: "meals_50", receiptOver: 2500 }),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { tax: "deductible", c1099: "attorney" }),
  cat("MEMBER-DRAW", "Member draw", "3100", "debit", { tax: "owner_draw" }),
  cat("MEMBER-CONTRIBUTION", "Member contribution", "3000", "credit", {
    tax: "owner_contribution",
  }),
];

/**
 * Real estate holding and rental operations. The accounting problems are one
 * property dimension rather than one account set per property, security
 * deposits that are a liability and not revenue, and improvements that
 * capitalize against repairs that do not.
 */
const REAL_ESTATE_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1150", "Tenant receivables", "debit", "rentals"),
  acct("1160", "Escrow and impound accounts", "debit", "rentals"),
  acct("1560", "Land", "debit", "fixed_assets"),
  acct("1570", "Buildings and improvements", "debit", "fixed_assets"),
  acct("1580", "Land improvements", "debit", "fixed_assets"),
  acct("1670", "Accumulated depreciation, buildings and improvements", "credit", "fixed_assets"),
  acct("1680", "Accumulated depreciation, land improvements", "credit", "fixed_assets"),
  acct("2450", "Tenant security deposits held", "credit", "rentals"),
  acct("2460", "Prepaid rent received", "credit", "rentals"),
  acct("2710", "Mortgages payable", "credit"),
  acct("3000", "Member contributions", "credit"),
  acct("3100", "Member distributions and draws", "debit"),
  acct("4000", "Rental revenue, residential", "credit"),
  acct("4010", "Rental revenue, commercial", "credit"),
  acct("4020", "Rental revenue, short term", "credit"),
  acct("4100", "Tenant reimbursements and common area recovery", "credit"),
  acct("4200", "Late fees and other tenant charges", "credit"),
  acct("4300", "Assignment fee revenue", "credit"),
  acct("4400", "Gain on sale of real property", "credit"),
  acct("6700", "Property management fees", "debit", "rentals"),
  acct("6710", "Leasing commissions and tenant placement", "debit", "rentals"),
  acct("6720", "Property taxes", "debit"),
  acct("6730", "Property insurance", "debit"),
  acct("6740", "Homeowners association and common area dues", "debit"),
  acct("6750", "Turnover, make ready, and cleaning", "debit"),
  acct("6760", "Landscaping and snow removal", "debit"),
  acct("6770", "Eviction, collection, and legal costs", "debit"),
  acct("6780", "Acquisition due diligence and inspection costs", "debit"),
];

const REAL_ESTATE_CATEGORIES: readonly TemplateCategory[] = [
  cat("REV-RENT-RESIDENTIAL", "Residential rent", "4000", "credit", { requiresClass: true }),
  cat("REV-RENT-COMMERCIAL", "Commercial rent", "4010", "credit", { requiresClass: true }),
  cat("REV-RENT-SHORT-TERM", "Short term rent", "4020", "credit", { requiresClass: true }),
  cat("REV-TENANT-REIMBURSEMENT", "Tenant reimbursement", "4100", "credit", {
    requiresClass: true,
  }),
  cat("REV-LATE-FEE", "Late fee charged to a tenant", "4200", "credit", { requiresClass: true }),
  cat("REV-ASSIGNMENT-FEE", "Assignment fee", "4300", "credit"),
  cat("GAIN-ON-SALE", "Gain on sale of real property", "4400", "credit"),
  cat("REFUND-CUSTOMER", "Tenant refund", "4910", "debit", { requiresClass: true }),
  cat("SECURITY-DEPOSIT-HELD", "Security deposit received", "2450", "credit", {
    requiresClass: true,
  }),
  cat("SECURITY-DEPOSIT-RETURNED", "Security deposit returned", "2450", "debit", {
    requiresClass: true,
  }),
  cat("PREPAID-RENT-RECEIVED", "Rent received in advance", "2460", "credit", {
    requiresClass: true,
  }),
  cat("PROPERTY-MANAGEMENT-FEE", "Property management fee", "6700", "debit", {
    tax: "deductible",
    c1099: "misc_other",
    requiresClass: true,
  }),
  cat("LEASING-COMMISSION", "Leasing commission", "6710", "debit", {
    tax: "deductible",
    c1099: "nec",
    requiresClass: true,
  }),
  cat("PROPERTY-TAX", "Property tax", "6720", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("PROPERTY-INSURANCE", "Property insurance", "6730", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("HOA-DUES", "Association and common area dues", "6740", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("TURNOVER-MAKE-READY", "Turnover and make ready", "6750", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
    capitalizeOver: 250000,
  }),
  cat("LANDSCAPING", "Landscaping and snow removal", "6760", "debit", {
    tax: "deductible",
    c1099: "nec",
    requiresClass: true,
  }),
  cat("EVICTION-COSTS", "Eviction and collection costs", "6770", "debit", {
    tax: "deductible",
    c1099: "attorney",
    requiresClass: true,
  }),
  cat("DUE-DILIGENCE", "Acquisition due diligence", "6780", "debit", {
    tax: "deductible",
    receiptOver: 0,
  }),
  cat("REPAIRS-PROPERTY", "Property repairs", "6140", "debit", {
    tax: "deductible",
    receiptOver: 7500,
    requiresClass: true,
    capitalizeOver: 250000,
  }),
  cat("UTILITIES-PROPERTY", "Property utilities", "6180", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("MORTGAGE-PRINCIPAL", "Mortgage principal", "2710", "debit", { requiresClass: true }),
  cat("MORTGAGE-INTEREST", "Mortgage interest", "8100", "debit", {
    tax: "deductible",
    requiresClass: true,
  }),
  cat("ESCROW-FUNDING", "Escrow funding", "1160", "debit", { requiresClass: true }),
  cat("BUILDING-PURCHASE", "Building purchase", "1570", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 0,
    requiresClass: true,
  }),
  cat("LAND-PURCHASE", "Land purchase", "1560", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 0,
    requiresClass: true,
  }),
  cat("LAND-IMPROVEMENT", "Land improvement", "1580", "debit", {
    tax: "capital",
    receiptOver: 0,
    capitalizeOver: 250000,
    requiresClass: true,
  }),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { tax: "deductible", c1099: "attorney" }),
  cat("MEMBER-DRAW", "Member draw", "3100", "debit", { tax: "owner_draw" }),
  cat("MEMBER-CONTRIBUTION", "Member contribution", "3000", "credit", {
    tax: "owner_contribution",
  }),
];

/** Doc 01 Part 6. Nonprofit. The 3000 block is exactly two accounts. */
const NONPROFIT_ACCOUNTS: readonly TemplateAccount[] = [
  acct("1040", "Cash, restricted for donor restricted purposes", "debit"),
  acct("1050", "Cash, board designated reserve", "debit"),
  acct("1110", "Pledges receivable", "debit"),
  acct("1120", "Discount and allowance on pledges receivable", "credit"),
  acct("1130", "Grants and contracts receivable", "debit"),
  acct("1230", "Inventory, gift shop and program merchandise", "debit", "inventory"),
  acct("1530", "Studio, classroom, and program equipment", "debit", "fixed_assets"),
  acct("1540", "Instruments and program technology", "debit", "fixed_assets"),
  acct("1630", "Accumulated depreciation, studio, classroom, and program equipment", "credit", "fixed_assets"),
  acct("1640", "Accumulated depreciation, instruments and program technology", "credit", "fixed_assets"),
  acct("1820", "Investments, donor restricted endowment", "debit"),
  acct("2340", "Accrued paid time off", "credit", "payroll"),
  acct("2530", "Refundable advances, conditional grants and contributions", "credit"),
  acct("2540", "Deferred revenue, exchange transactions", "credit"),
  acct("3000", "Net assets without donor restrictions", "credit"),
  acct("3100", "Net assets with donor restrictions", "credit"),
  acct("4000", "Contributions, individual", "credit"),
  acct("4010", "Contributions, corporate and business", "credit"),
  acct("4020", "Contributions in kind, goods", "credit"),
  acct("4030", "Contributions in kind, services and use of facilities", "credit"),
  acct("4100", "Foundation and private grants", "credit"),
  acct("4110", "Government grants and contracts", "credit"),
  acct("4200", "Program service revenue, tuition and class fees", "credit"),
  acct("4210", "Program service revenue, tickets and performances", "credit"),
  acct("4220", "Program service revenue, school and agency contracts", "credit"),
  acct("4300", "Special event revenue, contribution portion", "credit"),
  acct("4310", "Special event revenue, exchange portion", "credit"),
  acct("4320", "Direct benefit to donors", "debit"),
  acct("4400", "Membership dues", "credit"),
  acct("4500", "Gift shop and merchandise sales", "credit", "inventory"),
  acct("4700", "Net assets released from restrictions, without donor restrictions", "credit"),
  acct("4710", "Net assets released from restrictions, with donor restrictions", "debit"),
  acct("7000", "Grants, scholarships, and awards to others", "debit"),
  acct("7010", "Program supplies and materials", "debit"),
  acct("7020", "Teaching artist and instructor fees", "debit"),
  acct("7030", "Student transportation", "debit"),
  acct("7040", "Venue, rehearsal, and exhibition space rental", "debit"),
  acct("7050", "Special event production costs", "debit"),
  acct("7060", "Donor and constituent management software", "debit"),
  acct("7070", "Board and volunteer expense", "debit"),
  acct("7080", "Audit and annual information return preparation", "debit"),
  acct("7090", "Insurance, directors and officers", "debit"),
  acct("8010", "Realized and unrealized gain and loss on investments", "credit"),
  acct("9200", "Unrelated business income tax expense", "debit"),
];

const NONPROFIT_CATEGORIES: readonly TemplateCategory[] = [
  cat("CONTRIB-INDIVIDUAL", "Individual contribution", "4000", "credit", { restriction: true }),
  cat("CONTRIB-MAJOR-GIFT", "Major gift", "4000", "credit", { restriction: true }),
  cat("CONTRIB-CORPORATE", "Corporate contribution", "4010", "credit", { restriction: true }),
  cat("CONTRIB-INKIND-GOODS", "In kind goods", "4020", "credit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("CONTRIB-INKIND-SERVICES", "In kind services", "4030", "credit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("GRANT-FOUNDATION", "Foundation grant", "4100", "credit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("GRANT-GOVERNMENT", "Government grant", "4110", "credit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("REV-TUITION", "Program tuition", "4200", "credit"),
  cat("REV-TICKETS", "Ticket revenue", "4210", "credit"),
  cat("REV-SCHOOL-CONTRACT", "School contract revenue", "4220", "credit"),
  cat("EVENT-CONTRIBUTION", "Event contribution portion", "4300", "credit", {
    restriction: true,
  }),
  cat("EVENT-EXCHANGE", "Event exchange portion", "4310", "credit"),
  cat("EVENT-DONOR-BENEFIT", "Direct benefit to donors", "4320", "debit", {
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("MEMBERSHIP-DUES", "Membership dues", "4400", "credit", { restriction: true }),
  cat("REV-GIFT-SHOP", "Gift shop revenue", "4500", "credit"),
  cat("RELEASE-UNRESTRICTED-SIDE", "Release, unrestricted side", "4700", "credit", {
    restriction: true,
  }),
  cat("RELEASE-RESTRICTED-SIDE", "Release, restricted side", "4710", "debit", {
    restriction: true,
  }),
  cat("REFUNDABLE-ADVANCE", "Refundable advance", "2530", "credit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("DEFERRED-EXCHANGE", "Deferred exchange revenue", "2540", "credit"),
  cat("PLEDGE-RECEIVABLE", "Pledge receivable", "1110", "debit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("GRANT-RECEIVABLE", "Grant receivable", "1130", "debit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("SCHOLARSHIP-AWARDED", "Scholarship awarded", "7000", "debit", {
    receiptOver: 0,
    requiresClass: true,
  }),
  cat("PROGRAM-SUPPLIES", "Program supplies", "7010", "debit", {
    receiptOver: 7500,
    requiresClass: true,
    capitalizeOver: 250000,
  }),
  cat("TEACHING-ARTIST-FEES", "Teaching artist fees", "7020", "debit", {
    c1099: "nec",
    receiptOver: 0,
    requiresClass: true,
  }),
  cat("STUDENT-TRANSPORT", "Student transport", "7030", "debit", {
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("VENUE-RENTAL", "Venue rental", "7040", "debit", {
    c1099: "misc_rent",
    requiresClass: true,
  }),
  cat("EVENT-PRODUCTION", "Event production", "7050", "debit", {
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("DONOR-SOFTWARE", "Donor management software", "7060", "debit", { requiresClass: true }),
  cat("BOARD-VOLUNTEER", "Board and volunteer expense", "7070", "debit", {
    receiptOver: 7500,
    requiresClass: true,
  }),
  cat("AUDIT-ANNUAL-RETURN", "Audit and annual return preparation", "7080", "debit", {
    requiresClass: true,
  }),
  cat("INSURANCE-DO", "Directors and officers insurance", "7090", "debit", {
    requiresClass: true,
  }),
  cat("STAFF-WAGES", "Staff wages", "6300", "debit", { requiresClass: true }),
  cat("PAYROLL-TAX-EMPLOYER", "Employer payroll tax", "6310", "debit", { requiresClass: true }),
  cat("EMPLOYEE-BENEFITS", "Employee benefits", "6320", "debit", { requiresClass: true }),
  cat("OCCUPANCY-RENT", "Occupancy rent", "6130", "debit", {
    c1099: "misc_rent",
    requiresClass: true,
  }),
  cat("MEALS-STAFF-MEETING", "Staff meeting meals", "6070", "debit", {
    receiptOver: 2500,
    requiresClass: true,
  }),
  cat("PROGRAM-EQUIPMENT-PURCHASE", "Program equipment purchase", "1530", "debit", {
    tax: "capital",
    receiptOver: 0,
    requiresClass: true,
    capitalizeOver: 250000,
    restriction: true,
  }),
  cat("INSTRUMENT-PURCHASE", "Instrument purchase", "1540", "debit", {
    tax: "capital",
    receiptOver: 0,
    requiresClass: true,
    capitalizeOver: 250000,
    restriction: true,
  }),
  cat("ENDOWMENT-INVESTMENT", "Endowment investment", "1820", "debit", {
    receiptOver: 0,
    restriction: true,
  }),
  cat("INVESTMENT-GAIN-LOSS", "Investment gain or loss", "8010", "credit", {
    restriction: true,
  }),
  cat("UBIT-EXPENSE", "Unrelated business income tax", "9200", "debit", { requiresClass: true }),
  cat("LEGAL-FEES", "Legal fees", "6110", "debit", { c1099: "attorney", requiresClass: true }),
];

export const TEMPLATES: Readonly<Record<string, ChartTemplate>> = {
  "TPL-SERVICE-STUDIO": {
    id: "TPL-SERVICE-STUDIO",
    version: 1,
    label: "Services and studio",
    replacesEquityBlock: false,
    accounts: SERVICE_ACCOUNTS,
    categories: SERVICE_CATEGORIES,
  },
  "TPL-RETAIL-WHOLESALE": {
    id: "TPL-RETAIL-WHOLESALE",
    version: 1,
    label: "Product, retail and wholesale",
    replacesEquityBlock: false,
    accounts: PRODUCT_ACCOUNTS,
    categories: PRODUCT_CATEGORIES,
  },
  "TPL-CONTRACTOR": {
    id: "TPL-CONTRACTOR",
    version: 1,
    label: "Contractor and job cost",
    replacesEquityBlock: false,
    accounts: CONTRACTOR_ACCOUNTS,
    categories: CONTRACTOR_CATEGORIES,
  },
  "TPL-RESTAURANT": {
    id: "TPL-RESTAURANT",
    version: 1,
    label: "Restaurant and food service",
    replacesEquityBlock: false,
    accounts: RESTAURANT_ACCOUNTS,
    categories: RESTAURANT_CATEGORIES,
  },
  "TPL-REAL-ESTATE": {
    id: "TPL-REAL-ESTATE",
    version: 1,
    label: "Real estate and rentals",
    replacesEquityBlock: false,
    accounts: REAL_ESTATE_ACCOUNTS,
    categories: REAL_ESTATE_CATEGORIES,
  },
  "TPL-NONPROFIT": {
    id: "TPL-NONPROFIT",
    version: 1,
    label: "Nonprofit",
    replacesEquityBlock: true,
    accounts: NONPROFIT_ACCOUNTS,
    categories: NONPROFIT_CATEGORIES,
  },
};

/**
 * The five industry words the wizard offers, mapped onto template ids. Doc 01
 * publishes four templates under different names, so the mapping is explicit
 * rather than a rename of the doc. See NOTES.md entry 123.
 */
export const INDUSTRY_TEMPLATE_ID: Readonly<Record<string, string>> = {
  services: "TPL-SERVICE-STUDIO",
  product: "TPL-RETAIL-WHOLESALE",
  restaurant: "TPL-RESTAURANT",
  real_estate: "TPL-REAL-ESTATE",
  nonprofit: "TPL-NONPROFIT",
  contractor: "TPL-CONTRACTOR",
};

export function templateFor(industryOrId: string): ChartTemplate | null {
  const mapped = INDUSTRY_TEMPLATE_ID[industryOrId];
  if (mapped !== undefined) return TEMPLATES[mapped] ?? null;
  return TEMPLATES[industryOrId] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Chart assembly                                                             */
/* -------------------------------------------------------------------------- */

/** Doc 00 Part 1. Every 15xx cost account pairs with the 16xx contra at cost plus 100. */
export function contraFor(accountNumber: string): string | null {
  const n = Number(accountNumber);
  if (!Number.isInteger(n)) return null;
  if (n < 1500 || n > 1599) return null;
  return String(n + 100);
}

export interface AssembledAccount extends TemplateAccount {
  /** True when the clearing block rule forced this row in past its scope key. */
  forcedMandatory: boolean;
}

/**
 * The full account list a template produces for one client, account number
 * ascending, mandatory clearing forced in, template rows overriding the shared
 * core where the same number appears in both, and the nonprofit equity block
 * replacing the core 3900 line.
 */
export function assembleAccounts(
  template: ChartTemplate,
  scopeKeys: readonly string[],
): AssembledAccount[] {
  const included = new Set<string>(scopeKeys);
  const byNumber = new Map<string, AssembledAccount>();

  const consider = (row: TemplateAccount) => {
    const mandatory = MANDATORY_CLEARING_ACCOUNTS.includes(row.accountNumber);
    const inScope = row.scopeKey === "always" || included.has(row.scopeKey);
    if (!mandatory && !inScope) return;
    byNumber.set(row.accountNumber, { ...row, forcedMandatory: mandatory && !inScope });
  };

  for (const row of SHARED_CORE_ACCOUNTS) {
    // Doc 01 Part 6.2. The nonprofit carries net assets in 3000 and 3100 and
    // does not use the core accumulated earnings line at all.
    if (template.replacesEquityBlock && row.accountNumber === "3900") continue;
    consider(row);
  }
  for (const row of template.accounts) consider(row);

  return [...byNumber.values()].sort((a, b) =>
    a.accountNumber < b.accountNumber ? -1 : a.accountNumber > b.accountNumber ? 1 : 0,
  );
}

/** The contra accounts a chart is missing, one per 15xx cost account without a pair. */
export function missingContraAccounts(
  accounts: readonly AssembledAccount[],
): AssembledAccount[] {
  const present = new Set(accounts.map((a) => a.accountNumber));
  const out: AssembledAccount[] = [];
  for (const a of accounts) {
    const contra = contraFor(a.accountNumber);
    if (contra === null || present.has(contra)) continue;
    out.push({
      accountNumber: contra,
      name: `Accumulated depreciation, ${a.name.toLowerCase()}`,
      normalSide: "credit",
      scopeKey: a.scopeKey,
      forcedMandatory: false,
    });
  }
  return out.sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
}

/**
 * The categories a template produces, spine first then template rows, category
 * id ascending, template rows winning a collision with the spine so a template
 * that redefines a shared slug keeps its own account.
 */
export function assembleCategories(template: ChartTemplate): TemplateCategory[] {
  const bySlug = new Map<string, TemplateCategory>();
  for (const c of UNIVERSAL_SPINE_CATEGORIES) bySlug.set(c.id, c);
  for (const c of template.categories) bySlug.set(c.id, c);
  return [...bySlug.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* -------------------------------------------------------------------------- */
/* The standard practice task catalog                                         */
/* -------------------------------------------------------------------------- */

export interface StandardCatalogRow {
  catalogCode: string;
  title: string;
  kind: PracticeTaskCatalogRow["kind"];
  role: PracticeTaskCatalogRow["role"];
  scopeKey: string | null;
  gateCode: string | null;
  predecessorCode: string | null;
  dueOffsetDays: number;
  frequency: PracticeTaskCatalogRow["frequency"];
}

/**
 * The standard practice work a new client gets. Monthly close, quarterly
 * review, annual close, exactly as the brief names them, plus the checklist
 * steps the close depends on so the first generated period is a workload and
 * not one line. Catalog code ascending is the iteration order everywhere.
 */
export const STANDARD_TASK_CATALOG: readonly StandardCatalogRow[] = [
  {
    catalogCode: "MC-01-IMPORT",
    title: "Import and stage bank activity for the period",
    kind: "checklist",
    role: "preparer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 3,
    frequency: "monthly",
  },
  {
    catalogCode: "MC-02-CODE",
    title: "Code the register and clear suspense",
    kind: "checklist",
    role: "preparer",
    scopeKey: null,
    gateCode: "G01",
    predecessorCode: "MC-01-IMPORT",
    dueOffsetDays: 6,
    frequency: "monthly",
  },
  {
    catalogCode: "MC-03-RECONCILE",
    title: "Reconcile every bank and card account",
    kind: "gate_target",
    role: "preparer",
    scopeKey: null,
    gateCode: "G02",
    predecessorCode: "MC-02-CODE",
    dueOffsetDays: 9,
    frequency: "monthly",
  },
  {
    catalogCode: "MC-04-SUBLEDGER",
    title: "Tie the subledgers to the control accounts",
    kind: "gate_target",
    role: "preparer",
    scopeKey: null,
    gateCode: "G04",
    predecessorCode: "MC-03-RECONCILE",
    dueOffsetDays: 11,
    frequency: "monthly",
  },
  {
    catalogCode: "MC-05-REVIEW",
    title: "Review the close package and sign it off",
    kind: "gate_target",
    role: "reviewer",
    scopeKey: null,
    gateCode: "G05",
    predecessorCode: "MC-04-SUBLEDGER",
    dueOffsetDays: 14,
    frequency: "monthly",
  },
  {
    catalogCode: "MC-06-DELIVER",
    title: "Deliver the monthly package to the client portal",
    kind: "checklist",
    role: "preparer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: "MC-05-REVIEW",
    dueOffsetDays: 16,
    frequency: "monthly",
  },
  {
    catalogCode: "QR-01-REVIEW",
    title: "Quarterly review of balances, accruals, and estimates",
    kind: "checklist",
    role: "reviewer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 20,
    frequency: "quarterly",
  },
  {
    catalogCode: "QR-02-SALES-TAX",
    title: "Quarterly sales and use tax reconciliation",
    kind: "checklist",
    role: "preparer",
    scopeKey: "sales_tax",
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 20,
    frequency: "quarterly",
  },
  {
    catalogCode: "AC-01-TRIAL-BALANCE",
    title: "Annual close, final trial balance and adjusting entries",
    kind: "checklist",
    role: "preparer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 30,
    frequency: "annual",
  },
  {
    catalogCode: "AC-02-HANDOFF",
    title: "Annual close, build the accountant handoff package",
    kind: "checklist",
    role: "reviewer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: "AC-01-TRIAL-BALANCE",
    dueOffsetDays: 40,
    frequency: "annual",
  },
  {
    catalogCode: "AC-03-1099",
    title: "Annual information return data set for vendor payments",
    kind: "deadline",
    role: "preparer",
    scopeKey: "form_1099",
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 31,
    frequency: "annual",
  },
];

/* -------------------------------------------------------------------------- */
/* The opening document requests                                              */
/* -------------------------------------------------------------------------- */

export interface StandardRequest {
  subjectKey: string;
  catalogCode: string;
  owner: DocumentRequestRow["owner"];
  detail: string;
  /** Null when the ask is not about one account. */
  accountNumber: string | null;
  /** Only raised when the client answered this scope key. Null means always. */
  scopeKey: string | null;
}

/**
 * Doc 02 INTAKE-OPEN-REQUESTS. The opening asks, subject key ascending is the
 * iteration order and the subject key is what makes a rerun idempotent.
 *
 * Every detail line below is descriptive. It says which record the firm needs
 * in order to keep books. None of it advises the client on entity choice, on a
 * filing, or on a legal question, and none of it is transmitted anywhere.
 */
export const STANDARD_REQUESTS: readonly StandardRequest[] = [
  {
    subjectKey: "articles-of-incorporation",
    catalogCode: "REQ-FORMATION",
    owner: "client",
    detail:
      "Formation document on file with the state, articles of incorporation or articles of organization. Needed to record the legal name and the formation date on the client record.",
    accountNumber: null,
    scopeKey: null,
  },
  {
    subjectKey: "chart-of-authorization",
    catalogCode: "REQ-AUTHORITY",
    owner: "client",
    detail:
      "Chart of authorization naming who may approve a payment and who may approve a journal entry, with the dollar limits that apply to each.",
    accountNumber: null,
    scopeKey: null,
  },
  {
    subjectKey: "ein-letter",
    catalogCode: "REQ-EIN",
    owner: "client",
    detail:
      "Employer identification number assignment letter. Needed so the number on the books matches the number of record.",
    accountNumber: null,
    scopeKey: null,
  },
  {
    subjectKey: "opening-bank-statements",
    catalogCode: "REQ-OPENING-STATEMENTS",
    owner: "client",
    detail:
      "Bank and card statements covering the cutover date for every account in scope, so the opening cash balance can be agreed to a statement.",
    accountNumber: null,
    scopeKey: null,
  },
  {
    subjectKey: "prior-year-trial-balance",
    catalogCode: "REQ-PRIOR-TB",
    owner: "client",
    detail:
      "Final trial balance for the year before the cutover date, from the prior bookkeeper or accountant, in a spreadsheet or a report export.",
    accountNumber: null,
    scopeKey: null,
  },
  {
    subjectKey: "w9-owner",
    catalogCode: "REQ-W9",
    owner: "client",
    detail:
      "Signed Form W-9 for the owner of record, held in the vault for the vendor and information reporting file.",
    accountNumber: null,
    scopeKey: null,
  },
];

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** Everything module 1 reads, read once per execution. */
export interface IntakeData {
  close: CloseData;
  firmId: Ulid;
  clientId: Ulid;
  accounts: readonly ChartAccountRow[];
  categories: readonly CategoryRow[];
  catalog: readonly PracticeTaskCatalogRow[];
  tasks: readonly PracticeTaskRow[];
  requests: readonly DocumentRequestRow[];
  openingBalances: readonly OpeningBalanceRow[];
}

export async function loadIntakeData(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
  period: string,
  periodStart: string,
): Promise<IntakeData> {
  const key = { firmId, clientId };
  const close = await loadCloseData(tx, firmId, clientId, period);
  const accounts = await tx.query("chart_accounts_for_client", key);
  const categories = await tx.query("categories_for_client", key);
  const catalog = await tx.query("practice_catalog_for_client", key);
  const tasks = await tx.query("practice_tasks_for_client", key);
  const requests = await tx.query("document_requests_for_client", key);
  const openingBalances = await tx.query("opening_balances_for_period", {
    ...key,
    periodStart,
  });
  return {
    close,
    firmId,
    clientId,
    accounts,
    categories,
    catalog,
    tasks,
    requests,
    openingBalances,
  };
}

/** Sort helper used by every module 1 run that walks accounts. */
export function byAccountNumber(a: { accountNumber: string }, b: { accountNumber: string }): number {
  return a.accountNumber < b.accountNumber ? -1 : a.accountNumber > b.accountNumber ? 1 : 0;
}
