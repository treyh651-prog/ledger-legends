import { useMemo, useState } from "react";
import { Check, Filter, Search, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { ACCOUNTS, acct } from "@/data/coa";
import { netBalances } from "@/data/derive";
import { fmtPeriod, fmtShortDate, usd } from "@/lib/money";
import type { Txn } from "@/data/types";

const CATEGORY_CHOICES = ACCOUNTS.filter((a) => a.type === "expense" || a.type === "revenue" || a.subtype === "Other current assets" || a.subtype === "Inventory");

export default function Transactions() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, categorize, acceptSuggestion, rejectSuggestion, excludeTxns, createRuleFromTxn } = useApp();
  const { toast } = useToast();
  const [status, setStatus] = useState<"all" | "needs_review" | "categorized" | "excluded">("all");
  const [scope, setScope] = useState<"period" | "all">("period");
  const [bank, setBank] = useState("all");
  const [klass, setKlass] = useState("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAccount, setBulkAccount] = useState("");
  const [ruleFor, setRuleFor] = useState<Txn | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleAccount, setRuleAccount] = useState("");

  const banks = ds.bankAccounts.filter((b) => b.clientId === activeClientId);

  const rows = useMemo(() => {
    return ds.txns
      .filter((t) => t.clientId === activeClientId)
      .filter((t) => (scope === "period" ? t.period === period : true))
      .filter((t) => (status === "all" ? true : t.status === status))
      .filter((t) => (bank === "all" ? true : t.bankAccountId === bank))
      .filter((t) => (klass === "all" ? true : t.klass === klass))
      .filter((t) => {
        if (!q.trim()) return true;
        const needle = q.toLowerCase();
        return (
          t.description.toLowerCase().includes(needle) ||
          t.vendor.toLowerCase().includes(needle) ||
          acct(t.categoryAccountId).name.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [ds, activeClientId, period, scope, status, bank, klass, q]);

  const needsReview = ds.txns.filter((t) => t.clientId === activeClientId && t.status === "needs_review");
  const suspense = netBalances(ds, activeClientId, { through: period })["6900"] || 0;
  const allSelected = rows.length > 0 && selected.length === rows.length;

  const bankName = (id: string) => banks.find((b) => b.id === id)?.nickname || id;

  return (
    <>
      <PageHeader
        title="Transaction feed"
        subtitle={`Bank and card activity for ${activeClient.dba}. Every category change rewrites the ledger line behind the transaction, so the books stay in balance.`}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStatus("needs_review");
              setScope("all");
            }}
            data-testid="button-jump-review"
          >
            Show what needs a category
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Rows in view" value={rows.length} hint={scope === "period" ? fmtPeriod(period) : "All periods"} testId="kpi-rows" />
        <Kpi label="Waiting on a category" value={needsReview.length} tone={needsReview.length ? "watch" : "good"} hint="Across every period" testId="kpi-needsreview" />
        <Kpi
          label="Sitting in suspense"
          value={usd(suspense)}
          tone={suspense ? "risk" : "good"}
          hint="Uncategorized expense, account 6900"
          testId="kpi-suspense"
        />
        <Kpi label="Money in view" value={usd(rows.reduce((s, t) => s + t.baseAmountCents, 0))} hint="Net of the filtered rows" testId="kpi-net" />
      </div>

      {needsReview.length ? (
        <SectionCard
          title="Suggestions from the rules engine"
          description="Each suggestion says why it was made. Accept it, reject it, or turn it into a permanent rule."
          bodyClassName="p-0"
          testId="card-suggestions"
        >
          <ul className="divide-y divide-border">
            {needsReview.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{t.description}</p>
                    <span className="tnum text-sm text-muted-foreground">{usd(t.baseAmountCents)}</span>
                    <Pill tone="watch">{fmtShortDate(t.date)}</Pill>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                    {t.suggestedAccountId ? (
                      <>
                        Suggests {acct(t.suggestedAccountId).code} {acct(t.suggestedAccountId).name}. {t.suggestionReason}
                      </>
                    ) : (
                      <>{t.suggestionReason || "No suggestion, pick a category by hand."}</>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {t.suggestedAccountId ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          acceptSuggestion(t.id);
                          toast({ title: "Category applied", description: `${t.description} posted to ${acct(t.suggestedAccountId!).name}.` });
                        }}
                        data-testid={`button-accept-${t.id}`}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        Accept
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => rejectSuggestion(t.id)} data-testid={`button-reject-${t.id}`}>
                        <X className="mr-1 h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRuleFor(t);
                      setRuleName(`${t.vendor} to ${acct(t.suggestedAccountId || "6900").name}`);
                      setRuleAccount(t.suggestedAccountId || "");
                    }}
                    data-testid={`button-makerule-${t.id}`}
                  >
                    <Wand2 className="mr-1 h-3.5 w-3.5" />
                    Make a rule
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Filters" testId="card-filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5 lg:col-span-2">
            <Label className="text-xs">Search</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vendor, description, or account" className="pl-8" data-testid="input-search" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger data-testid="select-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every status</SelectItem>
                <SelectItem value="needs_review">Needs a category</SelectItem>
                <SelectItem value="categorized">Categorized</SelectItem>
                <SelectItem value="excluded">Excluded</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Account</Label>
            <Select value={bank} onValueChange={setBank}>
              <SelectTrigger data-testid="select-bank">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {banks.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.nickname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Class</Label>
            <Select value={klass} onValueChange={setKlass}>
              <SelectTrigger data-testid="select-class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All classes</SelectItem>
                {activeClient.classes.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="flex rounded-sm border border-border bg-muted p-0.5">
            {(["period", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${scope === s ? "bg-card font-medium" : "text-muted-foreground"}`}
                data-testid={`button-scope-${s}`}
              >
                {s === "period" ? fmtPeriod(period) : "Every period"}
              </button>
            ))}
          </div>
          {q || status !== "all" || bank !== "all" || klass !== "all" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQ("");
                setStatus("all");
                setBank("all");
                setKlass("all");
              }}
              data-testid="button-clear-filters"
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </SectionCard>

      {selected.length ? (
        <div className="sticky top-0 z-20 flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-3 sm:flex-row sm:items-center" data-testid="bar-bulk">
          <p className="text-sm font-medium">
            <span className="tnum">{selected.length}</span> selected
          </p>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Select value={bulkAccount} onValueChange={setBulkAccount}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[280px]" data-testid="select-bulk-account">
                <SelectValue placeholder="Move to account" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_CHOICES.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!bulkAccount}
              onClick={() => {
                categorize(selected, bulkAccount);
                toast({ title: "Rows recoded", description: `${selected.length} transactions now post to ${acct(bulkAccount).name}.` });
                setSelected([]);
                setBulkAccount("");
              }}
              data-testid="button-bulk-apply"
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                excludeTxns(selected);
                toast({ title: "Rows excluded", description: "Excluded rows stay in the feed but drop out of the statements." });
                setSelected([]);
              }}
              data-testid="button-bulk-exclude"
            >
              Exclude
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])} data-testid="button-bulk-clear">
              Clear selection
            </Button>
          </div>
        </div>
      ) : null}

      <SectionCard bodyClassName="p-0" testId="card-txn-table">
        <DataGrid
          rows={rows}
          rowKey={(t) => t.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          empty={
            <EmptyState
              title="No transactions match those filters"
              body="Widen the period, clear the search, or switch the status filter to see more rows."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    setQ("");
                    setStatus("all");
                    setBank("all");
                    setKlass("all");
                    setScope("all");
                  }}
                  data-testid="button-empty-clear"
                >
                  Clear every filter
                </Button>
              }
            />
          }
          cols={[
            {
              key: "select",
              label: "",
              width: "36px",
              mobile: "hide",
              render: (t) => (
                <Checkbox
                  checked={selected.includes(t.id)}
                  onCheckedChange={(v) => setSelected((prev) => (v ? [...prev, t.id] : prev.filter((x) => x !== t.id)))}
                  aria-label="Select row"
                  data-testid={`checkbox-${t.id}`}
                />
              ),
              headClassName: "w-9",
            },
            { key: "date", label: "Date", width: "92px", mobile: "sub", render: (t) => <span className="tnum whitespace-nowrap text-xs">{fmtShortDate(t.date)}</span> },
            {
              key: "desc",
              label: "Description",
              mobile: "title",
              render: (t) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.description}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {bankName(t.bankAccountId)}
                    {t.memo ? `, ${t.memo}` : ""}
                  </p>
                </div>
              ),
            },
            {
              key: "category",
              label: "Category",
              width: "230px",
              mobile: "row",
              render: (t) => (
                <Select value={t.categoryAccountId} onValueChange={(v) => categorize([t.id], v)}>
                  <SelectTrigger className="h-7 text-xs" data-testid={`select-category-${t.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_CHOICES.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            { key: "class", label: "Class", mobile: "row", render: (t) => <span className="text-xs">{t.klass}</span> },
            { key: "location", label: "Location", mobile: "row", render: (t) => <span className="text-xs">{t.location}</span> },
            { key: "job", label: "Job", mobile: "row", render: (t) => <span className="text-xs">{t.job}</span> },
            {
              key: "fx",
              label: "Currency",
              align: "right",
              mobile: "row",
              render: (t) =>
                t.currency === "USD" ? (
                  <span className="text-xs text-muted-foreground">USD</span>
                ) : (
                  <span className="tnum whitespace-nowrap text-xs">
                    {t.currency} {(t.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} at {t.fxRate}
                  </span>
                ),
            },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              width: "120px",
              mobile: "value",
              render: (t) => <Money cents={t.baseAmountCents} signed />,
            },
            {
              key: "status",
              label: "State",
              align: "right",
              mobile: "row",
              render: (t) => (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {t.status === "needs_review" ? <Pill tone="watch">Needs a category</Pill> : null}
                  {t.status === "excluded" ? <Pill>Excluded</Pill> : null}
                  {t.status === "categorized" ? <Pill tone="good">Coded</Pill> : null}
                  {t.cleared ? <Pill tone="info">Cleared</Pill> : null}
                  {t.ruleId ? <Pill tone="info">Rule</Pill> : null}
                </div>
              ),
            },
          ]}
          footer={
            <tr>
              <td colSpan={4} className="px-3 py-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => setSelected(v ? rows.map((r) => r.id) : [])}
                    aria-label="Select every row in view"
                    data-testid="checkbox-select-all"
                  />
                  Select every row in view
                </label>
              </td>
              <td colSpan={4} />
              <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(rows.reduce((s, t) => s + t.baseAmountCents, 0))}</td>
              <td />
            </tr>
          }
        />
      </SectionCard>

      <Dialog open={Boolean(ruleFor)} onOpenChange={(o) => !o && setRuleFor(null)}>
        <DialogContent data-testid="dialog-rule">
          <DialogHeader>
            <DialogTitle>Create a categorization rule</DialogTitle>
            <DialogDescription>
              Future transactions that match this pattern get coded the same way. You can switch a rule off at any time.
            </DialogDescription>
          </DialogHeader>
          {ruleFor ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Rule name</Label>
                <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} data-testid="input-rule-name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Match when the description contains</Label>
                <Input value={ruleFor.description.split(" ").slice(0, 2).join(" ")} readOnly className="bg-muted" data-testid="input-rule-match" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Post to</Label>
                <Select value={ruleAccount} onValueChange={setRuleAccount}>
                  <SelectTrigger data-testid="select-rule-account">
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_CHOICES.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleFor(null)} data-testid="button-rule-cancel">
              Cancel
            </Button>
            <Button
              disabled={!ruleAccount || !ruleName}
              onClick={() => {
                if (!ruleFor) return;
                createRuleFromTxn(ruleFor.id, ruleName, ruleAccount);
                toast({ title: "Rule saved", description: "The transaction was recoded and the rule is live." });
                setRuleFor(null);
              }}
              data-testid="button-rule-save"
            >
              Save the rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
