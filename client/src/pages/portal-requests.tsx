import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Kpi, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalRequestList, useAnswerRequest, errorMessage } from "@/api";
import { fmtDate, fmtTimestamp } from "@/lib/money";
import { actionFailureText, type PortalRequestDetail } from "@shared/api";

/**
 * What the firm still needs, read from GET /api/portal/:clientId/requests.
 * A transaction request is answered in words through PORTAL-ANSWER-REQUEST.
 * A document request needs a file, and uploads wait on object storage, which
 * the payload states with uploadsConfigured false.
 */
export default function PortalRequests() {
  return (
    <PortalScreen
      title="What we need from you"
      subtitle={(name) => `Each item below is something your accountant cannot finish without. Answering them is the fastest way to get the ${name} books closed on time.`}
      testId="hero-portal-requests"
    >
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalRequestList(clientId);
  const [, navigate] = useLocation();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <QueryBody q={q} title="Open requests" testId="card-portal-requests">
      {(data) => {
        const open = data.items.filter((i) => i.status === "open");
        const late = open.filter((i) => i.dueOn < today);
        const closed = data.items.filter((i) => i.status !== "open");
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Still open" value={open.length} tone={open.length ? "watch" : "good"} testId="kpi-req-open" />
              <Kpi label="Past the date" value={late.length} tone={late.length ? "risk" : "good"} testId="kpi-req-late" />
              <Kpi label="Closed out" value={closed.length} tone="good" testId="kpi-req-done" />
              <Kpi label="Need a file" value={open.filter((i) => i.kind === "document").length} testId="kpi-req-files" />
            </div>

            {!data.uploadsConfigured && open.some((i) => i.kind === "document") ? (
              <PortalNote tone="watch" testId="note-requests-uploads">
                Document requests need a file, and file upload is not set up in this product yet. Send those documents to your
                accountant the way you do today. Questions about specific transactions can be answered right here.
              </PortalNote>
            ) : null}

            {open.length === 0 ? (
              <SectionCard bodyClassName="p-0" testId="card-portal-requests-empty">
                <EmptyState
                  title="Nothing is outstanding"
                  body="Your accountant has everything needed for this close. New requests show up here the moment they are opened."
                />
              </SectionCard>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {open.map((r) => (
                  <RequestCard key={r.id} r={r} clientId={clientId} late={r.dueOn < today} onUpload={() => navigate("/portal/upload")} />
                ))}
              </div>
            )}

            {closed.length > 0 ? (
              <SectionCard title="Closed out" testId="card-portal-requests-closed">
                <ul className="divide-y divide-border">
                  {closed.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm" data-testid={`request-closed-${r.id}`}>
                      <div className="min-w-0">
                        <p className="font-medium">{r.detail}</p>
                        {r.answer ? <p className="mt-0.5 text-xs text-muted-foreground">Your answer: {r.answer}</p> : null}
                        {r.answeredAt ? <p className="text-xs text-muted-foreground">Answered {fmtTimestamp(r.answeredAt)}</p> : null}
                      </div>
                      <Pill tone={r.status === "satisfied" ? "good" : "neutral"}>{r.status === "satisfied" ? "Done" : "Waived"}</Pill>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}
          </>
        );
      }}
    </QueryBody>
  );
}

function RequestCard({ r, clientId, late, onUpload }: { r: PortalRequestDetail; clientId: string; late: boolean; onUpload: () => void }) {
  const [answer, setAnswer] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const m = useAnswerRequest(clientId);
  const submit = () => {
    setRefused(null);
    m.mutate(
      { requestId: r.id, answer },
      {
        onSuccess: (res) => {
          const text = actionFailureText(res);
          if (text) setRefused(text);
          else setAnswer("");
        },
      },
    );
  };
  return (
    <SectionCard testId={`request-${r.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug">{r.kind === "document" ? "A document we need" : "A question about a transaction"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{r.detail}</p>
        </div>
        <Pill tone={late ? "risk" : "watch"}>{late ? "Past the date" : "Open"}</Pill>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Reference</dt>
          <dd className="mt-0.5 font-mono">{r.reasonCode}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Opened</dt>
          <dd className="tnum mt-0.5">{fmtDate(r.openedOn)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Needed by</dt>
          <dd className={`tnum mt-0.5 ${late ? "text-destructive" : ""}`}>{fmtDate(r.dueOn)}</dd>
        </div>
      </dl>
      {r.canAnswer ? (
        <div className="mt-4 space-y-2">
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Write what this was for, and anything that helps us code it."
            rows={3}
            maxLength={4000}
            data-testid={`input-answer-${r.id}`}
          />
          {refused ? <p className="text-xs text-destructive">{refused}</p> : null}
          {m.isError ? <p className="text-xs text-destructive">{errorMessage(m.error)}</p> : null}
          <Button size="sm" onClick={submit} disabled={answer.trim().length === 0 || m.isPending} data-testid={`button-answer-${r.id}`}>
            {m.isPending ? "Sending" : "Send answer"}
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="mt-4" onClick={onUpload} data-testid={`button-satisfy-${r.id}`}>
          About sending this file
        </Button>
      )}
    </SectionCard>
  );
}
