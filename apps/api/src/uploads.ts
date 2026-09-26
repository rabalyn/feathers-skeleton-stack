// Upload rules shared by the server and the browser client (ADR 0007, 0020).
// Browser-safe: imports nothing.

// The formats magic bytes can actually verify. Products extend the list
// here; a format whose bytes cannot be told apart from others (a ZIP-based
// office file, plain text) needs more than a signature check.
export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
// Served inline, as avatars. Never SVG (ADR 0018).
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number]

// A file is uploaded by POSTing its bytes as the body to FILES_URL (paths.ts),
// with its type as Content-Type and its original name, percent-encoded
// (encodeURIComponent), in this header.
export const FILENAME_HEADER = 'x-file-name'
