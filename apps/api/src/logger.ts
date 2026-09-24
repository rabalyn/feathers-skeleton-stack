import { pino, type Logger } from 'pino'

// Redaction is configured here once rather than at call sites (ADR 0021).
// File output to the shared log volume arrives with the observability slice.
export const redactPaths = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'SAMLResponse',
  '*.SAMLResponse'
]

export const createLogger = (service: string, level: string): Logger =>
  pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    redact: { paths: redactPaths, censor: '[redacted]' }
  })
