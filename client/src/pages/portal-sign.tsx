import { useEffect, useState } from "react";
import { PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, KeyValue, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalSign, useSignLetter, errorMessage } from "@/api";
import { fmtBytes, fmtDate, fmtTimestamp } from "@/lib/money";
import { actionFailureText, type PortalSign as PortalSignData } from "@shared/api";

const BASIS: Record<"accrual" | "cash" | "both", string> = {
  accrual: "Accrual",
  cash: "Cash",
  both: "Accrual with a cash view",
};

/**
 * The engagement letter and the client's signature, GET and POST
 * /api/portal/:clientId/sign. The letter is the document on file in the
 * vault. Signing is ENG-SIGN-LETTER, which writes the signature record and
 * moves the engagement to signed. When no letter has been issued the screen
 * says so, it does not invent one.
 */
export default function PortalSign() {
  return (
    <PortalScreen
      title="Your engagement letter"
      subtitle="The terms of the work, the letter on file, and your signature record."
      testId="hero-portal-sign"
    >
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalSign(clientId);
  return (
    <QueryBody q={q} title="Engagement letter" testId="card-portal-sign">
      {(data) => (data.engagement ? <Letter clientId={clientId} data={data} /> : <NoEngagement />)}
    </QueryBody>
  );
}

function NoEngagement() {
  return (
    <SectionCard title="Engagement letter" testId="card-portal-sign-none">
      <EmptyState title="There is no engagement on file yet" body="Once your accountant sets up the engagement, its terms and letter appear here for you to review and sign." />
    </SectionCard>
  );
}

function Letter({ clientId, data }: { clientId: string; data: PortalSignData }) {
  const e = data.engagement!;
  const sign = useSignLetter(clientId);
  const [name, setName] = useState(data.signer.name);
  const [title, setTitle] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => setName(data.signer.name), [data.signer.name]);

  const submit = () => {
    setRefused(null);
    sign.mutate(
      { signerName: name, signerTitle: title.trim() || undefined, consentText: data.consentText },
      { onSuccess: (res) => setRefused(actionFailureText(res)) },
    );
  };

  const statusTone = e.status === "active" || e.status === "signed" ? "good" : e.status === "terminated" ? "risk" : "watch";
  const statusLabel = { draft: "Draft", sent: "Awaiting your signature", signed: "Signed", active: "Active", terminated: "Ended" }[e.status];

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_380px]">
      <SectionCard title="Terms of the engagement" testId="card-portal-sign-terms">
        <div className="mb-3 flex items-center gap-2">
          <Pill tone={statusTone} testId="pill-engagement-status">{statusLabel}</Pill>
          {e.signedAt ? <span className="text-xs text-muted-foreground">Signed {fmtTimestamp(e.signedAt)}</span> : null}
        </div>
        <KeyValue
          items={[
            { label: "Engagement", value: e.name },
            { label: "Service level", value: e.tierName },
            { label: "Reporting basis", value: BASIS[e.reportingBasis] },
            { label: "Start date", value: fmtDate(e.startDate) },
            { label: "End date", value: e.endDate ? fmtDate(e.endDate) : "Open ended" },
            {
              label: "Scope",
              value: e.scopeItems.length ? e.scopeItems.map((k) => k.replace(/_/g, " ")).join(", ") : "As written in the letter",
            },
          ]}
        />
        <h3 className="mt-5 text-sm font-semibold">The letter</h3>
        {data.letter ? (
          <div className="mt-2 rounded-md border border-border p-3 text-sm" data-testid="letter-on-file">
            <p className="font-medium">{data.letter.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.letter.byteSize !== null ? fmtBytes(data.letter.byteSize) : "Size not recorded"}
              {data.letter.uploadedAt ? `, received ${fmtTimestamp(data.letter.uploadedAt)}` : ""}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Download opens once document storage is connected. Your accountant can send you a copy in the meantime.
            </p>
          </div>
        ) : (
          <PortalNote tone="watch" testId="note-letter-missing">
            Your engagement letter has not been issued for signature in this product yet. The terms above come from your engagement record.
            Your accountant can also record a letter signed outside this product.
          </PortalNote>
        )}
      </SectionCard>

      <div className="space-y-3">
        {data.state === "ready" ? (
          <SectionCard title="Sign" testId="card-portal-sign-form">
            <div className="space-y-3">
              <div>
                <Label htmlFor="sign-name">Your full name</Label>
                <Input id="sign-name" value={name} onChange={(ev) => setName(ev.target.value)} maxLength={200} data-testid="input-sign-name" />
              </div>
              <div>
                <Label htmlFor="sign-title">Your title, if any</Label>
                <Input id="sign-title" value={title} onChange={(ev) => setTitle(ev.target.value)} maxLength={120} placeholder="Owner" data-testid="input-sign-title" />
              </div>
              <p className="text-xs text-muted-foreground">Signing as {data.signer.email}.</p>
              <label className="flex items-start gap-2 text-xs leading-relaxed">
                <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} data-testid="checkbox-sign-consent" />
                <span>{data.consentText}</span>
              </label>
              {refused ? <p className="text-xs text-destructive">{refused}</p> : null}
              {sign.isError ? <p className="text-xs text-destructive">{errorMessage(sign.error)}</p> : null}
              <Button onClick={submit} disabled={!agreed || name.trim().length === 0 || sign.isPending} data-testid="button-sign">
                <PenLine className="mr-1 h-4 w-4" />
                {sign.isPending ? "Signing" : "Sign the engagement letter"}
              </Button>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title="Signature record" testId="card-portal-sign-record">
          {data.signatures.length === 0 ? (
            <EmptyState
              title="No signature yet"
              body={
                data.state === "no_letter"
                  ? "The record appears here once the letter is issued and signed."
                  : data.state === "terminated"
                    ? "This engagement has ended."
                    : "Sign the letter to create the record."
              }
            />
          ) : (
            <ul className="space-y-3">
              {data.signatures.map((s) => (
                <li key={s.id} className="rounded-md border border-border p-3 text-sm" data-testid={`signature-${s.id}`}>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-positive" />
                    <span className="font-medium">{s.signerName}</span>
                    {s.signerTitle ? <span className="text-muted-foreground">{s.signerTitle}</span> : null}
                    <Pill tone={s.status === "signed" ? "good" : "neutral"}>{s.status === "signed" ? "Signed" : "Voided"}</Pill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fmtTimestamp(s.signedAt)}, {s.signerEmail}, click to sign
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">Letter hash {s.documentSha256Hex}</p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
