import { useRef, useState } from "react";
import { CheckCircle2, Eraser, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { fmtTimestamp, usd } from "@/lib/money";

const TAX_CLASSES = ["Sole proprietor", "Single member LLC", "Partnership", "S corporation", "C corporation", "Nonprofit"];

export default function PortalSign() {
  const { ds, activeClient, activeClientId, signDocument, addMessage } = useApp();
  const { toast } = useToast();
  const contact = activeClient.contacts[0];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [mode, setMode] = useState<"typed" | "drawn">("typed");
  const [typed, setTyped] = useState(contact?.name || "");
  const [agree, setAgree] = useState(false);
  const [w9, setW9] = useState({ legalName: activeClient.legalName, taxClass: activeClient.entityType === "Nonprofit" ? "Nonprofit" : "Single member LLC", tin: "", address: activeClient.address, certify: false });

  const signatures = ds.signatures.filter((s) => s.clientId === activeClientId);
  const pending = [
    { title: `Engagement letter, monthly bookkeeping at ${usd(activeClient.engagement.monthlyFeeCents)} per month`, signed: Boolean(activeClient.engagement.signedBy) },
    { title: "Authorization to obtain read only access to bank feeds", signed: signatures.some((s) => s.documentTitle.includes("Authorization")) },
    { title: `Form W-9 for ${activeClient.legalName}`, signed: signatures.some((s) => s.documentTitle.includes("W-9")) },
  ];
  const outstanding = pending.filter((p) => !p.signed);
  const [selected, setSelected] = useState(outstanding[0]?.title || pending[0].title);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * c.width, y: ((e.clientY - rect.top) / rect.height) * c.height };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawing.current = true;
    setHasDrawing(true);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setHasDrawing(false);
  };

  const canSign = agree && (mode === "typed" ? typed.trim().length > 3 : hasDrawing);

  return (
    <>
      <PageHeader
        title="Sign and verify"
        subtitle="Anything that needs your name on it shows up here. Signing records your name, the time, and the device address, and that record is kept with the document."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Waiting on your signature" value={outstanding.length} tone={outstanding.length ? "watch" : "good"} testId="kpi-sign-open" />
        <Kpi label="Already signed" value={signatures.length} tone="good" testId="kpi-sign-done" />
        <Kpi label="Signer on record" value={contact?.name.split(" ")[0] || "Not set"} hint={contact?.role} testId="kpi-signer" />
        <Kpi label="Two factor required" value={contact?.mfaRequired ? "Yes" : "No"} tone={contact?.mfaRequired ? "good" : "watch"} testId="kpi-mfa" />
      </div>

      <Tabs defaultValue="sign">
        <TabsList data-testid="tabs-sign">
          <TabsTrigger value="sign" data-testid="tab-sign">Sign a document</TabsTrigger>
          <TabsTrigger value="w9" data-testid="tab-w9">Form W-9</TabsTrigger>
          <TabsTrigger value="log" data-testid="tab-siglog">Signature record</TabsTrigger>
        </TabsList>

        <TabsContent value="sign" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <SectionCard title="Documents" bodyClassName="p-0" testId="card-sign-docs">
              <ul className="divide-y divide-border">
                {pending.map((p) => (
                  <li key={p.title} className="flex items-start gap-3 px-4 py-3">
                    <input
                      type="radio"
                      name="doc"
                      checked={selected === p.title}
                      disabled={p.signed}
                      onChange={() => setSelected(p.title)}
                      className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                      data-testid={`radio-doc-${p.title.slice(0, 12).replace(/\s+/g, "-")}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">{p.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.signed ? "Signed and on file" : "Read it below, then add your name on the right"}
                      </p>
                    </div>
                    {p.signed ? <Pill tone="good">Signed</Pill> : <Pill tone="watch">Waiting</Pill>}
                  </li>
                ))}
              </ul>
              <div className="border-t border-border p-4">
                <h3 className="text-sm font-semibold">{selected}</h3>
                <div className="mt-2 max-h-64 space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed text-muted-foreground">
                  <p>
                    Ledger Legends will keep the books for {activeClient.legalName} on a monthly cycle. Work includes categorizing activity,
                    reconciling every account, preparing statements, and reviewing the balance sheet against supporting documents before anything is
                    released.
                  </p>
                  <p>
                    The monthly fee is {usd(activeClient.engagement.monthlyFeeCents)}, billed on the first of the month. Cleanup of prior periods is
                    quoted separately at {usd(activeClient.engagement.cleanupFeeCents)} and is billed once when the cleanup is finished.
                  </p>
                  <p>
                    Access to your systems stays read only wherever the vendor supports it. We never ask you to type a password into this portal, and
                    we do not store login details for your accounts.
                  </p>
                  <p>
                    Either side can end the engagement with thirty days written notice. Your records remain yours, and we hand over a full export at
                    no cost.
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Add your signature" testId="card-signature">
              <div className="space-y-4">
                <div className="flex rounded-sm border border-border bg-muted p-0.5">
                  {([
                    ["typed", "Type it"],
                    ["drawn", "Draw it"],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setMode(k)}
                      className={`flex-1 rounded-sm px-2.5 py-1 text-xs transition-colors ${mode === k ? "bg-card font-medium" : "text-muted-foreground"}`}
                      data-testid={`button-sig-${k}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {mode === "typed" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Full legal name</Label>
                    <Input value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="input-typed-name" />
                    <p className="rounded-sm border border-border bg-muted/40 px-3 py-4 text-center text-lg" style={{ fontFamily: "Georgia, serif" }}>
                      {typed || "Your name appears here"}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <canvas
                      ref={canvasRef}
                      width={520}
                      height={180}
                      onPointerDown={start}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerLeave={end}
                      className="h-[140px] w-full touch-none rounded-sm border border-border bg-white"
                      data-testid="canvas-signature"
                    />
                    <Button size="sm" variant="ghost" onClick={clear} data-testid="button-clear-sig">
                      <Eraser className="mr-1 h-3.5 w-3.5" />
                      Clear
                    </Button>
                  </div>
                )}

                <label className="flex items-start gap-2.5 text-xs text-muted-foreground">
                  <Checkbox checked={agree} onCheckedChange={(v) => setAgree(Boolean(v))} className="mt-0.5" data-testid="checkbox-agree" />
                  <span>I have read this document and I agree that my electronic signature carries the same weight as ink on paper.</span>
                </label>

                <Button
                  className="w-full"
                  disabled={!canSign}
                  onClick={() => {
                    signDocument(selected, mode === "typed" ? typed : contact?.name || "Client contact", mode, contact?.role || "Owner");
                    addMessage(activeClientId, contact?.name || "Client contact", `Signed: ${selected}`, "The document was signed in the portal.", "Inbound");
                    toast({ title: "Signed", description: "A copy is filed with the time and the signer recorded." });
                    setAgree(false);
                    clear();
                  }}
                  data-testid="button-submit-signature"
                >
                  <PenLine className="mr-1 h-4 w-4" />
                  Sign this document
                </Button>

                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive" />
                  We record your name, the time, and the device address. We never ask for a bank password here.
                </p>
              </div>
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="w9" className="mt-4">
          <SectionCard
            title="Form W-9"
            description="We need this before January so any 1099 filings go out on time. Only the last four digits of the tax number are kept in the portal."
            testId="card-w9"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Legal name</Label>
                <Input value={w9.legalName} onChange={(e) => setW9({ ...w9, legalName: e.target.value })} data-testid="input-w9-name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Tax classification</Label>
                <Select value={w9.taxClass} onValueChange={(v) => setW9({ ...w9, taxClass: v })}>
                  <SelectTrigger data-testid="select-w9-class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_CLASSES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Taxpayer number, last four digits only</Label>
                <Input
                  value={w9.tin}
                  maxLength={4}
                  inputMode="numeric"
                  placeholder="4821"
                  className="tnum"
                  onChange={(e) => setW9({ ...w9, tin: e.target.value.replace(/\D/g, "") })}
                  data-testid="input-w9-tin"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Address</Label>
                <Input value={w9.address} onChange={(e) => setW9({ ...w9, address: e.target.value })} data-testid="input-w9-address" />
              </div>
            </div>
            <label className="mt-4 flex items-start gap-2.5 text-xs text-muted-foreground">
              <Checkbox checked={w9.certify} onCheckedChange={(v) => setW9({ ...w9, certify: Boolean(v) })} className="mt-0.5" data-testid="checkbox-w9-certify" />
              <span>I certify that the number shown is correct and that I am not subject to backup withholding.</span>
            </label>
            <Button
              className="mt-4"
              disabled={!w9.certify || w9.tin.length !== 4 || !w9.legalName.trim()}
              onClick={() => {
                signDocument(`Form W-9 for ${w9.legalName}`, contact?.name || "Client contact", "typed", contact?.role || "Owner");
                addMessage(activeClientId, contact?.name || "Client contact", "W-9 submitted", `Tax classification ${w9.taxClass}, number ending in ${w9.tin}.`, "Inbound");
                toast({ title: "W-9 received", description: "Your accountant can file 1099s without chasing this in December." });
                setW9({ ...w9, certify: false, tin: "" });
              }}
              data-testid="button-submit-w9"
            >
              <CheckCircle2 className="mr-1 h-4 w-4" />
              Submit the W-9
            </Button>
          </SectionCard>
        </TabsContent>

        <TabsContent value="log" className="mt-4">
          <SectionCard title="Signature record" bodyClassName="p-0" testId="card-sig-log">
            <DataGrid
              rows={signatures}
              rowKey={(s) => s.id}
              empty={<EmptyState title="Nothing signed yet" body="Sign a document and the record appears here with the time it happened." />}
              cols={[
                { key: "doc", label: "Document", mobile: "title", render: (s) => <span className="block truncate">{s.documentTitle}</span> },
                { key: "who", label: "Signer", mobile: "sub", render: (s) => <span className="text-sm">{s.signerName}</span> },
                { key: "role", label: "Role", mobile: "row", render: (s) => <span className="text-xs">{s.signerRole}</span> },
                { key: "mode", label: "How", mobile: "row", render: (s) => <Pill>{s.mode === "typed" ? "Typed" : "Drawn"}</Pill> },
                { key: "at", label: "When", mobile: "value", render: (s) => <span className="tnum text-xs">{fmtTimestamp(s.signedAt)}</span> },
                { key: "ip", label: "Device address", align: "right", mobile: "row", render: (s) => <span className="tnum text-xs text-muted-foreground">{s.ip}</span> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  );
}
