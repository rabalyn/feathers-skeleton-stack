import { randomUUID } from 'node:crypto'
import { SAML, ValidateInResponseTo, type Profile, type SamlConfig } from '@node-saml/node-saml'
import { DOMParser } from '@xmldom/xmldom'
import xpath from 'xpath'
import type { Knex } from 'knex'
import type { ApiConfig } from '../config.js'

// The SAML2 service provider (ADR 0008).
//
// @node-saml/node-saml verifies signatures against the configured IdP
// certificate only, decrypts, and checks timestamps and audience. It does not
// check the assertion's Issuer, Destination or Recipient, and it has no
// assertion replay cache; its InResponseTo check is not atomic. Those are done
// here, and every item of ADR 0008's list has a negative test.

export const ACCEPTED_CLOCK_SKEW_MS = 60_000
const REQUEST_TTL_MS = 10 * 60_000

export interface SamlUrls {
  entityId: string
  acs: string
  logout: string
}

export const samlUrls = (publicOrigin: string): SamlUrls => ({
  entityId: `${publicOrigin}/api/auth/saml/metadata`,
  acs: `${publicOrigin}/api/auth/saml/acs`,
  logout: `${publicOrigin}/api/auth/saml/logout`
})

export type SamlSettings = Pick<
  ApiConfig,
  | 'publicOrigin'
  | 'samlSpPrivateKey'
  | 'samlSpCertificate'
  | 'samlIdpCertificate'
  | 'samlIdpEntityId'
  | 'samlIdpSsoUrl'
  | 'samlIdpSloUrl'
>

export interface AssertedIdentity {
  tuId: string
  givenName: string | null
  surname: string | null
  email: string | null
  nameId: string
  nameIdFormat: string | null
  sessionIndex: string | null
  returnTo: string
}

export class SamlRejected extends Error {}

// ADR 0008: only a same-origin relative path; anything else becomes `/`.
export const safeReturnTo = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2048) return '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  // Control characters are exactly what this rejects.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(value)) return '/'
  return value
}

const attr = (profile: Profile, name: string): string | null => {
  const value: unknown = profile[name]
  const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  return typeof first === 'string' && first.length > 0 ? first : null
}

const select = (node: Node, expression: string): string | null => {
  const found = xpath.select(expression, node) as Attr[] | string
  if (typeof found === 'string') return found || null
  return found[0]?.value ?? found[0]?.nodeValue ?? null
}

export class ServiceProvider {
  readonly urls: SamlUrls

  constructor(
    private readonly settings: SamlSettings,
    private readonly knex: Knex
  ) {
    this.urls = samlUrls(settings.publicOrigin)
  }

  private saml(overrides: Partial<SamlConfig> = {}): SAML {
    return new SAML({
      entryPoint: this.settings.samlIdpSsoUrl,
      logoutUrl: this.settings.samlIdpSloUrl,
      issuer: this.urls.entityId,
      callbackUrl: this.urls.acs,
      logoutCallbackUrl: this.urls.logout,
      audience: this.urls.entityId,
      idpCert: this.settings.samlIdpCertificate,
      idpIssuer: this.settings.samlIdpEntityId,
      privateKey: this.settings.samlSpPrivateKey,
      publicCert: this.settings.samlSpCertificate,
      decryptionPvk: this.settings.samlSpPrivateKey,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      acceptedClockSkewMs: ACCEPTED_CLOCK_SKEW_MS,
      // The SP keys people by TU-ID (cn), never by NameID, so it leaves the
      // NameID format to the IdP. (The local Keycloak issues transient IDs:
      // a persistent one would be written to its read-only LDAP users.)
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      validateInResponseTo: ValidateInResponseTo.never,
      ...overrides
    })
  }

  metadata(): string {
    return this.saml().generateServiceProviderMetadata(this.settings.samlSpCertificate, this.settings.samlSpCertificate)
  }

  // Issues a signed AuthnRequest and remembers its ID, with the return path.
  async loginUrl(returnTo: unknown): Promise<string> {
    const id = `_${randomUUID()}`
    await this.knex('samlRequests').insert({
      id,
      returnTo: safeReturnTo(returnTo),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS)
    })
    return this.saml({ generateUniqueId: () => id }).getAuthorizeUrlAsync('', undefined, {})
  }

  // Validates a POSTed SAMLResponse completely. Throws SamlRejected with a
  // reason for logs; callers answer with a generic failure (ADR 0018).
  async consume(body: Record<string, string>): Promise<AssertedIdentity> {
    let profile: Profile | null
    try {
      ;({ profile } = await this.saml().validatePostResponseAsync(body))
    } catch (error) {
      throw new SamlRejected(`library validation failed: ${(error as Error).message}`)
    }
    if (!profile) throw new SamlRejected('no profile in response')

    const responseXml = profile.getSamlResponseXml?.()
    const assertionXml = profile.getAssertionXml?.()
    if (!responseXml || !assertionXml) throw new SamlRejected('response or assertion missing')
    const response = new DOMParser().parseFromString(responseXml, 'text/xml').documentElement as unknown as Node
    const assertion = new DOMParser().parseFromString(assertionXml, 'text/xml').documentElement as unknown as Node

    const issuer = select(assertion, "string(/*[local-name()='Assertion']/*[local-name()='Issuer'])")
    if (issuer !== this.settings.samlIdpEntityId) throw new SamlRejected(`unexpected issuer ${issuer}`)

    const destination = select(response, "/*[local-name()='Response']/@Destination")
    if (destination !== this.urls.acs) throw new SamlRejected(`unexpected destination ${destination}`)

    const recipients = (
      xpath.select(
        "/*[local-name()='Assertion']/*[local-name()='Subject']/*[local-name()='SubjectConfirmation']/*[local-name()='SubjectConfirmationData']/@Recipient",
        assertion
      ) as Attr[]
    ).map((a) => a.value)
    if (recipients.length === 0 || recipients.some((r) => r !== this.urls.acs)) {
      throw new SamlRejected(`unexpected recipient ${recipients.join(',')}`)
    }

    const inResponseTo = select(response, "/*[local-name()='Response']/@InResponseTo")
    if (!inResponseTo) throw new SamlRejected('unsolicited response')
    const confirmationInResponseTo = select(
      assertion,
      "/*[local-name()='Assertion']/*[local-name()='Subject']/*[local-name()='SubjectConfirmation']/*[local-name()='SubjectConfirmationData']/@InResponseTo"
    )
    if (confirmationInResponseTo && confirmationInResponseTo !== inResponseTo) {
      throw new SamlRejected('subject confirmation answers a different request')
    }

    const assertionId = select(assertion, "/*[local-name()='Assertion']/@ID")
    if (!assertionId) throw new SamlRejected('assertion without ID')
    const notOnOrAfter = select(assertion, "/*[local-name()='Assertion']/*[local-name()='Conditions']/@NotOnOrAfter")
    const replayUntil = new Date(
      Math.max(Date.parse(notOnOrAfter ?? '') || 0, Date.now() + REQUEST_TTL_MS) + ACCEPTED_CLOCK_SKEW_MS
    )

    const tuId = attr(profile, 'cn')
    if (!tuId) throw new SamlRejected('assertion carries no cn')

    // Consume the request and record the assertion in one transaction, so a
    // replay or a second answer to the same request cannot both succeed.
    const returnTo = await this.knex.transaction(async (trx) => {
      const [request]: { returnTo: string }[] = await trx('samlRequests')
        .where({ id: inResponseTo })
        .where('expiresAt', '>', trx.fn.now())
        .delete()
        .returning(['returnTo'])
      if (!request) throw new SamlRejected('InResponseTo unknown, expired or already used')

      const inserted = await trx('samlAssertions')
        .insert({ id: assertionId, expiresAt: replayUntil })
        .onConflict('id')
        .ignore()
        .returning(['id'])
      if (inserted.length === 0) throw new SamlRejected('assertion replayed')
      return safeReturnTo(request.returnTo)
    })

    return {
      tuId,
      givenName: attr(profile, 'givenName'),
      surname: attr(profile, 'sn'),
      email: attr(profile, 'mail'),
      nameId: profile.nameID,
      nameIdFormat: profile.nameIDFormat ?? null,
      sessionIndex: profile.sessionIndex ?? null,
      returnTo
    }
  }

  // SP-initiated logout: a signed LogoutRequest for the IdP session the login
  // came from (ADR 0008).
  async logoutUrl(session: { nameId: string; nameIdFormat: string | null; sessionIndex: string | null }) {
    return this.saml().getLogoutUrlAsync(
      {
        issuer: this.settings.samlIdpEntityId,
        nameID: session.nameId,
        nameIDFormat: session.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:unspecified',
        ...(session.sessionIndex ? { sessionIndex: session.sessionIndex } : {})
      },
      '',
      {}
    )
  }

  // The IdP's LogoutResponse, by redirect (query) or by POST (form).
  async validateLogoutResponse(
    message: { query: Record<string, string>; originalQuery: string } | { body: Record<string, string> }
  ): Promise<void> {
    try {
      if ('body' in message) {
        const { loggedOut } = await this.saml().validatePostResponseAsync(message.body)
        if (!loggedOut) throw new Error('not a logout response')
      } else {
        await this.saml().validateRedirectAsync(message.query, message.originalQuery)
      }
    } catch (error) {
      throw new SamlRejected(`logout response invalid: ${(error as Error).message}`)
    }
  }
}
