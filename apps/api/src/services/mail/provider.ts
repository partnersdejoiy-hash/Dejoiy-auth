import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";

/**
 * Mail provider abstraction. The authentication/notification logic never
 * depends on a concrete provider — switching providers is configuration only.
 *
 * Providers: console | smtp | dejoiy-swiss | ses
 */

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  correlationId?: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

class ConsoleProvider implements MailProvider {
  readonly name = "console";
  async send(message: MailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[mail:console] to=${message.to.join(",")} subject="${message.subject}"`);
    // eslint-disable-next-line no-console
    console.log(message.text.slice(0, 2000));
  }
}

class SmtpProvider implements MailProvider {
  readonly name = "smtp";
  async send(message: MailMessage): Promise<void> {
    const cfg = getConfig();
    if (!cfg.SMTP_HOST) throw new Error("SMTP host not configured");
    // Lazy-load nodemailer only when the SMTP provider is actually selected.
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined
    });
    await transporter.sendMail({
      from: message.from ?? cfg.MAIL_FROM,
      to: message.to.join(","),
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  }
}

/**
 * DEJOIY Swiss Mail API adapter.
 * Endpoint contract (v1 draft): POST {url}/v1/mail/send with
 * { "to": [], "subject": "", "text": "", "html": "" }, headers
 * Authorization: Bearer {key}. Configure via DEJOIY_MAIL_API_URL + DEJOIY_MAIL_API_KEY.
 */
class DejoiySwissProvider implements MailProvider {
  readonly name = "dejoiy-swiss";
  async send(message: MailMessage): Promise<void> {
    const cfg = getConfig();
    if (!cfg.DEJOIY_MAIL_API_URL) throw new Error("DEJOIY_MAIL_API_URL not configured");
    const res = await fetch(`${cfg.DEJOIY_MAIL_API_URL.replace(/\/$/, "")}/v1/mail/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: cfg.DEJOIY_MAIL_API_KEY ? `Bearer ${cfg.DEJOIY_MAIL_API_KEY}` : ""
      },
      body: JSON.stringify({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        from: message.from ?? cfg.MAIL_FROM
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`DEJOIY Swiss Mail API error ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}

class SesProvider implements MailProvider {
  readonly name = "ses";
  async send(message: MailMessage): Promise<void> {
    const cfg = getConfig();
    if (!cfg.AWS_SES_REGION) throw new Error("AWS SES region not configured");
    const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
    const client = new SESClient({
      region: cfg.AWS_SES_REGION,
      credentials:
        cfg.AWS_SES_ACCESS_KEY_ID && cfg.AWS_SES_SECRET_ACCESS_KEY
          ? { accessKeyId: cfg.AWS_SES_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SES_SECRET_ACCESS_KEY }
          : undefined
    });
    await client.send(
      new SendEmailCommand({
        Source: message.from ?? cfg.MAIL_FROM,
        Destination: { ToAddresses: message.to },
        Message: {
          Subject: { Data: message.subject },
          Body: { Text: { Data: message.text }, Html: message.html ? { Data: message.html } : undefined }
        }
      })
    );
  }
}

let provider: MailProvider | null = null;

export function getMailProvider(): MailProvider {
  if (provider) return provider;
  const cfg = getConfig();
  switch (cfg.MAIL_PROVIDER) {
    case "smtp":
      provider = new SmtpProvider();
      break;
    case "dejoiy-swiss":
      provider = new DejoiySwissProvider();
      break;
    case "ses":
      provider = new SesProvider();
      break;
    case "console":
    default:
      provider = new ConsoleProvider();
  }
  logger.info({ provider: provider.name }, "mail provider selected");
  return provider;
}

export async function sendMail(message: MailMessage): Promise<void> {
  await getMailProvider().send(message);
}
