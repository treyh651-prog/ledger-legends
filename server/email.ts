/**
 * Outbound transactional email. One interface, two providers, the same
 * shape document-storage.ts already uses: plain fetch against Resend's REST
 * API (no SDK -- the whole call is one POST), and a logging stand-in for
 * every environment without a real key. Nothing in this file decides WHO
 * gets emailed or WHETHER a given notification type is allowed to reach a
 * client's inbox -- that is server/notify/*, which reads
 * tenancy.notification_preferences before ever calling send() here. This
 * module only knows how to hand one message to a provider.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly provider: "resend" | "log";
  send(message: EmailMessage): Promise<{ sent: boolean }>;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailConfig {
  apiKey: string;
  from: string;
}

/** Null when either value is missing. Both are required -- there is no partial configuration. */
export function readEmailEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function createResendEmail(cfg: EmailConfig): EmailSender {
  return {
    provider: "resend",
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: cfg.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? message.text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EmailError(`Resend answered ${res.status} on send${body ? `: ${body}` : ""}`);
      }
      return { sent: true };
    },
  };
}

/** No provider configured: logs instead of sending, and says so, matching the convention docs/09 already states for this feature. */
export function createLoggingEmail(): EmailSender {
  return {
    provider: "log",
    async send(message) {
      console.log(`email (not configured, logging instead): to ${message.to}, subject "${message.subject}"`);
      return { sent: false };
    },
  };
}
