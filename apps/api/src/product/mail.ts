import type { MailKind } from '../mail/kind.js'

// The product's mail kinds (ADR 0027, 0035), each declared with
// defineMailKind() in a module of its own and listed here; appended to the
// skeleton's in mail/registry.ts. A kind removed from here keeps its template
// revisions but can no longer be sent.
export const PRODUCT_MAIL_KINDS = [] as unknown as readonly MailKind[]
