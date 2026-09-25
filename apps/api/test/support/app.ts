import { pino } from 'pino'
import { createApp, type Application } from '../../src/app.js'
import { createKnex } from '../../src/db.js'
import { workerDatabaseConfig } from './worker-database.js'

// An application on this worker's database, not listening on any port.
// Service calls with `provider` set go through the same hooks as REST and
// WebSocket requests.
export const createTestApp = (): Application => {
  const database = workerDatabaseConfig()
  return createApp(
    {
      ...database,
      publicOrigin: 'https://app.test',
      authSigningSecret: 'test-only-signing-secret-that-is-long-enough',
      port: 0,
      internalPort: 0,
      logLevel: 'fatal'
    },
    pino({ level: 'silent' }),
    createKnex(database, { camelCase: true })
  )
}
