// Input limits the browser shows before the server enforces them (ADR 0007).
// Browser-safe: imports nothing.

// Directory lookup (ADR 0008). Two characters, because historical TU-IDs
// have two.
export const DIRECTORY_MIN_TERM_LENGTH = 2
export const DIRECTORY_MAX_TERM_LENGTH = 64
// The most entries one search returns: the university directory's own size
// limit. A page of them holds at most DIRECTORY_PAGE_MAX.
export const DIRECTORY_MAX_RESULTS = 100
export const DIRECTORY_PAGE_MAX = 50

// The site lookup (ADR 0031): the longest search term and the largest page.
export const SITE_SEARCH_MAX_LENGTH = 100
export const SITE_PAGE_MAX = 50
