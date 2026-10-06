import { readFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { createTransport } from 'nodemailer'
import type { SmtpConfig } from '../config.js'
import type { RenderedMail } from './render.js'

// Sending (ADR 0027): the worker only, never the api. No SMTP login: the
// relay accepts the stack's hosts by their names. TLS always, and how
// follows from the port: 465 is implicit TLS, any other port requires
// STARTTLS, so a server that does not offer it fails the delivery. The
// certificate is verified against the system roots and the CA root.

export interface Recipient {
  name: string
  address: string
}

export interface MailSender {
  send(to: Recipient, mail: RenderedMail): Promise<void>
  verify(): Promise<void>
  close(): void
}

// A 5xx reply to this message or its recipient is permanent: retrying
// would get the same answer. Anything else (a 4xx, a lost connection, TLS
// that failed or was not offered) is about the server, and tried again.
export const isPermanentFailure = (error: unknown): boolean => {
  const { responseCode, code } = error as { responseCode?: unknown; code?: unknown }
  return (
    typeof responseCode === 'number' &&
    responseCode >= 500 &&
    responseCode < 600 &&
    (code === 'EENVELOPE' || code === 'EMESSAGE')
  )
}

export const createSender = (config: SmtpConfig): MailSender => {
  const implicitTls = config.smtpPort === 465
  const transport = createTransport(
    {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: implicitTls,
      requireTLS: !implicitTls,
      ignoreTLS: false,
      tls: {
        ca: [...rootCertificates, readFileSync(config.smtpCaFile, 'utf8')],
        servername: config.smtpHost,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
      },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
      // A message is built from strings only.
      disableFileAccess: true,
      disableUrlAccess: true
    },
    { from: { name: config.appName, address: config.mailFrom } }
  )
  return {
    send: async (to, mail) => {
      await transport.sendMail({
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        // RFC 3834: no auto-replies to this.
        headers: { 'Auto-Submitted': 'auto-generated' }
      })
    },
    verify: async () => {
      await transport.verify()
    },
    close: () => transport.close()
  }
}
