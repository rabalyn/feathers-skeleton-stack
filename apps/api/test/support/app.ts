import { pino } from 'pino'
import { createApp, type Application } from '../../src/app.js'
import { createKnex } from '../../src/db.js'
import { IDP_ENTITY_ID, IDP_SSO_URL, PUBLIC_ORIGIN, TestIdp, keyPair, type KeyPair } from './saml-idp.js'
import { workerDatabaseConfig } from './worker-database.js'

export const BODY_SIZE_CEILING_BYTES = 10 * 1024 * 1024

export interface TestContext {
  app: Application
  idp: TestIdp
  sp: KeyPair
}

// An application on this worker's database, not listening on any port, with
// a freshly generated SP key pair and a test IdP whose certificate it trusts.
// Service calls with `provider` set go through the same hooks as REST and
// WebSocket requests.
export const createTestApp = async (): Promise<TestContext> => {
  const [sp, idpKey] = await Promise.all([keyPair('sp.test'), keyPair('idp.test')])
  const database = workerDatabaseConfig()
  const app = createApp(
    {
      ...database,
      publicOrigin: PUBLIC_ORIGIN,
      authSigningSecret: 'test-only-signing-secret-that-is-long-enough',
      refreshTokenKey: 'test-only-refresh-token-key-that-is-long-enough',
      samlSpPrivateKey: sp.privateKey,
      samlSpCertificate: sp.certificate,
      samlIdpCertificate: idpKey.certificate,
      samlIdpEntityId: IDP_ENTITY_ID,
      samlIdpSsoUrl: IDP_SSO_URL,
      samlIdpSloUrl: IDP_SSO_URL,
      port: 0,
      internalPort: 0,
      logLevel: 'fatal',
      bodySizeCeilingBytes: BODY_SIZE_CEILING_BYTES
    },
    pino({ level: 'silent' }),
    createKnex(database, { camelCase: true }),
    // Tests change settings in the database directly and expect the next
    // request to see them.
    { settingsTtlMs: 0 }
  )
  return { app, idp: new TestIdp(idpKey), sp }
}
