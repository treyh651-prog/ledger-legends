/**
 * statement-taxonomy.ts tests. Every block the cascade already classifies
 * accounts into has to carry a label a person would recognize, and the label
 * has to be derived from the account number alone, never hand entered.
 */

import { assert, assertEqual, test } from "./harness";
import { blockOf, type AccountBlock } from "../runs/close-shared";
import { STATEMENT_LINE_BY_BLOCK, statementLineOf } from "../runs/statement-taxonomy";

const ALL_BLOCKS: readonly AccountBlock[] = [
  "cash",
  "receivable",
  "inventory",
  "prepaid",
  "other_receivable",
  "fixed_asset",
  "accum_depreciation",
  "intangible",
  "deposit",
  "clearing",
  "payable",
  "card",
  "accrued",
  "payroll",
  "sales_tax",
  "deferred_revenue",
  "debt_current",
  "debt_long",
  "related_party",
  "equity",
  "revenue",
  "cogs",
  "opex",
  "other_income_expense",
  "memo",
];

test("every account block has a non empty statement line label", () => {
  for (const block of ALL_BLOCKS) {
    const label = STATEMENT_LINE_BY_BLOCK[block];
    assert(typeof label === "string" && label.trim().length > 0, `${block} has a label`);
  }
});

test("statementLineOf is derived from blockOf, never a second classification", () => {
  const samples = ["1010", "1100", "1200", "2000", "3000", "4100", "5100", "6400", "9000"];
  for (const number of samples) {
    assertEqual(
      statementLineOf(number),
      STATEMENT_LINE_BY_BLOCK[blockOf(number)],
      `${number} resolves through blockOf, not a separate number range`,
    );
  }
});
