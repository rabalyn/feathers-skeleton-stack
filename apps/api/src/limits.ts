// Input limits the browser shows before the server enforces them (ADR 0007).
// Browser-safe: imports nothing.

// Directory lookup (ADR 0008). Two characters, because historical TU-IDs
// have two.
export const DIRECTORY_MIN_TERM_LENGTH = 2
export const DIRECTORY_MAX_TERM_LENGTH = 64
// The most entries one search returns; the directory stops there.
export const DIRECTORY_MAX_RESULTS = 50
