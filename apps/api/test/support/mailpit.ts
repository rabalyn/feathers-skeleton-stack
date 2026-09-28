import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { SMTP_KEYS, loadConfig, type SmtpConfig } from '../../src/config.js'

// Mailpit (ADR 0022, 0027): the stack's SMTP capture, whose API tells the
// tests what arrived. Over TLS, verified like every other hop.

export const loadSmtpConfig = (): Promise<SmtpConfig> => loadConfig(SMTP_KEYS)

export interface MailpitMessage {
  ID: string
  Subject: string
  To: { Name: string; Address: string }[]
  From: { Name: string; Address: string }
  Created: string
}

const api = async <T>(path: string): Promise<T> => {
  const config = await loadSmtpConfig()
  const ca = readFileSync(config.smtpCaFile, 'utf8')
  return new Promise<T>((resolve, reject) => {
    const req = request({ host: config.smtpHost, port: 8025, path, ca, servername: config.smtpHost }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) reject(new Error(`mailpit ${path}: ${res.statusCode} ${text}`))
        else resolve(JSON.parse(text) as T)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Messages to one address, newest first.
export const messagesTo = async (address: string): Promise<MailpitMessage[]> =>
  (await api<{ messages: MailpitMessage[] }>(`/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)).messages

export const messageText = async (id: string): Promise<{ Text: string; HTML: string; Subject: string }> =>
  api(`/api/v1/message/${encodeURIComponent(id)}`)
