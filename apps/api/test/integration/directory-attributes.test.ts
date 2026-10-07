import type { AddressInfo } from 'node:net'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountFor } from '../../src/accounts.js'
import type { Application } from '../../src/app.js'
import type { DirectoryValues, ProductDirectory } from '../../src/directory.js'
import { createTestApp } from '../support/app.js'
import { makeUser } from '../support/roles.js'
import type { TestIdp } from '../support/saml-idp.js'
import { db } from '../support/worker-database.js'

// ADR 0008, 0009: the further directory attributes a product names, handed to
// it where accountFor() makes an account and at every login. Against the
// stack's LDAPS test directory, whose people carry `ou` and `groupMembership`
// (containers/ldap/seed/attributes.ldif). The product's own hand-over is
// replaced by one that records its calls.

interface Call {
  trx: Knex | Knex.Transaction
  userId: string
  values: DirectoryValues
}

const recorder = (attributes: readonly string[]) => {
  const calls: Call[] = []
  const product: ProductDirectory = {
    attributes,
    apply: async (trx, userId, values) => {
      calls.push({ trx, userId, values })
    }
  }
  return { calls, product }
}

const AD01ADMN = {
  ou: ['T400120', 'T40', 'T4001', 'T40012'],
  groupMembership: ['cn=T400120,ou=groups,o=tu', 'cn=all-staff,ou=groups,o=tu']
}

const serve = async (app: Application) => {
  const server = await app.listen(0)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// A complete login at the ACS, as the test IdP's person (us01user by default).
const login = async (base: string, idp: TestIdp, attributes?: Record<string, string>) => {
  const { inflateRawSync } = await import('node:zlib')
  const location = await fetch(`${base}/api/auth/saml/login?returnTo=/start`, { redirect: 'manual' }).then(
    (r) => r.headers.get('location') ?? ''
  )
  const request = inflateRawSync(Buffer.from(new URL(location).searchParams.get('SAMLRequest') ?? '', 'base64')).toString()
  const inResponseTo = /ID="([^"]+)"/.exec(request)?.[1] ?? ''
  const SAMLResponse = await idp.response({ inResponseTo, ...(attributes ? { attributes } : {}) })
  return fetch(`${base}/api/auth/saml/acs`, {
    method: 'POST',
    body: new URLSearchParams({ SAMLResponse }),
    redirect: 'manual'
  })
}

const userIdOf = async (tuId: string): Promise<string> => (await db()('users').where({ tu_id: tuId }).first('id')).id

describe('where accountFor() makes an account', () => {
  const { calls, product } = recorder(['ou', 'groupMembership'])
  let app: Application

  beforeAll(async () => {
    ;({ app } = await createTestApp({ productDirectory: product }))
  })
  afterAll(async () => {
    await app.teardown()
  })
  beforeEach(() => {
    calls.length = 0
  })

  it('hands every value of the named attributes to the product, in the transaction of the write', async () => {
    let outer: Knex.Transaction | undefined
    const account = await app.get('knex').transaction((trx) => {
      outer = trx
      return accountFor(app, trx, 'ad01admn', { actorId: null })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: account.id, values: AD01ADMN })
    expect(calls[0]?.trx).toBe(outer)
  })

  it('hands an attribute the person lacks over without values', async () => {
    await app.get('knex').transaction((trx) => accountFor(app, trx, 'us02othr', { actorId: null }))
    expect(calls.map((call) => call.values)).toEqual([{ ou: [], groupMembership: [] }])
  })

  it('does not ask again for an account that exists', async () => {
    await makeUser(app, 'us01user', [])
    await app.get('knex').transaction((trx) => accountFor(app, trx, 'us01user', { actorId: null }))
    expect(calls).toEqual([])
  })

  it("keeps the product's spelling of a name, which LDAP compares without case", async () => {
    const { calls: spelled, product: other } = recorder(['OU', 'groupmembership'])
    const { app: second } = await createTestApp({ productDirectory: other })
    try {
      await second.get('knex').transaction((trx) => accountFor(second, trx, 'op01oper', { actorId: null }))
    } finally {
      await second.teardown()
    }
    expect(spelled.map((call) => call.values)).toEqual([{ OU: ['T2', 'T201'], groupmembership: ['cn=T201,ou=groups,o=tu'] }])
  })

  it('leaves them out of directory lookup', async () => {
    const reader = await makeUser(app, 'lookup01', ['directory.read'])
    const page = await app
      .service('directory')
      .find({ provider: 'rest', user: reader, authenticated: true, query: { q: 'ad01admn' } })
    expect(page.data.map((entry) => Object.keys(entry).sort())).toEqual([['email', 'givenName', 'surname', 'tuId', 'userId']])
  })
})

describe('at every login', () => {
  const { calls, product } = recorder(['ou', 'groupMembership'])
  let app: Application
  let idp: TestIdp
  let base: string

  beforeAll(async () => {
    ;({ app, idp } = await createTestApp({ productDirectory: product }))
    base = await serve(app)
  })
  afterAll(async () => {
    await app.teardown()
  })
  beforeEach(() => {
    calls.length = 0
  })

  it('looks the person up by TU-ID and hands the values over, every time', async () => {
    expect((await login(base, idp)).status).toBe(303)
    expect((await login(base, idp)).status).toBe(303)
    const userId = await userIdOf('us01user')
    expect(calls.map(({ userId, values }) => ({ userId, values }))).toEqual([
      { userId, values: { ou: [], groupMembership: ['cn=students,ou=groups,o=tu'] } },
      { userId, values: { ou: [], groupMembership: ['cn=students,ou=groups,o=tu'] } }
    ])
    expect(calls[0]?.trx.isTransaction).toBe(true)
  })

  it('logs in a person the directory no longer knows, without handing anything over', async () => {
    const response = await login(base, idp, { cn: 'gone0002', givenName: 'Gina', sn: 'Gone', mail: 'gina.gone@example.org' })
    expect(response.status).toBe(303)
    expect(calls).toEqual([])
  })

  it('does not ask the directory when the product names no attribute', async () => {
    const { calls: none, product: nothing } = recorder([])
    const { app: plain, idp: plainIdp } = await createTestApp({ productDirectory: nothing })
    const lookups: unknown[] = []
    const directory = plain.get('directory')
    const find = directory.find.bind(directory)
    directory.find = (...args) => {
      lookups.push(args)
      return find(...args)
    }
    try {
      expect((await login(await serve(plain), plainIdp)).status).toBe(303)
    } finally {
      await plain.teardown()
    }
    expect(lookups).toEqual([])
    expect(none).toEqual([])
  })
})

describe('a directory that cannot be reached at login', () => {
  it('does not stop the login; the product keeps what it had', async () => {
    const { calls, product } = recorder(['ou'])
    const { app, idp } = await createTestApp({ productDirectory: product, ldap: { ldapUrl: 'ldaps://ldap:1' } })
    try {
      const response = await login(await serve(app), idp)
      expect(response.status).toBe(303)
      expect(response.headers.get('set-cookie')).toBeTruthy()
    } finally {
      await app.teardown()
    }
    expect(calls).toEqual([])
  })
})
