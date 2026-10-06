import type { FileReference } from '../services/files/attachments.js'

// The product's records that attach files (ADR 0020, 0035): whoever may read
// such a record may read the bytes of its file. A service attaches and
// releases a file with attachFile() and releaseFile() from
// ../services/files/attachments.js, as documents does.
export const PRODUCT_FILE_REFERENCES: readonly FileReference[] = []
