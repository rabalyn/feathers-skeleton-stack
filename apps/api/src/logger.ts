import roll from 'pino-roll'
import { multistream, pino, type Level, type Logger, type LoggerOptions } from 'pino'
import { currentRequest } from './request-context.js'

// Redaction is configured here once rather than at call sites (ADR 0021).
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

// Rotation by size with a bounded number of kept files, so the log volume
// cannot fill the host (ADR 0021): at most LOG_FILE_SIZE times
// LOG_FILES_KEPT plus the current file, per service.
const LOG_FILE_SIZE = '10m'
const LOG_FILES_KEPT = 5

export const loggerOptions = (service: string, level: string): LoggerOptions => ({
  level,
  base: { service },
  // `timestamp` and a textual `level`, which Loki queries and labels by.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label: string) => ({ level: label }) },
  messageKey: 'msg',
  redact: { paths: redactPaths, censor: '[redacted]' },
  // Every line written inside a request names it (ADR 0021).
  mixin: () => {
    const request = currentRequest()
    if (!request) return {}
    return {
      request_id: request.requestId,
      ...(request.userRef ? { user_ref: request.userRef } : {}),
      ...(request.viewAsRef ? { view_as_ref: request.viewAsRef } : {}),
      ...(request.apiTokenRef ? { api_token_ref: request.apiTokenRef } : {})
    }
  }
})

// Newline-delimited JSON to stdout and, where `file` is given, to rotated
// files `<file>.<n>.log` on the shared log volume, which the collector reads
// (ADR 0021).
export const createLogger = async (service: string, level: string, file?: string): Promise<Logger> => {
  const options = loggerOptions(service, level)
  if (!file) return pino(options)
  const rotated = await roll({
    file,
    extension: '.log',
    size: LOG_FILE_SIZE,
    limit: { count: LOG_FILES_KEPT },
    mkdir: true
  })
  return pino(options, multistream([{ level: 'trace' as Level, stream: process.stdout }, { level: 'trace' as Level, stream: rotated }]))
}
