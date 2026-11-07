/**
 * Sign in, and the two screens next to it: a password reset request and the
 * set password form an invitation or recovery link lands on.
 *
 * Plain forms. The point is to be unsurprising to a bookkeeper at 7am.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { useAuth } from "@/lib/auth";

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-md border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          : "rounded-sm border border-border bg-muted px-3 py-2 text-sm text-foreground"
      }
      data-testid={`notice-${tone}`}
    >
      {children}
    </p>
  );
}

export function SignIn() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [mode, setMode] = useState<"password" | "link" | "reset" | "signup">("password");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      if (mode === "password") {
        const err = await auth.signInWithPassword(email.trim(), password);
        if (err) setError(err);
      } else if (mode === "link") {
        const err = await auth.signInWithMagicLink(email.trim());
        if (err) setError(err);
        else setSent("Check your email for a sign in link. It is good for one use.");
      } else if (mode === "signup") {
        if (password.length < 10) {
          setError("Use at least ten characters.");
          return;
        }
        const { error: err, needsConfirmation } = await auth.signUpWithPassword(email.trim(), password);
        if (err) setError(err);
        else if (needsConfirmation) setSent("Check your email for a confirmation link, then come back and sign in.");
        // No confirmation needed: onAuthStateChange picks up the new session on its own.
      } else {
        const err = await auth.requestPasswordReset(email.trim());
        if (err) setError(err);
        else setSent("If that address has a login, a reset link is on its way.");
      }
    } finally {
      setBusy(false);
    }
  }

  const titles = {
    password: ["Sign in", "Use the email your firm invited."],
    link: ["Email me a link", "No password needed. The link signs you in once."],
    reset: ["Reset your password", "We will email a link that lets you set a new one."],
    signup: ["Create an account", "For a client asking a firm for access. Your firm invites you directly if you work there."],
  } as const;

  return (
    <Frame title={titles[mode][0]} subtitle={titles[mode][1]}>
      <form onSubmit={submit} className="space-y-4" data-testid="form-sign-in">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="input-email"
          />
        </div>
        {mode === "password" || mode === "signup" ? (
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="input-password"
            />
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {sent ? <Notice tone="ok">{sent}</Notice> : null}
        <Button type="submit" className="w-full" disabled={busy} data-testid="button-submit">
          {busy ? "One moment" : mode === "password" ? "Sign in" : mode === "link" ? "Send link" : mode === "signup" ? "Create account" : "Send reset link"}
        </Button>
      </form>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        {mode !== "password" ? (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode("password")} data-testid="link-password">
            Sign in instead
          </button>
        ) : (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode("link")} data-testid="link-magic">
            Email me a link instead
          </button>
        )}
        {mode !== "reset" ? (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode("reset")} data-testid="link-reset">
            Forgot password
          </button>
        ) : null}
        {mode !== "signup" ? (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setMode("signup")} data-testid="link-signup">
            I am a client, create an account
          </button>
        ) : null}
      </div>
    </Frame>
  );
}

/** Shown after an invitation or recovery link has produced a session. */
export function SetPassword() {
  const auth = useAuth();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError("Use at least ten characters.");
      return;
    }
    if (password !== again) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const err = await auth.updatePassword(password);
      if (err) setError(err);
      else auth.clearLinkType();
    } finally {
      setBusy(false);
    }
  }

  const invited = auth.linkType === "invite";
  return (
    <Frame
      title={invited ? "Welcome. Set a password." : "Set a new password"}
      subtitle={invited ? `You are signed in as ${auth.me?.email ?? auth.session?.user.email ?? "a new user"}. Choose a password for next time.` : "Your reset link worked. Choose a new password."}
    >
      <form onSubmit={submit} className="space-y-4" data-testid="form-set-password">
        <div className="space-y-1.5">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-new-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="again-password">Again</Label>
          <Input
            id="again-password"
            type="password"
            autoComplete="new-password"
            required
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            data-testid="input-again-password"
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" className="w-full" disabled={busy} data-testid="button-set-password">
          {busy ? "Saving" : "Save password"}
        </Button>
        <button type="button" className="w-full text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => auth.clearLinkType()} data-testid="link-skip-password">
          Skip for now
        </button>
      </form>
    </Frame>
  );
}

/** Signed in with Supabase, but refused outright (disabled, or the server would not say). */
export function NotAMember() {
  const auth = useAuth();
  return (
    <Frame title="Sign in was refused" subtitle={auth.reason ?? "The server did not accept the login."}>
      <Button variant="outline" className="w-full" onClick={() => void auth.signOut()} data-testid="button-sign-out-refused">
        Sign out
      </Button>
    </Frame>
  );
}

interface MyAccessRequest {
  id: string;
  firmName: string;
  requestedClientName: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason: string | null;
}

/**
 * A valid Supabase login with no tenancy row. Either this is the first time
 * (a self signed up client) or a request was already sent and is pending or
 * was rejected. GET /api/access-requests/mine answers through requireToken,
 * which asks nothing more than a verified token -- exactly this login's
 * situation.
 */
export function RequestAccess() {
  const auth = useAuth();
  const [mine, setMine] = useState<MyAccessRequest[] | null>(null);
  const [firmSlug, setFirmSlug] = useState("");
  const [clientName, setClientName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await auth.authFetch("/api/access-requests/mine");
      if (!res.ok) return;
      const body = (await res.json()) as { requests?: MyAccessRequest[] };
      setMine(body.requests ?? []);
    } catch {
      setMine([]);
    }
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = mine?.find((r) => r.status === "pending") ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await auth.authFetch("/api/access-requests", {
        method: "POST",
        body: JSON.stringify({ firmSlug: firmSlug.trim(), requestedClientName: clientName.trim(), message: message.trim() || undefined }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(body.error?.message ?? `The server answered ${res.status}.`);
        return;
      }
      setSent(true);
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <Frame title="Request sent" subtitle={`Waiting on ${pending.firmName} to grant access for ${pending.requestedClientName}.`}>
        <Notice tone="ok">We will email you once the firm decides. No need to ask again.</Notice>
        <Button variant="outline" className="mt-4 w-full" onClick={() => void auth.signOut()} data-testid="button-sign-out-pending">
          Sign out
        </Button>
      </Frame>
    );
  }

  const lastRejected = !pending ? mine?.find((r) => r.status === "rejected") ?? null : null;

  return (
    <Frame title="Ask a firm for access" subtitle={`${auth.session?.user.email ?? "This login"} has no firm access yet. Enter the sign up code your firm gave you.`}>
      {lastRejected ? (
        <Notice tone="error">
          {lastRejected.firmName} did not approve the last request{lastRejected.rejectionReason ? `: ${lastRejected.rejectionReason}` : "."} You can try again below.
        </Notice>
      ) : null}
      {sent ? (
        <Notice tone="ok">Request sent.</Notice>
      ) : (
        <form onSubmit={submit} className="mt-3 space-y-4" data-testid="form-request-access">
          <div className="space-y-1.5">
            <Label htmlFor="firm-slug">Firm sign up code</Label>
            <Input id="firm-slug" required value={firmSlug} onChange={(e) => setFirmSlug(e.target.value)} data-testid="input-firm-slug" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Your business name</Label>
            <Input id="client-name" required value={clientName} onChange={(e) => setClientName(e.target.value)} data-testid="input-client-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-message">Note to the firm (optional)</Label>
            <Input id="request-message" value={message} onChange={(e) => setMessage(e.target.value)} data-testid="input-request-message" />
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button type="submit" className="w-full" disabled={busy} data-testid="button-submit-request">
            {busy ? "Sending" : "Send request"}
          </Button>
        </form>
      )}
      <button
        type="button"
        className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => void auth.signOut()}
        data-testid="button-sign-out-request"
      >
        Sign out
      </button>
    </Frame>
  );
}

export function AuthLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-muted/40">
      <p className="text-sm text-muted-foreground" role="status">
        {label}
      </p>
    </div>
  );
}
