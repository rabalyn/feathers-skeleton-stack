import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { pino } from 'pino'
import { createApp, type Application } from '../../src/app.js'
import { LDAP_KEYS, VALKEY_KEYS, loadConfig, type LdapConfig, type ValkeyConfig } from '../../src/config.js'
import { createKnex } from '../../src/db.js'
import { createValkey } from '../../src/valkey.js'
import { IDP_ENTITY_ID, IDP_SSO_URL, PUBLIC_ORIGIN, TestIdp, keyPair, type KeyPair } from './saml-idp.js'
import { workerDatabaseConfig } from './worker-database.js'

export const BODY_SIZE_CEILING_BYTES = 10 * 1024 * 1024

// The test process talks to the app over loopback, so loopback plays Nginx:
// tests choose their client address with X-Forwarded-For.
export const TRUSTED_PROXY_HOST = 'localhost'

export interface TestContext {
  app: Application
  idp: TestIdp
  sp: KeyPair
  // This app's rate-limit key prefix; keys of other apps and earlier runs
  // live beside it in the same Valkey.
  rateLimitPrefix: string
}

export const loadValkeyConfig = (): Promise<ValkeyConfig> => loadConfig(VALKEY_KEYS)

export interface TestAppOptions {
  // Replaces the connection to the stack's Valkey, e.g. with one that cannot
  // connect.
  valkey?: Redis
  trustedProxyHost?: string
  ldap?: Partial<LdapConfig>
}

// An application on this worker's database, not listening on any port, with
// a freshly generated SP key pair and a test IdP whose certificate it trusts.
// Service calls with `provider` set go through the same hooks as REST and
// WebSocket requests. Its rate-limit counters live under a prefix of its own,
// so test files never share a limit.
export const createTestApp = async (options: TestAppOptions = {}): Promise<TestContext> => {
  const [sp, idpKey] = await Promise.all([keyPair('sp.test'), keyPair('idp.test')])
  const database = workerDatabaseConfig()
  const valkeyConfig = await loadValkeyConfig()
  // The stack's test directory, bound with the api's own service account.
  const ldapConfig = await loadConfig(LDAP_KEYS)
  const rateLimitPrefix = `test:${randomUUID()}`
  const app = createApp(
    {
      ...database,
      ...valkeyConfig,
      ...ldapConfig,
      ...options.ldap,
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
      logFile: '',
      internalTlsCertFile: 'unused-in-tests',
      internalTlsKeyFile: 'unused-in-tests',
      bodySizeCeilingBytes: BODY_SIZE_CEILING_BYTES,
      trustedProxyHost: options.trustedProxyHost ?? TRUSTED_PROXY_HOST,
      // Replaced by the per-app prefix below.
      rateLimitPrefix: 'rl'
    },
    pino({ level: 'silent' }),
    createKnex(database, { camelCase: true }),
    // A listener, as index.ts attaches one: without it ioredis prints every
    // connection error, e.g. of an app torn down mid-handshake. Failing
    // commands still reach the tests.
    options.valkey ?? createValkey(valkeyConfig).on('error', () => {}),
    // Tests change settings in the database directly and expect the next
    // request to see them.
    { settingsTtlMs: 0, rateLimitPrefix }
  )
  return { app, idp: new TestIdp(idpKey), sp, rateLimitPrefix }
}
