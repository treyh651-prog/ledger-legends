import { buildDataset, PERIODS, CURRENT_PERIOD } from "../client/src/data/seed";
import {
  balanceSheet,
  cashFlow,
  trialBalance,
  profitAndLoss,
  substantiationViews,
  reconSummary,
  vendorViews,
  cashForecast,
  monthlyNarrative,
  openInvoices,
  openBills,
  netBalances,
} from "../client/src/data/derive";
import { acct } from "../client/src/data/coa";
import { SUSPENSE_REASON_BY_CODE } from "../client/src/data/suspense";

const ds = buildDataset();
let fail = 0;
const bad = (m: string) => {
  fail += 1;
  console.log("FAIL " + m);
};

console.log(
  `clients=${ds.clients.length} txns=${ds.txns.length} entries=${ds.journalEntries.length} invoices=${ds.invoices.length} bills=${ds.bills.length} statementLines=${ds.statementLines.length} budgets=${ds.budgets.length}`,
);

for (const je of ds.journalEntries) {
  const d = je.lines.reduce((s, l) => s + l.debit, 0);
  const c = je.lines.reduce((s, l) => s + l.credit, 0);
  if (d !== c) bad(`entry ${je.ref} unbalanced ${d} vs ${c}`);
  if (!Number.isInteger(d)) bad(`entry ${je.ref} has non integer cents`);
}

for (const c of ds.clients) {
  for (const p of PERIODS) {
    const tb = trialBalance(ds, c.id, p);
    if (tb.totalDebit !== tb.totalCredit) bad(`${c.id} ${p} trial balance off by ${tb.totalDebit - tb.totalCredit}`);
    const bs = balanceSheet(ds, c.id, p);
    if (!bs.balanced) bad(`${c.id} ${p} balance sheet off by ${bs.difference}`);
    const cf = cashFlow(ds, c.id, p);
    if (!cf.ties) bad(`${c.id} ${p} cash flow does not tie: ${cf.beginningCash} + ${cf.netChange} != ${cf.endingCash}`);
    const pl = profitAndLoss(ds, c.id, p);
    if (true) {
      console.log(
        `${c.shortName.padEnd(22)} ${p} revenue=${(pl.revenue / 100).toFixed(2).padStart(12)} net=${(pl.netIncome / 100).toFixed(2).padStart(12)} cash=${(cf.endingCash / 100).toFixed(2).padStart(12)} assets=${(bs.totalAssets / 100).toFixed(2).padStart(12)}`,
      );
    }
  }
  // AR and AP subledger must agree with the general ledger
  const nets = netBalances(ds, c.id, { through: CURRENT_PERIOD });
  const arGl = nets["1100"] || 0;
  const arSub = openInvoices(ds, c.id).reduce((s, i) => s + i.amountCents - i.paidCents, 0);
  if (arGl !== arSub) bad(`${c.id} AR ledger ${arGl} vs subledger ${arSub}`);
  const apGl = -(nets["2100"] || 0);
  const apSub = openBills(ds, c.id).reduce((s, b) => s + b.amountCents - b.paidCents, 0);
  if (apGl !== apSub) bad(`${c.id} AP ledger ${apGl} vs subledger ${apSub}`);

  const subs = substantiationViews(ds, c.id);
  console.log(
    `  substantiation ${c.id}: tied=${subs.filter((s) => s.status === "tied").length} variance=${subs.filter((s) => s.status === "variance").length} unsupported=${subs.filter((s) => s.status === "unsupported").length}`,
  );
  for (const b of ds.bankAccounts.filter((b) => b.clientId === c.id && b.needsReconciling)) {
    const r = reconSummary(ds, c.id, b.id, CURRENT_PERIOD);
    if (r.difference !== 0) console.log(`  open recon ${c.id} ${b.nickname}: difference ${(r.difference / 100).toFixed(2)}`);
  }
  const v = vendorViews(ds, c.id);
  console.log(`  vendors ${c.id}: ${v.map((x) => `${x.name} ${(x.ytdPaymentsCents / 100).toFixed(0)}${x.reportable ? " 1099" : ""}${x.w9OnFile ? "" : " noW9"}`).join(" | ")}`);
  const fc = cashForecast(ds, c.id);
  if (fc.length !== 13) bad(`${c.id} forecast weeks ${fc.length}`);
  const nar = monthlyNarrative(ds, c.id);
  if (nar.length < 5) bad(`${c.id} narrative points ${nar.length}`);
  const suspense = nets["1990"] || 0;
  console.log(`  suspense balance ${c.id}: ${(suspense / 100).toFixed(2)}, needs review txns ${ds.txns.filter((t) => t.clientId === c.id && t.status === "needs_review").length}`);
  // Doc 00 Part 1. Suspense is an asset on the balance sheet, never an expense.
  const suspenseAcct = acct("1990");
  if (!suspenseAcct || suspenseAcct.type !== "asset" || !suspenseAcct.suspense) bad("1990 must be the asset suspense account");
  if (acct("6900")) bad("6900 uncategorized expense must not exist");
  for (const id of ["1900", "1910", "1920", "1930"]) if (!acct(id)) bad(`clearing account ${id} missing from the chart`);
  // Every amount parked in suspense carries a reason code from doc 00 Part 4.
  for (const t of ds.txns.filter((t) => t.clientId === c.id && t.categoryAccountId === "1990")) {
    if (!t.suspenseReason) bad(`${t.id} sits in suspense with no reason code`);
    else if (!SUSPENSE_REASON_BY_CODE[t.suspenseReason]) bad(`${t.id} has unknown suspense reason ${t.suspenseReason}`);
    if (!t.suspenseOpenedOn) bad(`${t.id} sits in suspense with no opened date`);
  }
  // No transaction may point at an expense account for unresolved work.
  for (const t of ds.txns.filter((t) => t.clientId === c.id && t.status === "needs_review")) {
    if (t.categoryAccountId !== "1990") bad(`${t.id} needs review but is coded to ${t.categoryAccountId}`);
  }
}

// Sanity: no account outside the chart
for (const je of ds.journalEntries) for (const l of je.lines) if (!acct(l.accountId)) bad(`unknown account ${l.accountId}`);

console.log(fail === 0 ? "ALL CHECKS PASSED" : `${fail} checks failed`);
process.exit(fail === 0 ? 0 : 1);
