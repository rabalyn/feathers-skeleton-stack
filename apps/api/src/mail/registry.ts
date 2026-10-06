import type { MailKind } from './kind.js'
import { exportReady } from './kinds/export-ready.js'
import { staleDocuments } from './kinds/stale-documents.js'
import { PRODUCT_MAIL_KINDS } from '../product/mail.js'

// The one registry of mail kinds (ADR 0027), like the settings registry
// (ADR 0025). The skeleton registers its own; a product adds its kinds in
// product/mail.ts (ADR 0035).
// A kind removed from here keeps its template revisions but can no longer be
// sent.

export const MAIL_KINDS: readonly MailKind[] = [
  ...([exportReady, staleDocuments] as unknown as readonly MailKind[]),
  ...PRODUCT_MAIL_KINDS
]

const byKey = new Map(MAIL_KINDS.map((kind) => [kind.key, kind]))
if (byKey.size !== MAIL_KINDS.length) throw new Error('mail kinds: duplicate key')

export const MAIL_KIND_KEYS = MAIL_KINDS.map((kind) => kind.key)

export const getMailKind = (key: string): MailKind | undefined => byKey.get(key)
