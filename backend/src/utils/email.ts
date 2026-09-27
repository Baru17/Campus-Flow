/*
 * Brevo transactional email over the REST API.
 *
 * The API key is read from the Worker secret binding and is never returned,
 * logged, or included in an error message. The reset link embeds the raw
 * one-time token, so neither the link nor the token is ever logged either.
 */

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

const FROM_NAME = "Campus-Flow";
const FROM_EMAIL = "campusflow.kiot@gmail.com";

const RESET_SUBJECT = "Reset your Campus-Flow password";

const RESET_EXPIRY_MINUTES = 30;

export interface EmailBindings {
  BREVO_API_KEY?: string;
}

export interface PasswordResetMessage {
  to: string;
  toName?: string | null;
  resetUrl: string;
  expiresInMinutes?: number;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email provider is not configured.");
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailDeliveryError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Email provider rejected the request.");
    this.name = "EmailDeliveryError";
    this.status = status;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml({ toName, resetUrl, expiresInMinutes }: Required<PasswordResetMessage>): string {
  const greeting = toName ? `Hi ${escapeHtml(toName)},` : "Hi,";
  const link = escapeHtml(resetUrl);
  const minutes = expiresInMinutes;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
      <tr>
        <td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${greeting}</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Reset your Campus-Flow password</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#334155;">We received a request to reset the password for your Campus-Flow account. Choose a new password using the button below.</p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">Reset password</a>
          </p>
          <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#64748b;">This link expires in ${minutes} minutes and can only be used once.</p>
          <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#64748b;">If the button does not work, copy this address into your browser:</p>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;color:#2563eb;">${link}</p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">If you did not request a password reset, you can safely ignore this email and your current password will stay unchanged.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText({ toName, resetUrl, expiresInMinutes }: Required<PasswordResetMessage>): string {
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  return [
    greeting,
    "",
    "We received a request to reset the password for your Campus-Flow account.",
    "Choose a new password using the link below.",
    "",
    resetUrl,
    "",
    `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
    "If you did not request a password reset, you can safely ignore this email and your current password will stay unchanged.",
  ].join("\n");
}

export async function sendPasswordResetEmail(
  env: EmailBindings,
  message: PasswordResetMessage
): Promise<void> {
  const apiKey = env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailNotConfiguredError();
  }

  const recipient = message.to.trim().toLowerCase();
  if (!recipient || !recipient.includes("@")) {
    throw new EmailDeliveryError(400);
  }

  const normalized: Required<PasswordResetMessage> = {
    to: recipient,
    toName: message.toName?.trim() || null,
    resetUrl: message.resetUrl,
    expiresInMinutes: message.expiresInMinutes ?? RESET_EXPIRY_MINUTES,
  };

  const response = await fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: normalized.to, name: normalized.toName ?? FROM_NAME }],
      subject: RESET_SUBJECT,
      htmlContent: buildHtml(normalized),
      textContent: buildText(normalized),
    }),
  });

  if (!response.ok) {
    /*
     * Brevo names the offending field in `code`/`message`, which is what makes
     * a rejected payload diagnosable. Any URL is redacted first so a reset link
     * can never reach the log, and the key is never part of either value.
     */
    let code: string | null = null;
    let message: string | null = null;
    try {
      const parsed = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof parsed?.code === "string") code = parsed.code.slice(0, 64);
      if (typeof parsed?.message === "string") {
        message = parsed.message.replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 160);
      }
    } catch {
      code = null;
    }
    console.error(
      JSON.stringify({ event: "password_reset_email_rejected", status: response.status, code, message })
    );
    throw new EmailDeliveryError(response.status);
  }
}
