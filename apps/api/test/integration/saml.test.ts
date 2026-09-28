import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { SamlRejected, type ServiceProvider } from '../../src/auth/saml.js'
import { createTestApp } from '../support/app.js'
import { IDP_SSO_URL, SP_ACS, keyPair, type KeyPair, type TestIdp } from '../support/saml-idp.js'

// ADR 0008: "Every assertion is rejected unless all of the following hold."
// Each item has a negative test here, against the real service provider.

let app: Application
let idp: TestIdp
let spKeys: KeyPair
let sp: ServiceProvider
let attacker: KeyPair

beforeAll(async () => {
  ;({ app, idp, sp: spKeys } = await createTestApp())
  sp = app.get('serviceProvider')
  attacker = await keyPair('attacker.test')
})

afterAll(async () => {
  await app.teardown()
})

// Starts a login and returns the ID of the AuthnRequest the SP issued.
const startLogin = async (returnTo: unknown = '/after') => {
  const url = new URL(await sp.loginUrl(returnTo))
  const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64')).toString()
  const id = /ID="([^"]+)"/.exec(request)?.[1]
  if (!id) throw new Error('no request ID')
  return { id, url, request }
}

const rejects = async (promise: Promise<unknown>, reason: RegExp) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(SamlRejected)
  expect((error as Error).message).toMatch(reason)
}

describe('SAML: authentication request', () => {
  it('is a signed redirect to the IdP, answering to our ACS', async () => {
    const { url, request } = await startLogin()
    expect(`${url.origin}${url.pathname}`).toBe(IDP_SSO_URL)
    expect(url.searchParams.get('SigAlg')).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256')
    expect(url.searchParams.get('Signature')).toBeTruthy()
    expect(request).toContain(`AssertionConsumerServiceURL="${SP_ACS}"`)
  })

  it('publishes metadata with the SP certificate for signing and encryption', () => {
    const metadata = sp.metadata()
    const body = spKeys.certificate.replace(/-----[^-]+-----|\s/g, '')
    const published = [...metadata.matchAll(/<ds:X509Certificate>([^<]+)</g)].map((m) => m[1]?.replace(/\s/g, ''))
    expect(published).toEqual([body, body])
    expect(metadata).toMatch(/use="encryption"/)
    expect(metadata).toMatch(/use="signing"/)
  })
})

describe('SAML: a valid response', () => {
  it('yields the asserted identity and the stored return path', async () => {
    const { id } = await startLogin('/documents?page=2')
    const identity = await sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id }) })
    expect(identity).toMatchObject({
      tuId: 'us01user',
      givenName: 'Uma',
      surname: 'User',
      email: 'uma.user@example.org',
      nameId: 'persistent-name-id-1',
      sessionIndex: 'idp-session-1',
      returnTo: '/documents?page=2'
    })
  })

  it('is accepted when the assertion is encrypted to the SP', async () => {
    const { id } = await startLogin()
    const identity = await sp.consume({
      SAMLResponse: await idp.response({ inResponseTo: id, encryptTo: spKeys.certificate })
    })
    expect(identity.tuId).toBe('us01user')
  })
})

describe('SAML: rejected responses', () => {
  it('signature by another key', async () => {
    const { id } = await startLogin()
    await rejects(sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, signWith: attacker }) }), /library/)
  })

  it('no signature at all', async () => {
    const { id } = await startLogin()
    await rejects(sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, signWith: null }) }), /library/)
  })

  it('a certificate embedded in the response is never trusted', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, signWith: attacker, embedCertificate: true }) }),
      /library/
    )
  })

  it('signature wrapping: an unsigned assertion next to a signed one', async () => {
    const { id } = await startLogin()
    const outcome = await sp
      .consume({ SAMLResponse: await idp.response({ inResponseTo: id, wrapWith: { cn: 'evil0001' } }) })
      .then(
        (identity) => identity.tuId,
        (e: unknown) => e
      )
    // Rejected outright; in no case may the unsigned assertion's identity win.
    expect(outcome).toBeInstanceOf(SamlRejected)
  })

  it('Issuer of another IdP', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, issuer: 'https://evil.test/idp' }) }),
      /issuer/
    )
  })

  it('Audience of another SP', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, audience: 'https://other.test/sp' }) }),
      /library/
    )
  })

  it('Destination of another ACS', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, destination: 'https://other.test/acs' }) }),
      /destination/
    )
  })

  it('Recipient of another ACS', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, recipient: 'https://other.test/acs' }) }),
      /recipient/
    )
  })

  it('NotOnOrAfter in the past, beyond clock skew', async () => {
    const { id } = await startLogin()
    const past = new Date(Date.now() - 10 * 60_000)
    await rejects(
      sp.consume({
        SAMLResponse: await idp.response({ inResponseTo: id, notBefore: new Date(past.getTime() - 60_000), notOnOrAfter: past })
      }),
      /library/
    )
  })

  it('NotBefore in the future, beyond clock skew', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({
        SAMLResponse: await idp.response({
          inResponseTo: id,
          notBefore: new Date(Date.now() + 10 * 60_000),
          notOnOrAfter: new Date(Date.now() + 20 * 60_000)
        })
      }),
      /library/
    )
  })

  it('InResponseTo of a request this SP never issued', async () => {
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: '_never-issued' }) }),
      /InResponseTo unknown/
    )
  })

  it('no InResponseTo at all (unsolicited)', async () => {
    await rejects(sp.consume({ SAMLResponse: await idp.response({ inResponseTo: null }) }), /unsolicited/)
  })

  it('a second response to an already answered request', async () => {
    const { id } = await startLogin()
    await sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id }) })
    await rejects(sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id }) }), /InResponseTo unknown/)
  })

  it('a replayed assertion ID, even for a fresh request', async () => {
    const first = await startLogin()
    await sp.consume({ SAMLResponse: await idp.response({ inResponseTo: first.id, assertionId: '_replayed' }) })
    const second = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: second.id, assertionId: '_replayed' }) }),
      /replayed/
    )
  })

  it('a replay does not burn the request it was aimed at', async () => {
    const first = await startLogin()
    await sp.consume({ SAMLResponse: await idp.response({ inResponseTo: first.id, assertionId: '_twice' }) })
    const second = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: second.id, assertionId: '_twice' }) }),
      /replayed/
    )
    // The transaction rolled back, so the genuine answer still works.
    await expect(sp.consume({ SAMLResponse: await idp.response({ inResponseTo: second.id }) })).resolves.toBeTruthy()
  })

  it('an assertion without cn', async () => {
    const { id } = await startLogin()
    await rejects(
      sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id, attributes: { mail: 'x@example.org' } }) }),
      /no cn/
    )
  })
})

describe('SAML: return path', () => {
  it.each([
    ['https://evil.test/', '/'],
    ['//evil.test/', '/'],
    ['/\\evil.test', '/'],
    ['javascript:alert(1)', '/'],
    [['/a', '/b'], '/'],
    ['/documents/1', '/documents/1']
  ])('returnTo %j lands on %s', async (returnTo, expected) => {
    const { id } = await startLogin(returnTo)
    const identity = await sp.consume({ SAMLResponse: await idp.response({ inResponseTo: id }) })
    expect(identity.returnTo).toBe(expected)
  })
})
