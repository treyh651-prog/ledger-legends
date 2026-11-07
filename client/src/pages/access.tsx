/**
 * Access. Who can sign in to this firm, and with what reach.
 *
 * Owners and managers invite people here and revoke them here. Everyone
 * else with a firm membership can look. The data comes from the server's
 * invitation routes, which read tenancy.memberships for the actor's firm.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { DataGrid, PageHeader, Pill, SectionCard, type Col } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/api";
import { useAuth, type MembershipRole, type MembershipScope } from "@/lib/auth";

interface AccessRequestRow {
  id: string;
  firmName: string;
  requestedClientName: string;
  message: string | null;
  email: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  rejectionReason: string | null;
}

interface InvitationRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  scope: MembershipScope;
  role: MembershipRole;
  clientId: string | null;
  clientName: string | null;
  grantedAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  disabledAt: string | null;
}

const FIRM_ROLES: { id: MembershipRole; label: string; hint: string }[] = [
  { id: "owner", label: "Owner", hint: "Everything, including inviting and removing people" },
  { id: "manager", label: "Manager", hint: "Every client, can invite and remove people" },
  { id: "preparer", label: "Preparer", hint: "Works the books, cannot manage access" },
  { id: "reviewer", label: "Reviewer", hint: "Approves closes, cannot manage access" },
  { id: "read_only", label: "Read only", hint: "Looks, does not touch" },
];
const CLIENT_ROLES: { id: MembershipRole; label: string; hint: string }[] = [
  { id: "client_user", label: "Client user", hint: "Uploads, answers requests, signs" },
  { id: "read_only", label: "Read only", hint: "Sees reports and statements" },
];

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function roleLabel(role: MembershipRole): string {
  return [...FIRM_ROLES, ...CLIENT_ROLES].find((r) => r.id === role)?.label ?? role;
}

export default function Access() {
  const auth = useAuth();
  const clientsQ = useClients();
  const { toast } = useToast();
  const [rows, setRows] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await auth.authFetch("/api/invitations");
      const body = (await res.json()) as { invitations?: InvitationRow[]; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `The server answered ${res.status}.`);
      setRows(body.invitations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [auth]);

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const res = await auth.authFetch("/api/access-requests");
      const body = (await res.json()) as { requests?: AccessRequestRow[] };
      if (res.ok) setRequests(body.requests ?? []);
    } finally {
      setRequestsLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    if (auth.status === "signed-in") {
      void load();
      void loadRequests();
    } else {
      setLoading(false);
      setRequestsLoading(false);
    }
  }, [auth.status, load, loadRequests]);

  const pendingRequests = requests.filter((r) => r.status === "pending");

  async function revoke(row: InvitationRow) {
    const who = row.displayName ? `${row.displayName} (${row.email})` : row.email;
    const what = row.scope === "firm" ? `${roleLabel(row.role)} access to the firm` : `access to ${row.clientName ?? "the client"}`;
    if (!window.confirm(`Revoke ${what} for ${who}? They lose it immediately.`)) return;
    const res = await auth.authFetch(`/api/invitations/${row.membershipId}`, { method: "DELETE" });
    const body = (await res.json()) as { loginDisabled?: boolean; error?: { message?: string } };
    if (!res.ok) {
      toast({ title: "Could not revoke", description: body.error?.message ?? `The server answered ${res.status}.`, variant: "destructive" });
      return;
    }
    toast({ title: "Access revoked", description: body.loginDisabled ? `${who} has no access left, so the login was disabled.` : `${who} keeps their other access.` });
    void load();
  }

  const [changingRole, setChangingRole] = useState<string | null>(null);

  async function changeRole(row: InvitationRow, role: MembershipRole) {
    if (role === row.role) return;
    setChangingRole(row.membershipId);
    try {
      const res = await auth.authFetch(`/api/invitations/${row.membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        toast({ title: "Could not change role", description: body.error?.message ?? `The server answered ${res.status}.`, variant: "destructive" });
        return;
      }
      void load();
    } finally {
      setChangingRole(null);
    }
  }

  const cols = useMemo<Col<InvitationRow>[]>(
    () => [
      {
        key: "who",
        label: "Person",
        mobile: "title",
        render: (r) => (
          <div>
            <div className="font-medium">{r.displayName ?? r.email}</div>
            {r.displayName ? <div className="text-xs text-muted-foreground">{r.email}</div> : null}
          </div>
        ),
      },
      {
        key: "reach",
        label: "Reach",
        mobile: "sub",
        render: (r) => (r.scope === "firm" ? "Whole firm" : r.clientName ?? "One client"),
      },
      {
        key: "role",
        label: "Role",
        mobile: "sub",
        render: (r) =>
          auth.canManageAccess && !r.revokedAt && r.userId !== auth.me?.userId ? (
            <Select value={r.role} onValueChange={(v) => void changeRole(r, v as MembershipRole)} disabled={changingRole === r.membershipId}>
              <SelectTrigger className="h-8 w-36 text-xs" data-testid={`select-role-${r.membershipId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(r.scope === "firm" ? FIRM_ROLES : CLIENT_ROLES).map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            roleLabel(r.role)
          ),
      },
      {
        key: "state",
        label: "State",
        mobile: "value",
        render: (r) =>
          r.revokedAt ? (
            <Pill tone="neutral">Revoked {when(r.revokedAt)}</Pill>
          ) : r.disabledAt ? (
            <Pill tone="risk">Disabled</Pill>
          ) : r.lastSeenAt ? (
            <Pill tone="good">Active, seen {when(r.lastSeenAt)}</Pill>
          ) : (
            <Pill tone="watch">Invited {when(r.grantedAt)}</Pill>
          ),
      },
      {
        key: "actions",
        label: "",
        align: "right",
        mobile: "row",
        render: (r) =>
          auth.canManageAccess && !r.revokedAt && r.userId !== auth.me?.userId ? (
            <Button variant="ghost" size="sm" onClick={() => void revoke(r)} data-testid={`button-revoke-${r.membershipId}`}>
              Revoke
            </Button>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.canManageAccess, auth.me?.userId, changingRole],
  );

  if (auth.status === "off") {
    return (
      <>
        <PageHeader title="Access" subtitle="Sign in is off on this server, so there is nobody to invite. Point the server at Supabase to turn it on." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Access"
        subtitle={`Who can sign in to ${auth.firm?.firmName ?? "this firm"} and what they can reach. Firm access covers every client. Client access covers one.`}
        testId="header-access"
      />
      {auth.firm?.firmSlug ? (
        <SectionCard title="Your sign up code" testId="card-firm-code">
          <p className="text-sm text-muted-foreground">
            Give this to a client so they can ask for access themselves: <span className="font-mono font-medium text-foreground">{auth.firm.firmSlug}</span>. They
            create their own login, enter this code, and it lands in the queue below for you to approve.
          </p>
        </SectionCard>
      ) : null}
      {pendingRequests.length > 0 || requestsLoading ? (
        <AccessRequestsQueue
          requests={pendingRequests}
          loading={requestsLoading}
          canResolve={auth.canManageAccess}
          clients={(clientsQ.data?.items ?? []).map((c) => ({ id: c.id, name: c.name }))}
          onResolved={() => {
            void loadRequests();
            void load();
          }}
        />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <SectionCard title="People" testId="card-access-people">
          <DataGrid rows={rows} cols={cols} rowKey={(r) => r.membershipId} loading={loading} error={error} onRetry={load} testId="grid-access" />
        </SectionCard>
        {auth.canManageAccess ? (
          <InviteForm onInvited={load} clients={(clientsQ.data?.items ?? []).map((c) => ({ id: c.id, name: c.name }))} />
        ) : (
          <SectionCard title="Invite" testId="card-invite-locked">
            <p className="text-sm text-muted-foreground">Only an owner or manager can invite or revoke people.</p>
          </SectionCard>
        )}
      </div>
    </>
  );
}

function AccessRequestsQueue({
  requests,
  loading,
  canResolve,
  clients,
  onResolved,
}: {
  requests: AccessRequestRow[];
  loading: boolean;
  canResolve: boolean;
  clients: { id: string; name: string }[];
  onResolved: () => void;
}) {
  const auth = useAuth();
  const { toast } = useToast();
  const [clientId, setClientId] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function approve(r: AccessRequestRow) {
    const pick = clientId[r.id];
    if (!pick) {
      toast({ title: "Choose a client first", variant: "destructive" });
      return;
    }
    setBusy(r.id);
    try {
      const res = await auth.authFetch(`/api/access-requests/${r.id}/approve`, { method: "POST", body: JSON.stringify({ clientId: pick }) });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        toast({ title: "Could not approve", description: body.error?.message ?? `The server answered ${res.status}.`, variant: "destructive" });
        return;
      }
      toast({ title: "Access granted", description: `${r.email} can now sign in.` });
      onResolved();
    } finally {
      setBusy(null);
    }
  }

  async function reject(r: AccessRequestRow) {
    const reason = window.prompt(`Why is ${r.email}'s request being turned down? They will see this.`);
    if (reason === null) return;
    if (!reason.trim()) {
      toast({ title: "A reason is required", variant: "destructive" });
      return;
    }
    setBusy(r.id);
    try {
      const res = await auth.authFetch(`/api/access-requests/${r.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        toast({ title: "Could not reject", description: body.error?.message ?? `The server answered ${res.status}.`, variant: "destructive" });
        return;
      }
      toast({ title: "Request turned down" });
      onResolved();
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionCard title="Access requests" description="People who signed up on their own and asked for access, oldest first." testId="card-access-requests">
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending requests.</p>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="rounded-sm border border-border p-3" data-testid={`request-${r.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{r.email}</span>
                  <span className="text-xs text-muted-foreground"> wants access for </span>
                  <span className="font-medium">{r.requestedClientName}</span>
                </div>
                <Pill tone="watch">{new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Pill>
              </div>
              {r.message ? <p className="mt-1 text-xs text-muted-foreground">"{r.message}"</p> : null}
              {canResolve ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select value={clientId[r.id] ?? ""} onValueChange={(v) => setClientId((prev) => ({ ...prev, [r.id]: v }))}>
                    <SelectTrigger className="w-56" data-testid={`select-request-client-${r.id}`}>
                      <SelectValue placeholder="Which client is this?" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={busy === r.id} onClick={() => void approve(r)} data-testid={`button-approve-${r.id}`}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void reject(r)} data-testid={`button-reject-${r.id}`}>
                    Turn down
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Only an owner or manager can decide this.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function InviteForm({ onInvited, clients }: { onInvited: () => void; clients: { id: string; name: string }[] }) {
  const auth = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [scope, setScope] = useState<MembershipScope>("firm");
  const [role, setRole] = useState<MembershipRole>("preparer");
  const [clientId, setClientId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const roles = scope === "firm" ? FIRM_ROLES : CLIENT_ROLES;

  function switchScope(s: MembershipScope) {
    setScope(s);
    setRole(s === "firm" ? "preparer" : "client_user");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await auth.authFetch("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), displayName: displayName.trim() || undefined, scope, role, clientId: scope === "client" ? clientId : undefined }),
      });
      const body = (await res.json()) as { emailSent?: boolean; error?: { message?: string } };
      if (!res.ok) {
        toast({ title: "Could not invite", description: body.error?.message ?? `The server answered ${res.status}.`, variant: "destructive" });
        return;
      }
      toast({
        title: "Invitation created",
        description: body.emailSent
          ? `${email.trim()} has an email with a link to set a password.`
          : `${email.trim()} already had a login. No email was sent; they can sign in with a link from the sign in page.`,
      });
      setEmail("");
      setDisplayName("");
      onInvited();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Invite someone" description="They get an email with a link. The link signs them in once and asks for a password." testId="card-invite">
      <form onSubmit={submit} className="space-y-3" data-testid="form-invite">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-invite-email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-name">Name (optional)</Label>
          <Input id="invite-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} data-testid="input-invite-name" />
        </div>
        <div className="space-y-1.5">
          <Label>Reach</Label>
          <div className="flex items-center rounded-sm border border-border bg-muted p-0.5" data-testid="switch-invite-scope">
            {(["firm", "client"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => switchScope(s)}
                className={`flex-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${scope === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-invite-scope-${s}`}
              >
                {s === "firm" ? "Whole firm" : "One client"}
              </button>
            ))}
          </div>
        </div>
        {scope === "client" ? (
          <div className="space-y-1.5">
            <Label>Client</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger data-testid="select-invite-client">
                <SelectValue placeholder="Choose a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Client ids here must be the tenancy client ids the server knows. Demo data clients will be refused.</p>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as MembershipRole)}>
            <SelectTrigger data-testid="select-invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{roles.find((r) => r.id === role)?.hint}</p>
        </div>
        <Button type="submit" className="w-full" disabled={busy || (scope === "client" && !clientId)} data-testid="button-invite">
          {busy ? "Sending" : "Send invitation"}
        </Button>
      </form>
    </SectionCard>
  );
}
