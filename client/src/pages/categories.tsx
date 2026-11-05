import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useActiveClient } from "@/lib/active-client";
import { useCategories, useTriggerRun, errorMessage, screenKeys } from "@/api";
import { usd } from "@/lib/money";
import type { Category } from "@shared/api";

const TAX_TREATMENTS = [
  "deductible",
  "meals_50",
  "nondeductible",
  "owner_draw",
  "owner_contribution",
  "personal",
  "capital",
  "transfer",
  "not_applicable",
] as const;

const CLASS_1099 = ["none", "nec", "misc_rent", "misc_other", "attorney"] as const;

/**
 * Categories, read from GET /api/firm/clients/:id/categories. These are the
 * rows a transaction's categoryId points at. INTAKE-BUILD-CHART seeds the
 * industry template's own set; CFG-CREATE-CATEGORY is for the ones a firm
 * invents afterward, CFG-EDIT-CATEGORY for changing one that already
 * exists. Edit goes through a full Dialog, not a Popover
 * (EditRulePopover's pattern in rules.tsx) -- ten fields is a bigger
 * surface than a name and a number, the same reasoning ClientPolicyDialog
 * gives for its own eight fields.
 */
export default function Categories() {
  const { client, clientId } = useActiveClient();
  const q = useCategories(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-categories">
      <PageHeader
        title="Categories"
        subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} categories.` : ""}`}
        actions={clientId ? <CreateCategoryDialog clientId={clientId} /> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Categories" value={d ? d.items.length : "…"} testId="kpi-categories" />
        <Kpi label="Active" value={d ? d.items.filter((c) => c.isActive).length : "…"} />
      </div>
      <SectionCard title="Categories" description="What a coded transaction's categoryId points at.">
        <DataGrid<Category>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(c) => c.id}
          testId="grid-categories"
          empty={<EmptyState title="No categories yet" body="Categories come from the chart template at intake, or are added here." />}
          cols={[
            { key: "name", label: "Category", mobile: "title", render: (c) => <span className="font-medium">{c.name}</span> },
            { key: "acct", label: "Account", align: "right", mobile: "row", render: (c) => <span className="tnum">{c.accountNumber}</span> },
            { key: "side", label: "Normal side", mobile: "row", render: (c) => <Pill tone="neutral">{c.normalSide}</Pill> },
            { key: "tax", label: "Tax treatment", mobile: "row", render: (c) => <span className="text-xs">{c.taxTreatment.replace(/_/g, " ")}</span> },
            {
              key: "receipt",
              label: "Requires receipt over",
              align: "right",
              mobile: "row",
              render: (c) => <span className="tnum text-xs">{c.requiresReceiptOverCents != null ? usd(c.requiresReceiptOverCents) : "No"}</span>,
            },
            { key: "active", label: "Active", mobile: "value", render: (c) => <Pill tone={c.isActive ? "good" : "neutral"}>{c.isActive ? "Active" : "Inactive"}</Pill> },
            {
              key: "edit",
              label: "",
              mobile: "row",
              render: (c) => (clientId ? <EditCategoryDialog clientId={clientId} category={c} /> : null),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}

function CreateCategoryDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [normalSide, setNormalSide] = useState<"debit" | "credit">("debit");
  const [taxTreatment, setTaxTreatment] = useState<(typeof TAX_TREATMENTS)[number]>("deductible");
  const [class1099, setClass1099] = useState<(typeof CLASS_1099)[number]>("none");
  const [requiresReceiptOverDollars, setRequiresReceiptOverDollars] = useState("");
  const [requiresClass, setRequiresClass] = useState(false);
  const [capitalizeOverDollars, setCapitalizeOverDollars] = useState("");
  const [restrictionRelevant, setRestrictionRelevant] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setName("");
    setAccountNumber("");
    setNormalSide("debit");
    setTaxTreatment("deductible");
    setClass1099("none");
    setRequiresReceiptOverDollars("");
    setRequiresClass(false);
    setCapitalizeOverDollars("");
    setRestrictionRelevant(false);
    setIsActive(true);
    setError(null);
  };

  // A plain number, not bigint: the request body goes through
  // JSON.stringify, which has no bigint and throws before the request is
  // even sent. The run's own scope schema (cfg-create-category.ts) takes
  // this wire-safe number and casts it to Cents server side.
  const dollarsToCents = (v: string): number | null => {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
  };

  const save = async () => {
    setError(null);
    if (!name.trim() || !/^[0-9]{4}$/.test(accountNumber.trim())) {
      setError("Name and a 4 digit account number are required.");
      return;
    }
    const scope = {
      clientId,
      changeNote: "added from the categories screen",
      fields: {
        name: name.trim(),
        accountNumber: accountNumber.trim(),
        normalSide,
        taxTreatment,
        class1099,
        requiresReceiptOverCents: dollarsToCents(requiresReceiptOverDollars),
        requiresClass,
        capitalizeOverCents: dollarsToCents(capitalizeOverDollars),
        restrictionRelevant,
        isActive,
      },
    };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-CREATE-CATEGORY", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-CREATE-CATEGORY",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.categories(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" data-testid="category-create">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add category
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a category</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="category-name" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Account number</label>
              <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="6100" data-testid="category-account" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Normal side</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={normalSide}
                onChange={(e) => setNormalSide(e.target.value as "debit" | "credit")}
                data-testid="category-normal-side"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">1099 class</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={class1099}
                onChange={(e) => setClass1099(e.target.value as (typeof CLASS_1099)[number])}
                data-testid="category-class-1099"
              >
                {CLASS_1099.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tax treatment</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value as (typeof TAX_TREATMENTS)[number])}
              data-testid="category-tax-treatment"
            >
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Requires receipt over ($, optional)</label>
              <Input type="number" value={requiresReceiptOverDollars} onChange={(e) => setRequiresReceiptOverDollars(e.target.value)} data-testid="category-receipt-over" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Capitalize over ($, optional)</label>
              <Input type="number" value={capitalizeOverDollars} onChange={(e) => setCapitalizeOverDollars(e.target.value)} data-testid="category-capitalize-over" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requiresClass} onChange={(e) => setRequiresClass(e.target.checked)} data-testid="category-requires-class" />
            Requires a class
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restrictionRelevant} onChange={(e) => setRestrictionRelevant(e.target.checked)} data-testid="category-restriction-relevant" />
            Restriction relevant
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} data-testid="category-active" />
            Active
          </label>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="category-save">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * CFG-EDIT-CATEGORY. Diff based, same shape as ClientPolicyDialog
 * (portal-client-detail.tsx) and EditRulePopover (rules.tsx): only the
 * fields that actually changed from the row's own current value are sent,
 * so a no-touch save is a true no-op on the server, not a same-value edit.
 */
function EditCategoryDialog({ clientId, category }: { clientId: string; category: Category }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(category.name);
  const [accountNumber, setAccountNumber] = useState(category.accountNumber);
  const [normalSide, setNormalSide] = useState<"debit" | "credit">(category.normalSide);
  const [taxTreatment, setTaxTreatment] = useState<(typeof TAX_TREATMENTS)[number]>(category.taxTreatment);
  const [class1099, setClass1099] = useState<(typeof CLASS_1099)[number]>(category.class1099);
  const [requiresReceiptOverDollars, setRequiresReceiptOverDollars] = useState(
    category.requiresReceiptOverCents != null ? String(category.requiresReceiptOverCents / 100) : "",
  );
  const [requiresClass, setRequiresClass] = useState(category.requiresClass);
  const [capitalizeOverDollars, setCapitalizeOverDollars] = useState(
    category.capitalizeOverCents != null ? String(category.capitalizeOverCents / 100) : "",
  );
  const [restrictionRelevant, setRestrictionRelevant] = useState(category.restrictionRelevant);
  const [isActive, setIsActive] = useState(category.isActive);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setName(category.name);
    setAccountNumber(category.accountNumber);
    setNormalSide(category.normalSide);
    setTaxTreatment(category.taxTreatment);
    setClass1099(category.class1099);
    setRequiresReceiptOverDollars(category.requiresReceiptOverCents != null ? String(category.requiresReceiptOverCents / 100) : "");
    setRequiresClass(category.requiresClass);
    setCapitalizeOverDollars(category.capitalizeOverCents != null ? String(category.capitalizeOverCents / 100) : "");
    setRestrictionRelevant(category.restrictionRelevant);
    setIsActive(category.isActive);
    setError(null);
  };

  // A plain number, not bigint, same reasoning as CreateCategoryDialog's
  // own dollarsToCents: the request body goes through JSON.stringify,
  // which has no bigint and throws before the request is even sent.
  const dollarsToCents = (v: string): number | null => {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
  };

  const save = async () => {
    setError(null);
    const fields: Record<string, unknown> = {};
    if (name.trim() !== category.name) fields.name = name.trim();
    if (accountNumber.trim() !== category.accountNumber) fields.accountNumber = accountNumber.trim();
    if (normalSide !== category.normalSide) fields.normalSide = normalSide;
    if (taxTreatment !== category.taxTreatment) fields.taxTreatment = taxTreatment;
    if (class1099 !== category.class1099) fields.class1099 = class1099;
    const receiptOver = dollarsToCents(requiresReceiptOverDollars);
    if (receiptOver !== category.requiresReceiptOverCents) fields.requiresReceiptOverCents = receiptOver;
    if (requiresClass !== category.requiresClass) fields.requiresClass = requiresClass;
    const capitalizeOver = dollarsToCents(capitalizeOverDollars);
    if (capitalizeOver !== category.capitalizeOverCents) fields.capitalizeOverCents = capitalizeOver;
    if (restrictionRelevant !== category.restrictionRelevant) fields.restrictionRelevant = restrictionRelevant;
    if (isActive !== category.isActive) fields.isActive = isActive;
    if (Object.keys(fields).length === 0) {
      setOpen(false);
      return;
    }
    const scope = { clientId, categoryId: category.id, changeNote: "edited from the categories screen", fields };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CFG-EDIT-CATEGORY", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "CFG-EDIT-CATEGORY",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.categories(clientId) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" data-testid={`category-edit-${category.id}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit category</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid={`category-edit-name-${category.id}`} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Account number</label>
              <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="6100" data-testid={`category-edit-account-${category.id}`} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Normal side</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={normalSide}
                onChange={(e) => setNormalSide(e.target.value as "debit" | "credit")}
                data-testid={`category-edit-normal-side-${category.id}`}
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">1099 class</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={class1099}
                onChange={(e) => setClass1099(e.target.value as (typeof CLASS_1099)[number])}
                data-testid={`category-edit-class-1099-${category.id}`}
              >
                {CLASS_1099.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Tax treatment</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value as (typeof TAX_TREATMENTS)[number])}
              data-testid={`category-edit-tax-treatment-${category.id}`}
            >
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Requires receipt over ($, optional)</label>
              <Input
                type="number"
                value={requiresReceiptOverDollars}
                onChange={(e) => setRequiresReceiptOverDollars(e.target.value)}
                data-testid={`category-edit-receipt-over-${category.id}`}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Capitalize over ($, optional)</label>
              <Input
                type="number"
                value={capitalizeOverDollars}
                onChange={(e) => setCapitalizeOverDollars(e.target.value)}
                data-testid={`category-edit-capitalize-over-${category.id}`}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requiresClass} onChange={(e) => setRequiresClass(e.target.checked)} data-testid={`category-edit-requires-class-${category.id}`} />
            Requires a class
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restrictionRelevant} onChange={(e) => setRestrictionRelevant(e.target.checked)} data-testid={`category-edit-restriction-relevant-${category.id}`} />
            Restriction relevant
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} data-testid={`category-edit-active-${category.id}`} />
            Active
          </label>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid={`category-edit-save-${category.id}`}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
