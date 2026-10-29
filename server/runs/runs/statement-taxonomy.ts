/**
 * The financial statement taxonomy. One label per account block.
 *
 * Doc 01-categories-and-charts.md Part 1.2 names a STATEMENT grouping that is
 * "derived, never hand maintained," built from the account's block and type.
 * blockOf() in close-shared.ts already is that derivation; this module adds
 * nothing to it but a name a person would recognize on a balance sheet or an
 * income statement. It is the one place "which statement line" is answered,
 * so a label change here reaches every reader instead of needing a second
 * place kept in sync by hand.
 */

import { blockOf, type AccountBlock } from "./close-shared";

export const STATEMENT_LINE_BY_BLOCK: Record<AccountBlock, string> = {
  cash: "Cash",
  receivable: "Accounts receivable",
  inventory: "Inventory",
  prepaid: "Prepaid expenses",
  other_receivable: "Other receivables",
  fixed_asset: "Fixed assets",
  accum_depreciation: "Accumulated depreciation",
  intangible: "Intangible assets",
  deposit: "Deposits",
  clearing: "Clearing",
  payable: "Accounts payable",
  card: "Credit cards payable",
  accrued: "Accrued liabilities",
  payroll: "Payroll liabilities",
  sales_tax: "Sales tax payable",
  deferred_revenue: "Deferred revenue",
  debt_current: "Current portion of long term debt",
  debt_long: "Long term debt",
  related_party: "Related party balances",
  equity: "Equity",
  revenue: "Revenue",
  cogs: "Cost of goods sold",
  opex: "Operating expenses",
  other_income_expense: "Other income and expense",
  memo: "Memo",
};

/** The statement line label for an account number, derived from its block. */
export function statementLineOf(accountNumber: string): string {
  return STATEMENT_LINE_BY_BLOCK[blockOf(accountNumber)];
}
