import { randomUUID } from 'node:crypto'
import { generate } from 'selfsigned'
import { SignedXml } from 'xml-crypto'
import xmlenc from 'xml-encryption'

// A test identity provider that builds SAML responses the way an IdP does,
// and lets a test break any one property ADR 0008 requires the SP to check.

export interface KeyPair {
  privateKey: string
  certificate: string
}

export const keyPair = async (commonName: string): Promise<KeyPair> => {
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keySize: 2048,
    algorithm: 'sha256'
  })
  return { privateKey: pems.private, certificate: pems.cert }
}

export const IDP_ENTITY_ID = 'https://idp.test/realms/test'
export const IDP_SSO_URL = 'https://idp.test/realms/test/protocol/saml'
export const PUBLIC_ORIGIN = 'https://app.test'
export const SP_ENTITY_ID = `${PUBLIC_ORIGIN}/api/auth/saml/metadata`
export const SP_ACS = `${PUBLIC_ORIGIN}/api/auth/saml/acs`

export interface ResponseOptions {
  inResponseTo?: string | null
  issuer?: string
  destination?: string
  recipient?: string
  audience?: string
  notBefore?: Date
  notOnOrAfter?: Date
  assertionId?: string
  attributes?: Record<string, string>
  nameId?: string
  sessionIndex?: string
  // How the assertion is (not) signed.
  signWith?: KeyPair | null
  // Put the signing certificate into KeyInfo, as an attacker would.
  embedCertificate?: boolean
  // Add an unsigned assertion before the signed one (signature wrapping).
  wrapWith?: Record<string, string>
  // Encrypt the signed assertion to this certificate.
  encryptTo?: string
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const assertionXml = (o: Required<Omit<ResponseOptions, 'signWith' | 'embedCertificate' | 'wrapWith' | 'encryptTo'>>) => {
  const now = new Date().toISOString()
  const attrs = Object.entries(o.attributes)
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
        `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escape(value)}</saml:AttributeValue>` +
        `</saml:Attribute>`
    )
    .join('')
  const irt = o.inResponseTo ? ` InResponseTo="${escape(o.inResponseTo)}"` : ''
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${escape(o.assertionId)}" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${escape(o.issuer)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escape(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${irt} NotOnOrAfter="${o.notOnOrAfter.toISOString()}" Recipient="${escape(o.recipient)}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${o.notBefore.toISOString()}" NotOnOrAfter="${o.notOnOrAfter.toISOString()}">` +
    `<saml:AudienceRestriction><saml:Audience>${escape(o.audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now}" SessionIndex="${escape(o.sessionIndex)}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  )
}

const sign = (xml: string, key: KeyPair, embedCertificate: boolean): string => {
  const sig = new SignedXml({
    privateKey: key.privateKey,
    ...(embedCertificate ? { publicCert: key.certificate } : {}),
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
  })
  if (!embedCertificate) sig.getKeyInfoContent = () => null
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
  })
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' }
  })
  return sig.getSignedXml()
}

const encrypt = (xml: string, certificate: string): Promise<string> =>
  new Promise((resolve, reject) =>
    xmlenc.encrypt(
      xml,
      {
        rsa_pub: certificate,
        pem: certificate,
        encryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
      },
      (err: Error | null, result: string) => (err ? reject(err) : resolve(result))
    )
  )

export class TestIdp {
  constructor(
    readonly key: KeyPair,
    readonly defaults: { attributes: Record<string, string> } = {
      attributes: { cn: 'us01user', givenName: 'Uma', sn: 'User', mail: 'uma.user@example.org' }
    }
  ) {}

  // A base64 SAMLResponse, as the browser POSTs it to the ACS.
  async response(options: ResponseOptions = {}): Promise<string> {
    const now = Date.now()
    const inResponseTo = options.inResponseTo === undefined ? null : options.inResponseTo
    const assertion = assertionXml({
      inResponseTo,
      issuer: options.issuer ?? IDP_ENTITY_ID,
      destination: options.destination ?? SP_ACS,
      recipient: options.recipient ?? SP_ACS,
      audience: options.audience ?? SP_ENTITY_ID,
      notBefore: options.notBefore ?? new Date(now - 30_000),
      notOnOrAfter: options.notOnOrAfter ?? new Date(now + 5 * 60_000),
      assertionId: options.assertionId ?? `_a${randomUUID()}`,
      attributes: options.attributes ?? this.defaults.attributes,
      nameId: options.nameId ?? 'persistent-name-id-1',
      sessionIndex: options.sessionIndex ?? 'idp-session-1'
    })

    const signWith = options.signWith === undefined ? this.key : options.signWith
    let body = signWith ? sign(assertion, signWith, options.embedCertificate ?? false) : assertion

    if (options.wrapWith) {
      const evil = assertionXml({
        inResponseTo,
        issuer: options.issuer ?? IDP_ENTITY_ID,
        destination: SP_ACS,
        recipient: SP_ACS,
        audience: SP_ENTITY_ID,
        notBefore: new Date(now - 30_000),
        notOnOrAfter: new Date(now + 5 * 60_000),
        assertionId: `_evil${randomUUID()}`,
        attributes: options.wrapWith,
        nameId: 'evil',
        sessionIndex: 'evil'
      })
      body = evil + body
    }

    if (options.encryptTo) {
      body = `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${await encrypt(body, options.encryptTo)}</saml:EncryptedAssertion>`
    }

    const destination = options.destination ?? SP_ACS
    const irt = inResponseTo ? ` InResponseTo="${escape(inResponseTo)}"` : ''
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
      ` ID="_r${randomUUID()}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${escape(destination)}"${irt}>` +
      `<saml:Issuer>${escape(options.issuer ?? IDP_ENTITY_ID)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      body +
      `</samlp:Response>`
    return Buffer.from(xml, 'utf8').toString('base64')
  }
}
