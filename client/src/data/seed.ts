import { acct } from "./coa";
import type {
  AuditRow,
  BankAccount,
  Bill,
  BudgetLine,
  Client,
  CommEntry,
  DocRecord,
  Invoice,
  JELine,
  JESource,
  JournalEntry,
  OpenItem,
  Rule,
  Signature,
  StatementLine,
  Substantiation,
  Task,
  TeamMember,
  Txn,
  Vendor,
} from "./types";

// Side table used to seed the one intentional substantiation variance.
export const variances: Record<string, number> = {};

export const TODAY = "2026-08-15";
export const PERIODS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
export const CURRENT_PERIOD = "2026-07";
export const FIRM_NAME = "Ledger Legends";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysInMonth(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayOf(period: string, day: number): string {
  const dim = daysInMonth(period);
  const d = Math.min(Math.max(day, 1), dim);
  return `${period}-${String(d).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

interface CardVendorCfg {
  vendor: string;
  desc: string;
  account: string;
  min: number;
  max: number;
}

interface BillVendorCfg {
  vendor: string;
  account: string;
  min: number;
  max: number;
  taxClass: string;
  w9: boolean;
  perMonth: number;
}

interface Profile {
  client: Client;
  banks: BankAccount[];
  opening: Record<string, number>;
  rent: number;
  rentPayee: string;
  utilities: [number, number];
  utilityPayee: string;
  software: { vendor: string; desc: string; cents: number }[];
  insurance: number;
  payroll: { wages: number; employerTax: number; withheld: number; runs: number[] } | null;
  loan: { payment: number; monthlyRateBps: number } | null;
  revenue: {
    invoices?: { customers: string[]; perMonth: number; min: number; max: number; account: string; klass: string };
    merchant?: { perMonth: number; min: number; max: number; account: string; feeBps: number; taxBps: number; klass: string; desc: string };
    grants?: { funders: string[]; perQuarter: number; min: number; max: number };
  };
  cardVendors: CardVendorCfg[];
  billVendors: BillVendorCfg[];
  depreciation: number;
  distributions: number | null;
  inventoryPurchase?: { vendor: string; desc: string; account: string; min: number; max: number };
  foreign?: { currency: string; rate: number; vendor: string; desc: string; account: string; amount: number; period: string };
}

const TEAM: TeamMember[] = [
  { id: "tm-1", name: "Trey Hernandez", initials: "TH", role: "Firm owner", capacityHours: 120, clients: ["bramble", "northgate", "marisol", "riverbend"] },
  { id: "tm-2", name: "Dana Whitfield", initials: "DW", role: "Senior bookkeeper", capacityHours: 150, clients: ["bramble", "northgate"] },
  { id: "tm-3", name: "Priya Raman", initials: "PR", role: "Bookkeeper", capacityHours: 150, clients: ["marisol", "riverbend"] },
  { id: "tm-4", name: "Owen Baptiste", initials: "OB", role: "Close reviewer", capacityHours: 100, clients: ["bramble", "marisol", "riverbend"] },
];

function profiles(): Profile[] {
  return [
    {
      client: {
        id: "bramble",
        legalName: "Bramble and Bean Roasting Company LLC",
        dba: "Bramble & Bean",
        shortName: "Bramble & Bean",
        industry: "Specialty coffee roaster and wholesale",
        entityType: "LLC",
        ein: "87-4410256",
        fiscalYearEnd: "December 31",
        address: "1408 SE Grant Ave, Bend, OR 97702",
        owners: [
          { id: "ow-1", name: "Nora Bramble", ownershipPct: 60, role: "Managing member" },
          { id: "ow-2", name: "Isaac Bean", ownershipPct: 40, role: "Member, head roaster" },
        ],
        contacts: [
          { id: "cc-1", name: "Nora Bramble", email: "nora@brambleandbean.co", role: "Managing member", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
          { id: "cc-2", name: "Devon Ruiz", email: "devon@brambleandbean.co", role: "Operations lead", canApprovePayments: true, canApproveJournalEntries: false, mfaRequired: true },
        ],
        systems: [
          { id: "sy-1", kind: "Accounting software", vendor: "QuickBooks Online Plus", accessStatus: "Admin" },
          { id: "sy-2", kind: "Point of sale", vendor: "Square for Restaurants", accessStatus: "Read only granted" },
          { id: "sy-3", kind: "E commerce", vendor: "Shopify", accessStatus: "Read only granted" },
          { id: "sy-4", kind: "Payroll", vendor: "Gusto", accessStatus: "Read only requested" },
        ],
        scope: ["ap", "ar", "payroll_je", "sales_tax", "form_1099", "monthly_close"],
        classes: ["Wholesale", "Cafe", "Online"],
        locations: ["Roastery", "Market Stall"],
        jobs: ["General"],
        currencies: ["USD", "CAD"],
        priorRecords: {
          lastFinancials: "December 2025 P&L and balance sheet from prior bookkeeper",
          priorTrialBalance: "2025 trial balance received as PDF, keyed in",
          existingCoa: "QuickBooks default plus 14 custom accounts, trimmed to 44",
          cleanupItems: [
            "Shopify payouts booked gross with no fee split for Q4 2025",
            "Two roaster deposits sitting in Ask My Accountant",
          ],
          outstandingRecs: ["Credit card 8842 not reconciled since November 2025"],
        },
        engagement: { monthlyFeeCents: 145000, cleanupFeeCents: 320000, startDate: "2026-01-05", signedBy: "Nora Bramble", signedAt: "2026-01-04T16:22:00", signatureMode: "typed" },
        onboardingStage: "Live",
        lead: "Dana Whitfield",
        color: "hsl(174 62% 38%)",
      },
      banks: [
        { id: "ba-b1", clientId: "bramble", institution: "First Cascade Bank", nickname: "Operating", last4: "4471", kind: "Checking", currency: "USD", glAccountId: "1010", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-b2", clientId: "bramble", institution: "First Cascade Bank", nickname: "Green bean reserve", last4: "9930", kind: "Savings", currency: "USD", glAccountId: "1020", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-b3", clientId: "bramble", institution: "Cascade Visa", nickname: "Roastery card", last4: "8842", kind: "Credit card", currency: "USD", glAccountId: "2010", statementSource: "PDF upload", needsReconciling: true },
        { id: "ba-b4", clientId: "bramble", institution: "Square", nickname: "Square clearing", last4: "2210", kind: "Merchant processor", currency: "USD", glAccountId: "1050", statementSource: "Portal", needsReconciling: false },
        { id: "ba-b5", clientId: "bramble", institution: "Cascade Equipment Finance", nickname: "Roaster loan", last4: "0117", kind: "Loan", currency: "USD", glAccountId: "2500", statementSource: "Portal", needsReconciling: false },
      ],
      opening: { "1010": 4823400, "1020": 2500000, "1150": 3184500, "1500": 9450000, "1510": 2115000, "2010": 412300, "2200": 118400, "2500": 4380000, "3000": 6000000 },
      rent: 465000,
      rentPayee: "Grant Avenue Holdings",
      utilities: [31200, 48600],
      utilityPayee: "Bend Electric and Water",
      software: [
        { vendor: "Shopify", desc: "SHOPIFY MONTHLY PLAN", cents: 7900 },
        { vendor: "QuickBooks", desc: "INTUIT QBO PLUS", cents: 9000 },
      ],
      insurance: 62400,
      payroll: { wages: 1284000, employerTax: 108900, withheld: 264200, runs: [15, 30] },
      loan: { payment: 96400, monthlyRateBps: 62 },
      revenue: {
        invoices: { customers: ["Harlow Grocers", "Deschutes Coffee Bar", "Pinecrest Market", "Two Rivers Cafe", "Silvan Hotel Group"], perMonth: 3, min: 620000, max: 1280000, account: "4020", klass: "Wholesale" },
        merchant: { perMonth: 3, min: 940000, max: 1720000, account: "4000", feeBps: 265, taxBps: 0, klass: "Cafe", desc: "SQUARE PAYOUT" },
      },
      cardVendors: [
        { vendor: "Cascade Packaging", desc: "CASCADE PACKAGING CO", account: "5000", min: 42000, max: 128000 },
        { vendor: "Ace Hardware", desc: "ACE HARDWARE 2210", account: "6160", min: 4200, max: 21800 },
        { vendor: "Chevron", desc: "CHEVRON 00214", account: "6170", min: 5400, max: 11200 },
        { vendor: "Meta Ads", desc: "FACEBOOK ADS", account: "6140", min: 18000, max: 46000 },
      ],
      billVendors: [
        { vendor: "Cedar Freight Lines", account: "5000", min: 62000, max: 148000, taxClass: "Partnership", w9: false, perMonth: 1 },
        { vendor: "Juniper Design Studio", account: "6140", min: 45000, max: 120000, taxClass: "Single member LLC", w9: true, perMonth: 1 },
        { vendor: "Sattler CPA Group", account: "6190", min: 55000, max: 95000, taxClass: "S corporation", w9: true, perMonth: 1 },
      ],
      depreciation: 78750,
      distributions: 450000,
      inventoryPurchase: { vendor: "Highline Green Coffee", desc: "HIGHLINE GREEN COFFEE", account: "1150", min: 2400000, max: 3200000 },
      foreign: { currency: "CAD", rate: 0.735, vendor: "Kootenay Roasters Supply", desc: "KOOTENAY ROASTERS SUPPLY", account: "5000", amount: 264000, period: "2026-05" },
    },
    {
      client: {
        id: "northgate",
        legalName: "Northgate Mechanical Services Inc",
        dba: "Northgate Mechanical",
        shortName: "Northgate Mechanical",
        industry: "Commercial HVAC contractor",
        entityType: "S Corp",
        ein: "45-2298137",
        fiscalYearEnd: "December 31",
        address: "3390 N Industrial Way, Spokane, WA 99207",
        owners: [{ id: "ow-3", name: "Marcus Keel", ownershipPct: 100, role: "President" }],
        contacts: [
          { id: "cc-3", name: "Marcus Keel", email: "marcus@northgatemech.com", role: "President", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
          { id: "cc-4", name: "Alicia Fenn", email: "alicia@northgatemech.com", role: "Office manager", canApprovePayments: true, canApproveJournalEntries: false, mfaRequired: true },
          { id: "cc-5", name: "Reggie Poole", email: "reggie@northgatemech.com", role: "Field supervisor", canApprovePayments: false, canApproveJournalEntries: false, mfaRequired: false },
        ],
        systems: [
          { id: "sy-5", kind: "Accounting software", vendor: "QuickBooks Desktop Contractor", accessStatus: "Read only granted" },
          { id: "sy-6", kind: "Other", vendor: "ServiceTitan", accessStatus: "Read only granted" },
          { id: "sy-7", kind: "Payroll", vendor: "ADP Run", accessStatus: "Read only granted" },
        ],
        scope: ["ap", "ar", "payroll_je", "form_1099", "monthly_close", "cleanup"],
        classes: ["Service", "Install", "Maintenance contract"],
        locations: ["Spokane", "Coeur d Alene"],
        jobs: ["Kellerman Retrofit", "Sandpoint Clinic", "Vista Apartments", "Shop overhead"],
        currencies: ["USD"],
        priorRecords: {
          lastFinancials: "March 2026 internal P&L, unreviewed",
          priorTrialBalance: "2025 trial balance from tax preparer workpapers",
          existingCoa: "Contractor template with job costing subaccounts",
          cleanupItems: [
            "Job costs posted without job tags from January to March",
            "Retainage held by two general contractors never split out",
            "Owner truck purchase expensed instead of capitalized",
          ],
          outstandingRecs: ["Checking 7712 unreconciled for June and July"],
        },
        engagement: { monthlyFeeCents: 235000, cleanupFeeCents: 675000, startDate: "2026-04-01", signedBy: "Marcus Keel", signedAt: "2026-03-27T09:41:00", signatureMode: "drawn" },
        onboardingStage: "Cleanup",
        lead: "Dana Whitfield",
        color: "hsl(212 62% 48%)",
      },
      banks: [
        { id: "ba-n1", clientId: "northgate", institution: "Inland Northwest Bank", nickname: "Operating", last4: "7712", kind: "Checking", currency: "USD", glAccountId: "1010", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-n2", clientId: "northgate", institution: "Inland Northwest Bank", nickname: "Tax reserve", last4: "3341", kind: "Savings", currency: "USD", glAccountId: "1020", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-n3", clientId: "northgate", institution: "Fleet One", nickname: "Fleet card", last4: "6607", kind: "Credit card", currency: "USD", glAccountId: "2010", statementSource: "PDF upload", needsReconciling: true },
        { id: "ba-n4", clientId: "northgate", institution: "Inland Equipment Credit", nickname: "Van loan", last4: "5528", kind: "Loan", currency: "USD", glAccountId: "2500", statementSource: "PDF upload", needsReconciling: false },
      ],
      opening: { "1010": 24500000, "1020": 4200000, "1200": 385000, "1500": 21400000, "1510": 6820000, "2010": 736400, "2300": 412800, "2500": 9640000, "3000": 2500000 },
      rent: 720000,
      rentPayee: "Industrial Way Partners",
      utilities: [64200, 98400],
      utilityPayee: "Avista Utilities",
      software: [
        { vendor: "ServiceTitan", desc: "SERVICETITAN SUBSCRIPTION", cents: 42900 },
        { vendor: "Microsoft", desc: "MSFT 365 BUSINESS", cents: 12600 },
      ],
      insurance: 184500,
      payroll: { wages: 3600000, employerTax: 394700, withheld: 862400, runs: [7, 21] },
      loan: { payment: 168200, monthlyRateBps: 58 },
      revenue: {
        invoices: { customers: ["Kellerman Properties", "Sandpoint Health Partners", "Vista Residential LLC", "Cascade School District", "Fairmount Retail Group"], perMonth: 4, min: 1500000, max: 4500000, account: "4010", klass: "Install" },
      },
      cardVendors: [
        { vendor: "Ferguson HVAC Supply", desc: "FERGUSON HVAC SUPPLY", account: "5000", min: 1200000, max: 3800000 },
        { vendor: "Pacific Pride Fuel", desc: "PACIFIC PRIDE FUEL", account: "6170", min: 18400, max: 42600 },
        { vendor: "Grainger", desc: "GRAINGER INDUSTRIAL", account: "6180", min: 8200, max: 34500 },
        { vendor: "Northtown Diner", desc: "NORTHTOWN DINER", account: "6210", min: 3400, max: 12800 },
      ],
      billVendors: [
        { vendor: "Redline Sheet Metal", account: "5050", min: 620000, max: 1480000, taxClass: "Single member LLC", w9: true, perMonth: 1 },
        { vendor: "Keel Crane Rental", account: "5050", min: 92000, max: 210000, taxClass: "Individual or sole proprietor", w9: false, perMonth: 1 },
        { vendor: "Fenwick Engineering", account: "6190", min: 120000, max: 310000, taxClass: "Partnership", w9: true, perMonth: 1 },
      ],
      depreciation: 178300,
      distributions: 1200000,
    },
    {
      client: {
        id: "marisol",
        legalName: "Marisol Vega",
        dba: "Marisol Ceramics Studio",
        shortName: "Marisol Ceramics",
        industry: "Ceramics studio and online retail",
        entityType: "Sole Prop",
        ein: "Uses SSN on Schedule C",
        fiscalYearEnd: "December 31",
        address: "77 Waverly St, Unit B, Santa Fe, NM 87501",
        owners: [{ id: "ow-4", name: "Marisol Vega", ownershipPct: 100, role: "Owner" }],
        contacts: [
          { id: "cc-6", name: "Marisol Vega", email: "hello@marisolceramics.com", role: "Owner", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
        ],
        systems: [
          { id: "sy-8", kind: "Accounting software", vendor: "Wave", accessStatus: "Admin" },
          { id: "sy-9", kind: "E commerce", vendor: "Etsy and Shopify", accessStatus: "Read only granted" },
          { id: "sy-10", kind: "Point of sale", vendor: "Square", accessStatus: "Read only granted" },
          { id: "sy-11", kind: "Payroll", vendor: "None, no employees", accessStatus: "No access" },
        ],
        scope: ["ar", "sales_tax", "monthly_close"],
        classes: ["Retail", "Wholesale", "Workshops"],
        locations: ["Studio"],
        jobs: ["General"],
        currencies: ["USD", "EUR"],
        priorRecords: {
          lastFinancials: "2025 Schedule C worksheet from tax preparer",
          priorTrialBalance: "None, first year with a real trial balance",
          existingCoa: "Wave default accounts, 22 total",
          cleanupItems: ["Personal card charges mixed into studio account through February"],
          outstandingRecs: ["Etsy deposits never tied to gross sales reports"],
        },
        engagement: { monthlyFeeCents: 78000, cleanupFeeCents: 145000, startDate: "2026-02-01", signedBy: "Marisol Vega", signedAt: "2026-01-28T11:05:00", signatureMode: "typed" },
        onboardingStage: "Live",
        lead: "Priya Raman",
        color: "hsl(28 74% 48%)",
      },
      banks: [
        { id: "ba-m1", clientId: "marisol", institution: "Sandia Credit Union", nickname: "Studio checking", last4: "2286", kind: "Checking", currency: "USD", glAccountId: "1010", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-m2", clientId: "marisol", institution: "Sandia Credit Union", nickname: "Studio card", last4: "5514", kind: "Credit card", currency: "USD", glAccountId: "2010", statementSource: "Portal", needsReconciling: true },
        { id: "ba-m3", clientId: "marisol", institution: "Stripe", nickname: "Shopify payouts", last4: "8801", kind: "Merchant processor", currency: "USD", glAccountId: "1050", statementSource: "Portal", needsReconciling: false },
      ],
      opening: { "1010": 1284600, "1150": 862400, "1200": 240000, "1500": 3860000, "1510": 1145000, "2010": 128700, "2200": 41200, "3000": 1500000 },
      rent: 168000,
      rentPayee: "Waverly Studio Lofts",
      utilities: [14200, 26800],
      utilityPayee: "PNM Energy",
      software: [
        { vendor: "Shopify", desc: "SHOPIFY BASIC", cents: 3900 },
        { vendor: "Adobe", desc: "ADOBE CREATIVE CLOUD", cents: 5999 },
      ],
      insurance: 18600,
      payroll: null,
      loan: null,
      revenue: {
        merchant: { perMonth: 4, min: 92000, max: 268000, account: "4000", feeBps: 290, taxBps: 813, klass: "Retail", desc: "STRIPE PAYOUT" },
        invoices: { customers: ["Sunroom Home Goods", "Canyon Road Gallery", "Placitas Interiors"], perMonth: 2, min: 84000, max: 264000, account: "4020", klass: "Wholesale" },
      },
      cardVendors: [
        { vendor: "Uline", desc: "ULINE SHIPPING SUPPLY", account: "6180", min: 8400, max: 32000 },
        { vendor: "Etsy Ads", desc: "ETSY MARKETING", account: "6140", min: 4200, max: 18600 },
      ],
      billVendors: [
        { vendor: "Ridgeline Kiln Repair", account: "6160", min: 24000, max: 92000, taxClass: "Individual or sole proprietor", w9: false, perMonth: 1 },
        { vendor: "Nava Studio Assistants", account: "5050", min: 42000, max: 96000, taxClass: "Individual or sole proprietor", w9: true, perMonth: 1 },
      ],
      depreciation: 32100,
      distributions: 260000,
      inventoryPurchase: { vendor: "Clay Planet", desc: "CLAY PLANET SUPPLY", account: "1150", min: 180000, max: 260000 },
      foreign: { currency: "EUR", rate: 1.086, vendor: "Vallauris Glazes", desc: "VALLAURIS GLAZES SARL", account: "5000", amount: 148000, period: "2026-04" },
    },
    {
      client: {
        id: "riverbend",
        legalName: "Riverbend Youth Arts Alliance",
        dba: "Riverbend Youth Arts",
        shortName: "Riverbend Youth Arts",
        industry: "Arts education nonprofit",
        entityType: "Nonprofit",
        ein: "83-1740922",
        fiscalYearEnd: "June 30",
        address: "512 Water St, Chattanooga, TN 37403",
        owners: [{ id: "ow-5", name: "Board of directors", ownershipPct: 0, role: "Governing body, 9 seats" }],
        contacts: [
          { id: "cc-7", name: "Adaeze Nwosu", email: "adaeze@riverbendarts.org", role: "Executive director", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
          { id: "cc-8", name: "Grant Tolliver", email: "grant@riverbendarts.org", role: "Board treasurer", canApprovePayments: true, canApproveJournalEntries: true, mfaRequired: true },
          { id: "cc-9", name: "Sasha Lim", email: "sasha@riverbendarts.org", role: "Program coordinator", canApprovePayments: false, canApproveJournalEntries: false, mfaRequired: true },
        ],
        systems: [
          { id: "sy-12", kind: "Accounting software", vendor: "QuickBooks Online Nonprofit", accessStatus: "Admin" },
          { id: "sy-13", kind: "Other", vendor: "Bloomerang donor CRM", accessStatus: "Read only granted" },
          { id: "sy-14", kind: "Payroll", vendor: "Paylocity", accessStatus: "Read only granted" },
        ],
        scope: ["ap", "payroll_je", "monthly_close", "form_1099"],
        classes: ["Program services", "Management and general", "Fundraising"],
        locations: ["Water Street", "Eastdale Annex"],
        jobs: ["Summer Studio", "After School Arts", "Teen Mural Corps"],
        currencies: ["USD"],
        priorRecords: {
          lastFinancials: "FY2025 audited statements from Hollins and Pike",
          priorTrialBalance: "FY2025 audit adjusted trial balance",
          existingCoa: "Unified chart of accounts with functional expense classes",
          cleanupItems: ["Restricted grant releases not recorded monthly"],
          outstandingRecs: ["Grant clearing account never reconciled after the spring appeal"],
        },
        engagement: { monthlyFeeCents: 165000, cleanupFeeCents: 0, startDate: "2026-01-15", signedBy: "Adaeze Nwosu", signedAt: "2026-01-12T14:10:00", signatureMode: "typed" },
        onboardingStage: "Review",
        lead: "Priya Raman",
        color: "hsl(268 48% 52%)",
      },
      banks: [
        { id: "ba-r1", clientId: "riverbend", institution: "Tennessee Valley Bank", nickname: "Operating", last4: "1180", kind: "Checking", currency: "USD", glAccountId: "1010", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-r2", clientId: "riverbend", institution: "Tennessee Valley Bank", nickname: "Board reserve", last4: "4402", kind: "Savings", currency: "USD", glAccountId: "1020", statementSource: "Bank feed", needsReconciling: true },
        { id: "ba-r3", clientId: "riverbend", institution: "TVB Visa", nickname: "Program card", last4: "9017", kind: "Credit card", currency: "USD", glAccountId: "2010", statementSource: "PDF upload", needsReconciling: true },
      ],
      opening: { "1010": 9800000, "1020": 8500000, "1200": 462000, "1500": 5240000, "1510": 1860000, "2010": 214600, "2300": 286400, "2400": 1850000, "3000": 0 },
      rent: 285000,
      rentPayee: "Water Street Trust",
      utilities: [38400, 62100],
      utilityPayee: "EPB Chattanooga",
      software: [
        { vendor: "Bloomerang", desc: "BLOOMERANG CRM", cents: 18900 },
        { vendor: "Zoom", desc: "ZOOM WORKPLACE", cents: 4999 },
      ],
      insurance: 74200,
      payroll: { wages: 1450000, employerTax: 196400, withheld: 418200, runs: [15, 28] },
      loan: null,
      revenue: {
        grants: { funders: ["Lyndhurst Foundation", "Tennessee Arts Commission", "Benwood Fund", "City of Chattanooga"], perQuarter: 2, min: 1400000, max: 2800000 },
        invoices: { customers: ["Hamilton County Schools", "Eastdale Community Center", "Chattanooga Parks"], perMonth: 2, min: 180000, max: 520000, account: "4010", klass: "Program services" },
      },
      cardVendors: [
        { vendor: "Blick Art Materials", desc: "BLICK ART MATERIALS", account: "6180", min: 12400, max: 68000 },
        { vendor: "Home Depot", desc: "HOME DEPOT 4482", account: "6160", min: 6800, max: 41200 },
        { vendor: "Enterprise Van Rental", desc: "ENTERPRISE VAN RENTAL", account: "6220", min: 18000, max: 52000 },
      ],
      billVendors: [
        { vendor: "Teaching Artists Collective", account: "5050", min: 96000, max: 285000, taxClass: "Partnership", w9: true, perMonth: 1 },
        { vendor: "Hollins and Pike CPAs", account: "6190", min: 180000, max: 240000, taxClass: "Partnership", w9: true, perMonth: 1 },
        { vendor: "Marla Beckett Photography", account: "6140", min: 32000, max: 78000, taxClass: "Individual or sole proprietor", w9: false, perMonth: 1 },
      ],
      depreciation: 43600,
      distributions: null,
    },
  ];
}

export interface Dataset {
  clients: Client[];
  bankAccounts: BankAccount[];
  journalEntries: JournalEntry[];
  txns: Txn[];
  rules: Rule[];
  statementLines: StatementLine[];
  invoices: Invoice[];
  bills: Bill[];
  vendors: Vendor[];
  substantiations: Substantiation[];
  openItems: OpenItem[];
  documents: DocRecord[];
  audit: AuditRow[];
  tasks: Task[];
  team: TeamMember[];
  comms: CommEntry[];
  budgets: BudgetLine[];
  signatures: Signature[];
}

const SCOPE_TASKS: Record<string, { title: string; hours: number }[]> = {
  ap: [
    { title: "Enter and code vendor bills", hours: 2.5 },
    { title: "Run AP aging and flag payables over 60 days", hours: 1 },
  ],
  ar: [
    { title: "Issue invoices and apply customer payments", hours: 2 },
    { title: "Review AR aging with the client", hours: 1 },
  ],
  payroll_je: [{ title: "Book payroll journal entries from the provider report", hours: 1.5 }],
  sales_tax: [{ title: "Reconcile sales tax payable and file the return", hours: 2 }],
  form_1099: [{ title: "Update W-9 tracker and vendor payment totals", hours: 1 }],
  monthly_close: [
    { title: "Reconcile every bank and card account", hours: 3 },
    { title: "Substantiate balance sheet accounts", hours: 2.5 },
    { title: "Prepare financial statement package", hours: 1.5 },
    { title: "Close review sign off", hours: 1 },
  ],
  cleanup: [
    { title: "Rebuild prior period transaction coding", hours: 6 },
    { title: "Clear suspense and uncategorized balances", hours: 3 },
  ],
};

export function tasksForScope(clientId: string, scope: string[], period: string, assignee: string, idPrefix: string): Task[] {
  const out: Task[] = [];
  let n = 0;
  const [y, m] = period.split("-").map(Number);
  const due = `${period}-${String(Math.min(daysInMonth(period), 12 + (m % 5))).padStart(2, "0")}`;
  for (const key of scope) {
    for (const t of SCOPE_TASKS[key] || []) {
      n += 1;
      out.push({
        id: `${idPrefix}-${clientId}-${period}-${n}`,
        clientId,
        title: t.title,
        scopeSource: key as Task["scopeSource"],
        period,
        dueDate: due,
        status: "Not started",
        assignee,
        estHours: t.hours,
      });
    }
  }
  void y;
  return out;
}

export function buildDataset(): Dataset {
  const rng = mulberry32(20260815);
  const ri = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  const ds: Dataset = {
    clients: [],
    bankAccounts: [],
    journalEntries: [],
    txns: [],
    rules: [],
    statementLines: [],
    invoices: [],
    bills: [],
    vendors: [],
    substantiations: [],
    openItems: [],
    documents: [],
    audit: [],
    tasks: [],
    team: TEAM,
    comms: [],
    budgets: [],
    signatures: [],
  };

  let jeSeq = 0;
  let txnSeq = 0;

  function post(
    clientId: string,
    date: string,
    memo: string,
    source: JESource,
    lines: JELine[],
    createdBy = "Dana Whitfield",
  ): JournalEntry {
    jeSeq += 1;
    const period = date.slice(0, 7);
    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    if (debits !== credits) {
      throw new Error(`Unbalanced entry ${memo}: ${debits} vs ${credits}`);
    }
    const je: JournalEntry = {
      id: `je-${jeSeq}`,
      ref: `JE-${period.replace("-", "")}-${String(jeSeq).padStart(4, "0")}`,
      clientId,
      date,
      period,
      memo,
      source,
      lines,
      posted: true,
      createdBy,
    };
    ds.journalEntries.push(je);
    return je;
  }

  interface TxnArgs {
    clientId: string;
    date: string;
    description: string;
    vendor: string;
    amountCents: number;
    bankAccountId: string;
    glAccountId: string;
    categoryAccountId: string;
    klass: string;
    location: string;
    job: string;
    currency?: string;
    fxRate?: number;
    jeId?: string;
    isMirror?: boolean;
    status?: Txn["status"];
    suggestedAccountId?: string;
    suggestionReason?: string;
    confidence?: number;
    memo?: string;
    ruleId?: string;
    cleared?: boolean;
  }

  function txn(a: TxnArgs): Txn {
    txnSeq += 1;
    const currency = a.currency || "USD";
    const fxRate = a.fxRate ?? 1;
    const baseAmountCents = currency === "USD" ? a.amountCents : Math.round(a.amountCents * fxRate);
    let jeId = a.jeId || "";
    if (!jeId) {
      const abs = Math.abs(baseAmountCents);
      const lines: JELine[] =
        baseAmountCents < 0
          ? [
              { accountId: a.categoryAccountId, debit: abs, credit: 0, klass: a.klass, location: a.location, job: a.job },
              { accountId: a.glAccountId, debit: 0, credit: abs },
            ]
          : [
              { accountId: a.glAccountId, debit: abs, credit: 0 },
              { accountId: a.categoryAccountId, debit: 0, credit: abs, klass: a.klass, location: a.location, job: a.job },
            ];
      jeId = post(a.clientId, a.date, a.description, "bank", lines).id;
    }
    const t: Txn = {
      id: `tx-${txnSeq}`,
      clientId: a.clientId,
      date: a.date,
      period: a.date.slice(0, 7),
      description: a.description,
      vendor: a.vendor,
      amountCents: a.amountCents,
      currency,
      fxRate,
      baseAmountCents,
      bankAccountId: a.bankAccountId,
      glAccountId: a.glAccountId,
      categoryAccountId: a.categoryAccountId,
      suggestedAccountId: a.suggestedAccountId,
      suggestionReason: a.suggestionReason,
      confidence: a.confidence ?? 0,
      status: a.status || "categorized",
      klass: a.klass,
      location: a.location,
      job: a.job,
      cleared: a.cleared ?? true,
      jeId,
      isMirror: a.isMirror,
      memo: a.memo,
      ruleId: a.ruleId,
    };
    ds.txns.push(t);
    return t;
  }

  const allProfiles = profiles();

  for (const p of allProfiles) {
    const c = p.client;
    ds.clients.push(c);
    ds.bankAccounts.push(...p.banks);
    const checking = p.banks.find((b) => b.kind === "Checking")!;
    const savings = p.banks.find((b) => b.kind === "Savings");
    const card = p.banks.find((b) => b.kind === "Credit card")!;
    const merchant = p.banks.find((b) => b.kind === "Merchant processor");
    const loc = c.locations[0];
    const genJob = c.jobs[c.jobs.length - 1];

    // Opening balances. Retained earnings absorbs the plug so the sheet balances.
    const openLines: JELine[] = [];
    let debitTotal = 0;
    let creditTotal = 0;
    for (const [id, amount] of Object.entries(p.opening)) {
      if (!amount) continue;
      const a = acct(id);
      const naturalDebit = (a.type === "asset" && !a.contra) || (a.type === "expense");
      if (naturalDebit) {
        openLines.push({ accountId: id, debit: amount, credit: 0, memo: "Opening balance" });
        debitTotal += amount;
      } else {
        openLines.push({ accountId: id, debit: 0, credit: amount, memo: "Opening balance" });
        creditTotal += amount;
      }
    }
    const plug = debitTotal - creditTotal;
    if (plug > 0) openLines.push({ accountId: "3200", debit: 0, credit: plug, memo: "Prior year retained earnings" });
    else if (plug < 0) openLines.push({ accountId: "3200", debit: -plug, credit: 0, memo: "Prior year accumulated deficit" });
    post(c.id, "2025-12-31", "Opening trial balance carried from prior year", "opening", openLines, "Trey Hernandez");

    let openInvoices: Invoice[] = [];
    let openBills: Bill[] = [];
    let cardChargesPrior = 0;
    let salesTaxAccrued = p.opening["2200"] || 0;
    let payrollLiabAccrued = p.opening["2300"] || 0;
    let loanBalance = p.opening["2500"] || 0;
    let invSeq = 0;
    let billSeq = 0;
    let deferred = p.opening["2400"] || 0;

    // vendor records
    for (const bv of p.billVendors) {
      ds.vendors.push({
        id: `vn-${c.id}-${ds.vendors.length}`,
        clientId: c.id,
        name: bv.vendor,
        taxClassification: bv.taxClass,
        w9OnFile: bv.w9,
        tinLast4: bv.w9 ? String(ri(1000, 9999)) : undefined,
        ytdPaymentsCents: 0,
        reportable: false,
        requestSentAt: bv.w9 ? undefined : "2026-07-08",
      });
    }

    for (let pi = 0; pi < PERIODS.length; pi++) {
      const period = PERIODS[pi];
      const isCurrent = period === CURRENT_PERIOD;
      const klassMain = c.classes[0];

      // Rent
      txn({
        clientId: c.id, date: dayOf(period, 2), description: `${p.rentPayee.toUpperCase()} RENT`, vendor: p.rentPayee,
        amountCents: -p.rent, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6100",
        klass: c.classes[c.classes.length - 1] === "Management and general" ? "Management and general" : klassMain, location: loc, job: genJob,
      });

      // Utilities
      txn({
        clientId: c.id, date: dayOf(period, 8), description: `${p.utilityPayee.toUpperCase()}`, vendor: p.utilityPayee,
        amountCents: -ri(p.utilities[0], p.utilities[1]), bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6110",
        klass: klassMain, location: loc, job: genJob,
      });

      // Software on the card
      for (let si = 0; si < p.software.length; si++) {
        const s = p.software[si];
        txn({
          clientId: c.id, date: dayOf(period, 4 + si), description: s.desc, vendor: s.vendor,
          amountCents: -s.cents, bankAccountId: card.id, glAccountId: "2010", categoryAccountId: "6130",
          klass: klassMain, location: loc, job: genJob,
        });
        cardChargesPrior += s.cents;
      }

      // Insurance
      txn({
        clientId: c.id, date: dayOf(period, 11), description: "PROVIDENT BUSINESS INSURANCE", vendor: "Provident Insurance",
        amountCents: -p.insurance, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6120",
        klass: klassMain, location: loc, job: genJob,
      });

      // Payroll
      if (p.payroll) {
        for (const runDay of p.payroll.runs) {
          const wages = p.payroll.wages + ri(-40000, 60000);
          const employerTax = Math.round(wages * 0.0847);
          const withheld = Math.round(wages * 0.2062);
          const net = wages - withheld;
          const lines: JELine[] = [
            { accountId: "6000", debit: wages, credit: 0, klass: klassMain, location: loc, job: genJob, memo: "Gross wages" },
            { accountId: "6010", debit: employerTax, credit: 0, klass: klassMain, location: loc, job: genJob, memo: "Employer taxes" },
            { accountId: "1010", debit: 0, credit: net, memo: "Net pay direct deposit" },
            { accountId: "2300", debit: 0, credit: withheld + employerTax, memo: "Withholding and employer taxes payable" },
          ];
          const je = post(c.id, dayOf(period, runDay), `Payroll journal entry for run dated ${dayOf(period, runDay)}`, "payroll", lines);
          payrollLiabAccrued += withheld + employerTax;
          txn({
            clientId: c.id, date: dayOf(period, runDay), description: "PAYROLL NET PAY DIRECT DEPOSIT", vendor: "Payroll provider",
            amountCents: -net, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6000",
            klass: klassMain, location: loc, job: genJob, jeId: je.id, isMirror: true, memo: "Posted from payroll journal entry",
          });
        }
        // Remit prior accrual
        if (payrollLiabAccrued > 0) {
          const remit = payrollLiabAccrued - (isCurrent ? Math.round(payrollLiabAccrued * 0.34) : 0);
          txn({
            clientId: c.id, date: dayOf(period, 20), description: "EFTPS PAYROLL TAX DEPOSIT", vendor: "US Treasury",
            amountCents: -remit, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "2300",
            klass: klassMain, location: loc, job: genJob,
          });
          payrollLiabAccrued -= remit;
        }
      }

      // Loan payment split between interest and principal
      if (p.loan && loanBalance > 0) {
        const interest = Math.round((loanBalance * p.loan.monthlyRateBps) / 10000);
        const principal = p.loan.payment - interest;
        const je = post(c.id, dayOf(period, 14), "Equipment loan payment split between interest and principal", "bank", [
          { accountId: "7000", debit: interest, credit: 0, memo: "Interest portion" },
          { accountId: "2500", debit: principal, credit: 0, memo: "Principal portion" },
          { accountId: "1010", debit: 0, credit: p.loan.payment, memo: "Auto debit" },
        ]);
        loanBalance -= principal;
        txn({
          clientId: c.id, date: dayOf(period, 14), description: "EQUIPMENT LOAN AUTO DEBIT", vendor: "Equipment lender",
          amountCents: -p.loan.payment, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "7000",
          klass: klassMain, location: loc, job: genJob, jeId: je.id, isMirror: true, memo: "Split entry, see journal",
        });
      }

      // Card charges
      let cardThisMonth = 0;
      if (p.inventoryPurchase) {
        const ip = p.inventoryPurchase;
        const amt = ri(ip.min, ip.max);
        cardThisMonth += amt;
        txn({
          clientId: c.id, date: dayOf(period, 5), description: ip.desc, vendor: ip.vendor,
          amountCents: -amt, bankAccountId: card.id, glAccountId: "2010", categoryAccountId: ip.account,
          klass: klassMain, location: loc, job: genJob, cleared: !isCurrent,
          memo: "Inventory purchase, relieved to cost of sales at month end",
        });
      }
      const chargeCount = 2 + (pi % 2);
      const smallVendors = p.cardVendors.filter((v) => v.max <= 100000);
      for (let k = 0; k < chargeCount; k++) {
        const cv = pick(p.cardVendors);
        const amt = ri(cv.min, cv.max);
        cardThisMonth += amt;
        const needsReview = isCurrent && k === 1 && smallVendors.length > 0;
        const shown = needsReview ? smallVendors[0] : cv;
        const shownAmt = needsReview ? ri(shown.min, shown.max) : amt;
        cardThisMonth += shownAmt - amt;
        txn({
          clientId: c.id, date: dayOf(period, 6 + k * 4), description: shown.desc, vendor: shown.vendor,
          amountCents: -shownAmt, bankAccountId: card.id, glAccountId: "2010",
          categoryAccountId: needsReview ? "6900" : cv.account,
          suggestedAccountId: needsReview ? shown.account : undefined,
          suggestionReason: needsReview ? `Matches ${shown.vendor} history on this card` : undefined,
          confidence: needsReview ? ri(71, 94) : 0,
          status: needsReview ? "needs_review" : "categorized",
          klass: c.classes[k % c.classes.length], location: c.locations[k % c.locations.length], job: c.jobs[k % c.jobs.length],
          cleared: !isCurrent,
        });
      }

      // Foreign currency purchase
      if (p.foreign && p.foreign.period === period) {
        txn({
          clientId: c.id, date: dayOf(period, 17), description: p.foreign.desc, vendor: p.foreign.vendor,
          amountCents: -p.foreign.amount, bankAccountId: card.id, glAccountId: "2010", categoryAccountId: p.foreign.account,
          currency: p.foreign.currency, fxRate: p.foreign.rate,
          klass: klassMain, location: loc, job: genJob, cleared: !isCurrent,
          memo: `Booked at ${p.foreign.rate} to USD`,
        });
        cardThisMonth += Math.round(p.foreign.amount * p.foreign.rate);
      }

      // Card payment for prior month charges
      if (cardChargesPrior > 0) {
        txn({
          clientId: c.id, date: dayOf(period, 22), description: `${card.institution.toUpperCase()} CARD PAYMENT`, vendor: card.institution,
          amountCents: -cardChargesPrior, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "2010",
          klass: klassMain, location: loc, job: genJob,
        });
        const payJe = ds.journalEntries[ds.journalEntries.length - 1];
        txn({
          clientId: c.id, date: dayOf(period, 22), description: "PAYMENT RECEIVED THANK YOU", vendor: card.institution,
          amountCents: cardChargesPrior, bankAccountId: card.id, glAccountId: "2010", categoryAccountId: "1010",
          klass: klassMain, location: loc, job: genJob, jeId: payJe.id, isMirror: true, memo: "Transfer from operating checking",
          cleared: !isCurrent,
        });
      }
      cardChargesPrior = cardThisMonth;

      // Bills into AP
      const billsThisMonth: Bill[] = [];
      for (const bv of p.billVendors) {
        for (let n = 0; n < bv.perMonth; n++) {
          billSeq += 1;
          const amt = ri(bv.min, bv.max);
          const date = dayOf(period, 9 + n * 6);
          const je = post(c.id, date, `Vendor bill from ${bv.vendor}`, "bill", [
            { accountId: bv.account, debit: amt, credit: 0, klass: c.classes[n % c.classes.length], location: loc, job: c.jobs[(billSeq + n) % c.jobs.length] },
            { accountId: "2100", debit: 0, credit: amt, memo: bv.vendor },
          ]);
          const bill: Bill = {
            id: `bill-${c.id}-${billSeq}`,
            clientId: c.id,
            number: `${bv.vendor.split(" ")[0].toUpperCase().slice(0, 4)}-${period.replace("-", "")}${n + 1}`,
            vendorId: ds.vendors.find((v) => v.clientId === c.id && v.name === bv.vendor)!.id,
            vendor: bv.vendor,
            date,
            dueDate: addDaysIso(date, 30),
            amountCents: amt,
            paidCents: 0,
            accountId: bv.account,
            jeId: je.id,
          };
          ds.bills.push(bill);
          billsThisMonth.push(bill);
        }
      }
      // Pay prior month bills, leaving the newest period open
      for (const bill of openBills) {
        const payDate = dayOf(period, 18);
        bill.paidCents = bill.amountCents;
        txn({
          clientId: c.id, date: payDate, description: `BILL PAY ${bill.vendor.toUpperCase()}`, vendor: bill.vendor,
          amountCents: -bill.amountCents, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "2100",
          klass: klassMain, location: loc, job: genJob, memo: `Applied to ${bill.number}`,
        });
      }
      openBills = billsThisMonth;

      // Revenue: invoices
      const invoicesThisMonth: Invoice[] = [];
      if (p.revenue.invoices) {
        const cfg = p.revenue.invoices;
        for (let n = 0; n < cfg.perMonth; n++) {
          invSeq += 1;
          const amt = ri(cfg.min, cfg.max);
          const date = dayOf(period, 5 + n * 4);
          const job = c.jobs[invSeq % c.jobs.length];
          const je = post(c.id, date, `Invoice to ${cfg.customers[invSeq % cfg.customers.length]}`, "invoice", [
            { accountId: "1100", debit: amt, credit: 0, memo: "Customer invoice" },
            { accountId: cfg.account, debit: 0, credit: amt, klass: cfg.klass, location: c.locations[n % c.locations.length], job },
          ]);
          const inv: Invoice = {
            id: `inv-${c.id}-${invSeq}`,
            clientId: c.id,
            number: `${c.id.slice(0, 3).toUpperCase()}-${period.replace("-", "")}-${String(n + 1).padStart(2, "0")}`,
            customer: cfg.customers[invSeq % cfg.customers.length],
            date,
            dueDate: addDaysIso(date, 30),
            amountCents: amt,
            paidCents: 0,
            klass: cfg.klass,
            jeId: je.id,
          };
          ds.invoices.push(inv);
          invoicesThisMonth.push(inv);
        }
      }
      // Collect most prior invoices
      openInvoices.forEach((inv, idx) => {
        const holdBack = idx % 5 === 0 && pi >= PERIODS.length - 3;
        if (holdBack) return;
        inv.paidCents = inv.amountCents;
        txn({
          clientId: c.id, date: dayOf(period, 12 + (idx % 8)), description: `CUSTOMER PAYMENT ${inv.customer.toUpperCase()}`, vendor: inv.customer,
          amountCents: inv.amountCents, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "1100",
          klass: inv.klass, location: loc, job: genJob, memo: `Applied to ${inv.number}`,
        });
      });
      openInvoices = [...openInvoices.filter((i) => i.paidCents === 0), ...invoicesThisMonth];

      // Revenue: merchant deposits
      if (p.revenue.merchant) {
        const cfg = p.revenue.merchant;
        for (let n = 0; n < cfg.perMonth; n++) {
          const revenue = ri(cfg.min, cfg.max);
          const tax = Math.round((revenue * cfg.taxBps) / 10000);
          const fee = Math.round(((revenue + tax) * cfg.feeBps) / 10000);
          const net = revenue + tax - fee;
          const date = dayOf(period, 3 + n * 5);
          const lines: JELine[] = [
            { accountId: "1010", debit: net, credit: 0, memo: "Processor payout" },
            { accountId: "5100", debit: fee, credit: 0, klass: cfg.klass, location: loc, job: genJob, memo: "Processing fees" },
            { accountId: cfg.account, debit: 0, credit: revenue, klass: cfg.klass, location: loc, job: genJob },
          ];
          if (tax > 0) lines.push({ accountId: "2200", debit: 0, credit: tax, memo: "Sales tax collected" });
          salesTaxAccrued += tax;
          const je = post(c.id, date, `${cfg.desc} settlement, gross sales less fees`, "bank", lines);
          txn({
            clientId: c.id, date, description: cfg.desc, vendor: merchant ? merchant.institution : "Processor",
            amountCents: net, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: cfg.account,
            klass: cfg.klass, location: loc, job: genJob, jeId: je.id, isMirror: true,
            memo: "Split entry with fees and sales tax",
          });
        }
      }

      // Grants and released restrictions for the nonprofit
      if (p.revenue.grants) {
        const cfg = p.revenue.grants;
        for (let n = 0; n < cfg.perQuarter; n++) {
          const amt = ri(cfg.min, cfg.max);
          const date = dayOf(period, 10 + n * 7);
          txn({
            clientId: c.id, date, description: `GRANT DEPOSIT ${cfg.funders[(pi + n) % cfg.funders.length].toUpperCase()}`,
            vendor: cfg.funders[(pi + n) % cfg.funders.length],
            amountCents: amt, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "4030",
            klass: "Program services", location: loc, job: c.jobs[n % c.jobs.length],
          });
        }
        if (deferred > 0) {
          const release = Math.min(deferred, 462500);
          post(c.id, dayOf(period, 28), "Release restricted grant funds to program revenue", "accrual", [
            { accountId: "2400", debit: release, credit: 0, memo: "Restriction satisfied" },
            { accountId: "4030", debit: 0, credit: release, klass: "Program services", location: loc, job: genJob },
          ], "Priya Raman");
          deferred -= release;
        }
      }

      // Sales tax remittance
      if (salesTaxAccrued > 0 && c.scope.includes("sales_tax")) {
        const remit = isCurrent ? 0 : salesTaxAccrued;
        if (remit > 0) {
          txn({
            clientId: c.id, date: dayOf(period, 19), description: "STATE DEPT OF REVENUE SALES TAX", vendor: "Department of Revenue",
            amountCents: -remit, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "2200",
            klass: klassMain, location: loc, job: genJob,
          });
          salesTaxAccrued -= remit;
        }
      }

      // Bank service charge and one refund
      txn({
        clientId: c.id, date: dayOf(period, 26), description: "MONTHLY ACCOUNT ANALYSIS FEE", vendor: checking.institution,
        amountCents: -ri(1800, 4200), bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6200",
        klass: klassMain, location: loc, job: genJob,
      });
      if (pi % 3 === 1) {
        txn({
          clientId: c.id, date: dayOf(period, 24), description: "CUSTOMER REFUND ISSUED", vendor: "Customer refund",
          amountCents: -ri(4200, 28400), bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "4900",
          klass: klassMain, location: loc, job: genJob,
        });
      }

      // Savings transfer
      if (savings && pi % 2 === 0) {
        const amt = ri(150000, 480000);
        const je = post(c.id, dayOf(period, 27), "Transfer to reserve account", "bank", [
          { accountId: "1020", debit: amt, credit: 0 },
          { accountId: "1010", debit: 0, credit: amt },
        ]);
        txn({
          clientId: c.id, date: dayOf(period, 27), description: "TRANSFER TO RESERVE", vendor: "Internal transfer",
          amountCents: -amt, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "1020",
          klass: klassMain, location: loc, job: genJob, jeId: je.id, isMirror: true,
        });
        txn({
          clientId: c.id, date: dayOf(period, 27), description: "TRANSFER FROM OPERATING", vendor: "Internal transfer",
          amountCents: amt, bankAccountId: savings.id, glAccountId: "1020", categoryAccountId: "1010",
          klass: klassMain, location: loc, job: genJob, jeId: je.id, isMirror: true,
        });
      }

      // Owner distributions each quarter
      if (p.distributions && pi % 3 === 2) {
        txn({
          clientId: c.id, date: dayOf(period, 25), description: "OWNER DISTRIBUTION", vendor: c.owners[0].name,
          amountCents: -p.distributions, bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "3100",
          klass: klassMain, location: loc, job: genJob,
        });
      }

      // Depreciation
      post(c.id, dayOf(period, daysInMonth(period)), `Monthly depreciation for ${period}`, "depreciation", [
        { accountId: "6300", debit: p.depreciation, credit: 0, klass: klassMain, location: loc, job: genJob },
        { accountId: "1510", debit: 0, credit: p.depreciation, memo: "Accumulated depreciation" },
      ], "Priya Raman");

      // One uncategorized checking item in the current period
      if (isCurrent) {
        const guess = pick(p.cardVendors);
        txn({
          clientId: c.id, date: dayOf(period, 16), description: "SQ *UNKNOWN MERCHANT 4021", vendor: "Unidentified",
          amountCents: -ri(18400, 74200), bankAccountId: checking.id, glAccountId: "1010", categoryAccountId: "6900",
          suggestedAccountId: guess.account, suggestionReason: "Description pattern is close to prior supply purchases",
          confidence: ri(52, 68), status: "needs_review",
          klass: klassMain, location: loc, job: genJob, cleared: false,
        });
      }
    }

    // Prepaid amortization so the substantiation screen has a schedule to lean on
    if ((p.opening["1200"] || 0) > 0) {
      const monthly = Math.round((p.opening["1200"] || 0) / 12);
      for (const period of PERIODS) {
        post(c.id, dayOf(period, daysInMonth(period)), `Amortize prepaid insurance for ${period}`, "accrual", [
          { accountId: "6120", debit: monthly, credit: 0, klass: c.classes[0], location: loc, job: genJob },
          { accountId: "1200", debit: 0, credit: monthly, memo: "Prepaid amortization" },
        ], "Priya Raman");
      }
    }
  }

  // Inventory relief for the two inventory clients, so cost of sales moves with revenue
  for (const clientId of ["bramble", "marisol"]) {
    for (const period of PERIODS) {
      const relief = clientId === "bramble" ? 2800000 : 220000;
      post(clientId, dayOf(period, daysInMonth(period)), `Inventory relief to cost of goods sold for ${period}`, "accrual", [
        { accountId: "5000", debit: relief, credit: 0, klass: "Wholesale", location: "Roastery", job: "General" },
        { accountId: "1150", debit: 0, credit: relief, memo: "Period inventory usage" },
      ], "Dana Whitfield");
    }
  }

  // A posted entry and its reversal, to show the immutability rule in the UI
  const wrong = post("northgate", "2026-06-30", "Accrue June utility estimate", "manual", [
    { accountId: "6110", debit: 148600, credit: 0, klass: "Service", location: "Spokane", job: "Shop overhead" },
    { accountId: "2100", debit: 0, credit: 148600, memo: "Estimated accrual" },
  ], "Dana Whitfield");
  const rev = post("northgate", "2026-07-01", "Reversal of June utility estimate, actual invoice received", "reversal", [
    { accountId: "2100", debit: 148600, credit: 0, memo: "Reverse estimate" },
    { accountId: "6110", debit: 0, credit: 148600, klass: "Service", location: "Spokane", job: "Shop overhead" },
  ], "Dana Whitfield");
  rev.reversalOf = wrong.id;
  wrong.reversedBy = rev.id;

  // ---- Categorization rules
  const ruleSeed: Omit<Rule, "id">[] = [
    { clientId: "bramble", name: "Green coffee to cost of goods sold", matchType: "Description contains", matchValue: "HIGHLINE GREEN", accountId: "5000", klass: "Wholesale", hits: 14, createdBy: "Dana Whitfield", createdAt: "2026-01-19", active: true },
    { clientId: "bramble", name: "Square payouts to product sales", matchType: "Description contains", matchValue: "SQUARE PAYOUT", accountId: "4000", klass: "Cafe", hits: 28, createdBy: "Dana Whitfield", createdAt: "2026-01-19", active: true },
    { clientId: "bramble", name: "Fuel to vehicle and fuel", matchType: "Description contains", matchValue: "CHEVRON", accountId: "6170", hits: 9, createdBy: "Owen Baptiste", createdAt: "2026-02-04", active: true },
    { clientId: "northgate", name: "Ferguson supply to job materials", matchType: "Description contains", matchValue: "FERGUSON", accountId: "5000", klass: "Install", hits: 22, createdBy: "Dana Whitfield", createdAt: "2026-04-06", active: true },
    { clientId: "northgate", name: "Fleet fuel to vehicle and fuel", matchType: "Description contains", matchValue: "PACIFIC PRIDE", accountId: "6170", hits: 17, createdBy: "Dana Whitfield", createdAt: "2026-04-06", active: true },
    { clientId: "northgate", name: "Crew meals under fifty dollars", matchType: "Description contains", matchValue: "NORTHTOWN DINER", accountId: "6210", hits: 6, createdBy: "Priya Raman", createdAt: "2026-05-11", active: false },
    { clientId: "marisol", name: "Clay and glaze to cost of goods sold", matchType: "Description contains", matchValue: "CLAY PLANET", accountId: "5000", klass: "Retail", hits: 11, createdBy: "Priya Raman", createdAt: "2026-02-14", active: true },
    { clientId: "marisol", name: "Stripe payouts to product sales", matchType: "Description contains", matchValue: "STRIPE PAYOUT", accountId: "4000", klass: "Retail", hits: 33, createdBy: "Priya Raman", createdAt: "2026-02-14", active: true },
    { clientId: "riverbend", name: "Art supplies to program supplies", matchType: "Description contains", matchValue: "BLICK ART", accountId: "6180", klass: "Program services", hits: 13, createdBy: "Priya Raman", createdAt: "2026-01-27", active: true },
    { clientId: "riverbend", name: "Grant deposits to contributions", matchType: "Description contains", matchValue: "GRANT DEPOSIT", accountId: "4030", klass: "Program services", hits: 8, createdBy: "Owen Baptiste", createdAt: "2026-02-02", active: true },
  ];
  ruleSeed.forEach((r, i) => ds.rules.push({ ...r, id: `rule-${i + 1}` }));

  // ---- Statement lines for reconciliation
  let slSeq = 0;
  for (const ba of ds.bankAccounts) {
    if (!ba.needsReconciling) continue;
    for (const period of PERIODS) {
      const rows = ds.txns.filter((t) => t.bankAccountId === ba.id && t.period === period);
      let heldBack = false;
      let lineIdx = 0;
      for (const t of rows) {
        // Northgate July: hold one issued check back from the statement so the difference is real
        if (!heldBack && ba.id === "ba-n1" && period === "2026-07" && t.description.startsWith("BILL PAY")) {
          heldBack = true;
          continue;
        }
        slSeq += 1;
        lineIdx += 1;
        const leaveOpen = ba.id === "ba-n1" && period === "2026-07" && lineIdx === 3;
        ds.statementLines.push({
          id: `sl-${slSeq}`,
          clientId: ba.clientId,
          bankAccountId: ba.id,
          period,
          date: t.date,
          description: t.description.slice(0, 42),
          amountCents: t.baseAmountCents,
          matchedTxnId: leaveOpen ? undefined : t.id,
        });
      }
      // A bank charge that never made it into the books
      if (ba.id === "ba-n1" && period === "2026-07") {
        slSeq += 1;
        ds.statementLines.push({
          id: `sl-${slSeq}`,
          clientId: ba.clientId,
          bankAccountId: ba.id,
          period,
          date: "2026-07-29",
          description: "WIRE FEE OUTBOUND",
          amountCents: -3500,
        });
      }
    }
  }

  // ---- Substantiation records for the current period
  const subsSeed: { clientId: string; accountId: string; supportType: string; adjust?: number; unsupported?: boolean; note: string; preparedBy: string; reviewedBy?: string }[] = [
    { clientId: "bramble", accountId: "1010", supportType: "Bank statement and reconciliation", note: "Reconciled to the July statement with no open items.", preparedBy: "Dana Whitfield", reviewedBy: "Owen Baptiste" },
    { clientId: "bramble", accountId: "1020", supportType: "Bank statement", note: "Reserve account ties to the July statement.", preparedBy: "Dana Whitfield", reviewedBy: "Owen Baptiste" },
    { clientId: "bramble", accountId: "1100", supportType: "AR aging detail", note: "Aging detail agrees to the subledger.", preparedBy: "Dana Whitfield" },
    { clientId: "bramble", accountId: "1150", supportType: "Physical count worksheet", adjust: -184725, note: "July count came in under the ledger. Green coffee shrink is the likely cause and it needs an adjusting entry.", preparedBy: "Dana Whitfield" },
    { clientId: "bramble", accountId: "2010", supportType: "Card statement", note: "Card statement matches the ledger balance.", preparedBy: "Dana Whitfield" },
    { clientId: "bramble", accountId: "2100", supportType: "AP aging detail", note: "Open bills agree to the aging report.", preparedBy: "Dana Whitfield" },
    { clientId: "bramble", accountId: "2500", supportType: "Loan amortization schedule", note: "Principal balance agrees to the lender schedule.", preparedBy: "Dana Whitfield", reviewedBy: "Trey Hernandez" },
    { clientId: "northgate", accountId: "1010", supportType: "Bank statement and reconciliation", unsupported: true, note: "July statement has not arrived yet, so the account is not substantiated.", preparedBy: "Dana Whitfield" },
    { clientId: "northgate", accountId: "1100", supportType: "AR aging detail", note: "Aging agrees to the job billing schedule.", preparedBy: "Dana Whitfield" },
    { clientId: "northgate", accountId: "1200", supportType: "Prepaid amortization schedule", note: "Schedule agrees after the July amortization entry.", preparedBy: "Priya Raman" },
    { clientId: "northgate", accountId: "2300", supportType: "Payroll provider liability report", note: "Remaining balance is the July 21 run remitted in August.", preparedBy: "Dana Whitfield" },
    { clientId: "northgate", accountId: "2500", supportType: "Loan amortization schedule", note: "Van loan balance agrees to the lender portal.", preparedBy: "Dana Whitfield" },
    { clientId: "marisol", accountId: "1010", supportType: "Bank statement and reconciliation", note: "Reconciled with no outstanding items.", preparedBy: "Priya Raman", reviewedBy: "Owen Baptiste" },
    { clientId: "marisol", accountId: "1150", supportType: "Inventory rollforward", note: "Rollforward agrees to the studio count sheet.", preparedBy: "Priya Raman" },
    { clientId: "marisol", accountId: "1200", supportType: "Prepaid schedule", unsupported: true, note: "No schedule on file for the studio insurance prepayment.", preparedBy: "Priya Raman" },
    { clientId: "marisol", accountId: "2200", supportType: "Sales tax return worksheet", note: "Balance equals July collections due in August.", preparedBy: "Priya Raman" },
    { clientId: "riverbend", accountId: "1010", supportType: "Bank statement and reconciliation", note: "Operating account reconciled through July 31.", preparedBy: "Priya Raman", reviewedBy: "Owen Baptiste" },
    { clientId: "riverbend", accountId: "1020", supportType: "Bank statement", note: "Board reserve ties to the statement.", preparedBy: "Priya Raman" },
    { clientId: "riverbend", accountId: "2400", supportType: "Grant restriction schedule", note: "Remaining restriction agrees to the award letters.", preparedBy: "Priya Raman", reviewedBy: "Trey Hernandez" },
    { clientId: "riverbend", accountId: "2300", supportType: "Payroll provider liability report", note: "Agrees to the Paylocity liability summary.", preparedBy: "Priya Raman" },
  ];
  subsSeed.forEach((s, i) => {
    ds.substantiations.push({
      id: `sub-${i + 1}`,
      clientId: s.clientId,
      accountId: s.accountId,
      period: CURRENT_PERIOD,
      supportType: s.supportType,
      supportedCents: s.unsupported ? null : 0, // resolved against the ledger in the derive layer
      documentIds: [],
      preparedBy: s.preparedBy,
      reviewedBy: s.reviewedBy,
      note: s.note,
    });
    if (s.adjust) {
      // store the intended variance in the note field consumer via a side table
      variances[`${s.clientId}:${s.accountId}`] = s.adjust;
    }
  });

  // ---- Open items and portal requests
  const openSeed: Omit<OpenItem, "id">[] = [
    { clientId: "bramble", accountId: "2010", period: "2026-07", title: "July card statement for Roastery card 8842", detail: "The July PDF is not in the portal yet, so the card cannot be reconciled.", docType: "Credit card statement", requestedFrom: "Nora Bramble", dueDate: "2026-08-18", status: "not_started", documentIds: [] },
    { clientId: "bramble", accountId: "1150", period: "2026-07", title: "Green coffee count sheet backup", detail: "The count came in below the ledger by 1,847.25. Send the tally sheet so the adjustment can be supported.", docType: "Other", requestedFrom: "Isaac Bean", dueDate: "2026-08-19", status: "under_review", documentIds: [], amountCents: 184725 },
    { clientId: "bramble", period: "2026-07", title: "Receipt for the unknown Square charge on July 16", detail: "One checking charge is sitting in Uncategorized Expense until there is a receipt.", docType: "Receipt", requestedFrom: "Devon Ruiz", dueDate: "2026-08-17", status: "uploaded", documentIds: [] },
    { clientId: "bramble", period: "2026-07", title: "W-9 for Cedar Freight Lines", detail: "Payments crossed the 1099 threshold and there is no W-9 on file.", docType: "W-9", requestedFrom: "Nora Bramble", dueDate: "2026-08-22", status: "not_started", documentIds: [] },
    { clientId: "northgate", accountId: "1010", period: "2026-07", title: "July operating statement for checking 7712", detail: "The bank feed dropped on July 24 and the statement is needed to finish the reconciliation.", docType: "Bank statement", requestedFrom: "Alicia Fenn", dueDate: "2026-08-16", status: "uploaded", documentIds: [] },
    { clientId: "northgate", period: "2026-07", title: "Signed change order for the Vista Apartments job", detail: "Billing exceeds the original contract value by 18,400.00 and needs the change order for support.", docType: "Other", requestedFrom: "Marcus Keel", dueDate: "2026-08-20", status: "rejected", rejectionReason: "The file uploaded was the unsigned draft copy.", documentIds: [] },
    { clientId: "northgate", period: "2026-07", title: "W-9 for Keel Crane Rental", detail: "Related party vendor with no W-9 on file and 1099 reportable payments.", docType: "W-9", requestedFrom: "Marcus Keel", dueDate: "2026-08-25", status: "not_started", documentIds: [] },
    { clientId: "marisol", accountId: "1200", period: "2026-07", title: "Studio insurance policy declaration page", detail: "Needed to build the prepaid amortization schedule for the balance sitting on the books.", docType: "Other", requestedFrom: "Marisol Vega", dueDate: "2026-08-21", status: "not_started", documentIds: [] },
    { clientId: "marisol", period: "2026-07", title: "Etsy gross sales report for July", detail: "Deposits are net of fees. The gross report lets the fee split get booked properly.", docType: "Other", requestedFrom: "Marisol Vega", dueDate: "2026-08-18", status: "accepted", documentIds: [] },
    { clientId: "riverbend", accountId: "2400", period: "2026-07", title: "Award letter for the summer Benwood grant", detail: "Needed to confirm how much of the restriction was released in July.", docType: "Other", requestedFrom: "Adaeze Nwosu", dueDate: "2026-08-19", status: "under_review", documentIds: [] },
    { clientId: "riverbend", period: "2026-07", title: "Board approved June minutes", detail: "The minutes support the reserve transfer approval for the audit file.", docType: "Other", requestedFrom: "Grant Tolliver", dueDate: "2026-08-24", status: "not_started", documentIds: [] },
  ];
  openSeed.forEach((o, i) => ds.openItems.push({ ...o, id: `oi-${i + 1}` }));

  // ---- Documents and audit trail
  const docSeed: { clientId: string; name: string; size: number; type: string; period: string; bankAccountId?: string; status: DocRecord["status"]; by: string; at: string; openItemId?: string; note?: string }[] = [
    { clientId: "bramble", name: "First Cascade 4471 July 2026 statement.pdf", size: 284100, type: "Bank statement", period: "2026-07", bankAccountId: "ba-b1", status: "accepted", by: "Nora Bramble", at: "2026-08-03T09:12:00" },
    { clientId: "bramble", name: "Square July payout summary.csv", size: 41200, type: "Other", period: "2026-07", status: "accepted", by: "Devon Ruiz", at: "2026-08-03T09:40:00" },
    { clientId: "bramble", name: "Green coffee count July 31.xlsx", size: 88400, type: "Other", period: "2026-07", status: "under_review", by: "Isaac Bean", at: "2026-08-06T17:24:00", openItemId: "oi-2" },
    { clientId: "bramble", name: "Square charge receipt July 16.jpg", size: 1284000, type: "Receipt", period: "2026-07", status: "uploaded", by: "Devon Ruiz", at: "2026-08-11T08:03:00", openItemId: "oi-3" },
    { clientId: "bramble", name: "Gusto payroll register July.pdf", size: 196400, type: "Payroll report", period: "2026-07", status: "accepted", by: "Nora Bramble", at: "2026-08-02T14:55:00" },
    { clientId: "northgate", name: "Inland NW 7712 July 2026 statement.pdf", size: 331500, type: "Bank statement", period: "2026-07", bankAccountId: "ba-n1", status: "uploaded", by: "Alicia Fenn", at: "2026-08-12T15:31:00", openItemId: "oi-5" },
    { clientId: "northgate", name: "Fleet One 6607 July statement.pdf", size: 214800, type: "Credit card statement", period: "2026-07", bankAccountId: "ba-n3", status: "accepted", by: "Alicia Fenn", at: "2026-08-05T10:18:00" },
    { clientId: "northgate", name: "Vista change order draft.pdf", size: 158200, type: "Other", period: "2026-07", status: "rejected", by: "Marcus Keel", at: "2026-08-09T19:44:00", openItemId: "oi-6", note: "Unsigned draft, a countersigned copy is needed." },
    { clientId: "northgate", name: "ADP payroll summary July.pdf", size: 241100, type: "Payroll report", period: "2026-07", status: "accepted", by: "Alicia Fenn", at: "2026-08-04T11:07:00" },
    { clientId: "northgate", name: "Redline Sheet Metal invoice 4471.pdf", size: 96800, type: "Invoice", period: "2026-07", status: "accepted", by: "Alicia Fenn", at: "2026-08-04T11:22:00" },
    { clientId: "marisol", name: "Sandia 2286 July statement.pdf", size: 174200, type: "Bank statement", period: "2026-07", bankAccountId: "ba-m1", status: "accepted", by: "Marisol Vega", at: "2026-08-02T20:11:00" },
    { clientId: "marisol", name: "Etsy gross sales July.csv", size: 22800, type: "Other", period: "2026-07", status: "accepted", by: "Marisol Vega", at: "2026-08-07T21:02:00", openItemId: "oi-9" },
    { clientId: "marisol", name: "Kiln repair receipt.jpg", size: 984000, type: "Receipt", period: "2026-07", status: "accepted", by: "Marisol Vega", at: "2026-08-08T18:37:00" },
    { clientId: "marisol", name: "Sandia 2286 July statement.pdf", size: 174200, type: "Bank statement", period: "2026-07", bankAccountId: "ba-m1", status: "duplicate", by: "Marisol Vega", at: "2026-08-09T07:19:00", note: "Same file name and size as an accepted upload." },
    { clientId: "riverbend", name: "TVB 1180 July statement.pdf", size: 262300, type: "Bank statement", period: "2026-07", bankAccountId: "ba-r1", status: "accepted", by: "Adaeze Nwosu", at: "2026-08-03T13:26:00" },
    { clientId: "riverbend", name: "Benwood award letter 2026.pdf", size: 142600, type: "Other", period: "2026-07", status: "under_review", by: "Adaeze Nwosu", at: "2026-08-10T16:44:00", openItemId: "oi-10" },
    { clientId: "riverbend", name: "Paylocity liability report July.pdf", size: 188900, type: "Payroll report", period: "2026-07", status: "accepted", by: "Sasha Lim", at: "2026-08-04T09:58:00" },
    { clientId: "riverbend", name: "Teaching Artists W-9 2026.pdf", size: 78400, type: "W-9", period: "2026-07", status: "accepted", by: "Adaeze Nwosu", at: "2026-07-29T12:14:00" },
  ];
  docSeed.forEach((d, i) => {
    const id = `doc-${i + 1}`;
    ds.documents.push({
      id,
      clientId: d.clientId,
      name: d.name,
      sizeBytes: d.size,
      mime: d.name.endsWith(".pdf") ? "application/pdf" : d.name.endsWith(".csv") ? "text/csv" : d.name.endsWith(".xlsx") ? "application/vnd.openxmlformats" : "image/jpeg",
      docType: d.type,
      period: d.period,
      bankAccountId: d.bankAccountId,
      status: d.status,
      progress: 100,
      uploadedBy: d.by,
      uploadedAt: d.at,
      openItemId: d.openItemId,
      note: d.note,
    });
    if (d.openItemId) {
      const oi = ds.openItems.find((o) => o.id === d.openItemId);
      if (oi) oi.documentIds.push(id);
    }
    const firmActor = ds.clients.find((c) => c.id === d.clientId)!.lead;
    ds.audit.push({
      id: `au-${ds.audit.length + 1}`, clientId: d.clientId, docId: id, docName: d.name,
      actor: d.by, plane: "Client portal", action: "uploaded", at: d.at,
      detail: `Uploaded and classified as ${d.type} for ${d.period}`,
    });
    ds.audit.push({
      id: `au-${ds.audit.length + 1}`, clientId: d.clientId, docId: id, docName: d.name,
      actor: firmActor, plane: "Firm", action: "viewed", at: d.at.slice(0, 11) + "16:05:00",
      detail: "Opened in the document review queue",
    });
    if (d.status === "accepted") {
      ds.audit.push({
        id: `au-${ds.audit.length + 1}`, clientId: d.clientId, docId: id, docName: d.name,
        actor: firmActor, plane: "Firm", action: "accepted", at: d.at.slice(0, 11) + "16:12:00",
        detail: "Accepted and linked to the period workpapers",
      });
    }
    if (d.status === "rejected") {
      ds.audit.push({
        id: `au-${ds.audit.length + 1}`, clientId: d.clientId, docId: id, docName: d.name,
        actor: firmActor, plane: "Firm", action: "rejected", at: d.at.slice(0, 11) + "17:02:00",
        detail: d.note || "Rejected back to the client",
      });
    }
    if (d.status === "duplicate") {
      ds.audit.push({
        id: `au-${ds.audit.length + 1}`, clientId: d.clientId, docId: id, docName: d.name,
        actor: "Ledger Legends intake", plane: "Firm", action: "classified", at: d.at.slice(0, 11) + "07:19:30",
        detail: "Flagged as a duplicate of an accepted upload",
      });
    }
  });

  // Link substantiation support documents
  const supportLinks: Record<string, string[]> = {
    "bramble:1010": ["doc-1"],
    "bramble:1150": ["doc-3"],
    "northgate:1010": [],
    "northgate:2300": ["doc-9"],
    "marisol:1010": ["doc-11"],
    "riverbend:1010": ["doc-15"],
    "riverbend:2400": ["doc-16"],
  };
  for (const s of ds.substantiations) {
    s.documentIds = supportLinks[`${s.clientId}:${s.accountId}`] || [];
  }

  // ---- Signatures
  for (const c of ds.clients) {
    if (c.engagement.signedBy && c.engagement.signedAt) {
      ds.signatures.push({
        id: `sig-${c.id}`,
        clientId: c.id,
        documentTitle: `Engagement letter and fee agreement, ${c.dba}`,
        signerName: c.engagement.signedBy,
        signerRole: c.contacts[0].role,
        mode: c.engagement.signatureMode || "typed",
        signedAt: c.engagement.signedAt,
        ip: "70.114.22." + (18 + ds.signatures.length),
      });
      ds.audit.push({
        id: `au-${ds.audit.length + 1}`, clientId: c.id, docName: `Engagement letter, ${c.dba}`,
        actor: c.engagement.signedBy, plane: "Client portal", action: "signed", at: c.engagement.signedAt,
        detail: `Signed by ${c.engagement.signatureMode === "drawn" ? "drawn signature" : "typed name"}`,
      });
    }
  }

  // ---- Tasks from engagement scope
  const statusCycle: Task["status"][] = ["Done", "In progress", "Review", "Not started", "Blocked", "Done", "In progress"];
  let taskIdx = 0;
  for (const c of ds.clients) {
    const members = TEAM.filter((m) => m.clients.includes(c.id));
    for (const period of ["2026-06", "2026-07"]) {
      const built = tasksForScope(c.id, c.scope, period, c.lead, "task");
      built.forEach((t, i) => {
        taskIdx += 1;
        const done = period === "2026-06";
        t.status = done ? "Done" : statusCycle[(taskIdx + i) % statusCycle.length];
        t.assignee = members[(i + taskIdx) % members.length].name;
        if (period === "2026-07" && i % 4 === 0) t.dueDate = "2026-08-12";
        ds.tasks.push(t);
      });
    }
    // setup tasks for the client still in cleanup
    if (c.onboardingStage !== "Live") {
      ds.tasks.push({
        id: `task-setup-${c.id}`,
        clientId: c.id,
        title: "Finish onboarding checklist and confirm opening balances",
        scopeSource: "setup",
        period: CURRENT_PERIOD,
        dueDate: "2026-08-14",
        status: "In progress",
        assignee: c.lead,
        estHours: 4,
      });
    }
  }

  // ---- Communication log
  const commSeed: Omit<CommEntry, "id">[] = [
    { clientId: "bramble", at: "2026-08-11T08:12:00", channel: "Portal message", direction: "Inbound", who: "Devon Ruiz", subject: "Receipt for the odd Square charge", body: "Uploaded the receipt for the July 16 charge. It was a replacement grinder burr set from a pop up supplier.", linkedItemId: "oi-3" },
    { clientId: "bramble", at: "2026-08-11T09:02:00", channel: "Portal message", direction: "Outbound", who: "Dana Whitfield", subject: "Thanks, coding it now", body: "Got it. Coding to cost of goods sold and building a rule so the next one lands automatically.", linkedItemId: "oi-3" },
    { clientId: "bramble", at: "2026-08-07T15:41:00", channel: "Email", direction: "Outbound", who: "Dana Whitfield", subject: "July close, two open items", body: "We need the card statement for 8842 and the count sheet backup. Everything else for July is done." },
    { clientId: "bramble", at: "2026-07-28T11:30:00", channel: "Call", direction: "Outbound", who: "Dana Whitfield", subject: "Pricing review call", body: "Walked through wholesale margin by class. Nora wants a monthly view of cafe versus wholesale gross margin." },
    { clientId: "northgate", at: "2026-08-12T15:35:00", channel: "Portal message", direction: "Inbound", who: "Alicia Fenn", subject: "July statement uploaded", body: "The July statement for 7712 is in the portal. The bank was slow mailing it this month.", linkedItemId: "oi-5" },
    { clientId: "northgate", at: "2026-08-09T20:02:00", channel: "Email", direction: "Inbound", who: "Marcus Keel", subject: "Change order", body: "Sending the Vista change order. I think this is the signed one." },
    { clientId: "northgate", at: "2026-08-10T08:15:00", channel: "Email", direction: "Outbound", who: "Dana Whitfield", subject: "Change order needs signatures", body: "That copy is the draft with no signatures. Please send the countersigned version so the extra billing has support.", linkedItemId: "oi-6" },
    { clientId: "northgate", at: "2026-08-01T09:00:00", channel: "Call", direction: "Inbound", who: "Marcus Keel", subject: "Job costing cleanup", body: "Marcus approved the cleanup plan for job tags from January through March. Budget is 12 hours." },
    { clientId: "marisol", at: "2026-08-08T18:40:00", channel: "Portal message", direction: "Inbound", who: "Marisol Vega", subject: "Kiln repair receipt", body: "Here is the receipt from Ridgeline. They also quoted a full element replacement for the fall." },
    { clientId: "marisol", at: "2026-08-09T07:22:00", channel: "Portal message", direction: "Outbound", who: "Priya Raman", subject: "Duplicate statement", body: "The second copy of the July statement was flagged as a duplicate, no action needed on your side." },
    { clientId: "marisol", at: "2026-07-31T14:05:00", channel: "Email", direction: "Outbound", who: "Priya Raman", subject: "Sales tax filed", body: "June sales tax return is filed and the payment cleared. July is due August 25." },
    { clientId: "riverbend", at: "2026-08-10T16:50:00", channel: "Portal message", direction: "Inbound", who: "Adaeze Nwosu", subject: "Benwood award letter", body: "Attached the award letter. The restriction runs through the end of the summer program." },
    { clientId: "riverbend", at: "2026-08-05T10:12:00", channel: "Email", direction: "Outbound", who: "Priya Raman", subject: "July close package", body: "Draft statements are ready for treasurer review. Functional expense split held steady at 78 percent program." },
    { clientId: "riverbend", at: "2026-08-13T09:30:00", channel: "Call", direction: "Outbound", who: "Owen Baptiste", subject: "Audit prep timing", body: "Agreed to start FY2026 audit prep the second week of September and to pre build the restriction schedule." },
  ];
  commSeed.forEach((m, i) => ds.comms.push({ ...m, id: `cm-${i + 1}` }));

  // ---- Budgets built from the shape of actual activity, with deliberate spread
  const actualByKey: Record<string, number> = {};
  for (const je of ds.journalEntries) {
    if (je.source === "opening") continue;
    for (const l of je.lines) {
      const a = acct(l.accountId);
      if (a.type !== "revenue" && a.type !== "expense") continue;
      const signed = a.type === "revenue" ? l.credit - l.debit : l.debit - l.credit;
      const key = `${je.clientId}|${l.accountId}|${je.period}`;
      actualByKey[key] = (actualByKey[key] || 0) + signed;
    }
  }
  const spread = [104, 96, 112, 91, 100, 108, 94, 87, 103];
  Object.entries(actualByKey).forEach(([key, actual], i) => {
    const [clientId, accountId, period] = key.split("|");
    if (accountId === "6900") return;
    const factor = spread[(i + accountId.charCodeAt(3)) % spread.length];
    ds.budgets.push({
      clientId,
      accountId,
      period,
      amountCents: Math.round((actual * factor) / 10000) * 100,
    });
  });

  return ds;
}
