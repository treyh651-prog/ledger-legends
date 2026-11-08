/**
 * Outbound transactional email, via SMTP against a mailbox the user already
 * controls (Office 365, Google Workspace, or another provider) -- not a
 * third party transactional-email service, by the user's own choice.
 * nodemailer is the one real dependency this file has; there is no "plain
 * fetch" equivalent for raw SMTP the way document-storage.ts's own REST call
 * covers Supabase Storage. Nothing in this file decides WHO gets emailed or
 * WHETHER a given notification type is allowed to reach a client's inbox --
 * that is server/notify/*, which reads tenancy.notification_preferences
 * before ever calling send() here. This module only knows how to hand one
 * message to the configured mailbox's own SMTP server.
 */

import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly provider: "smtp" | "log";
  send(message: EmailMessage): Promise<{ sent: boolean }>;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** Null when any of the five values is missing. All five are required -- there is no partial configuration. */
export function readEmailEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  const from = env.EMAIL_FROM?.trim();
  const port = Number(env.SMTP_PORT ?? "587");
  if (!host || !user || !pass || !from || !Number.isFinite(port) || port <= 0) return null;
  return { host, port, user, pass, from };
}

export function createSmtpEmail(cfg: EmailConfig): EmailSender {
  // 465 is the one port that comes up already TLS wrapped; every other port
  // (587, 25) starts plain and upgrades with STARTTLS, which nodemailer does
  // on its own whenever the server offers it. secure: true on a non-465 port
  // is the single most common SMTP misconfiguration, so this is a plain
  // lookup rather than something the caller has to get right by hand.
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return {
    provider: "smtp",
    async send(message) {
      try {
        await transporter.sendMail({
          from: cfg.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html ?? message.text,
        });
      } catch (err) {
        throw new EmailError(`SMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
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
