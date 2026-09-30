// Public paths shared by the server and the browser client (ADR 0007, 0016).
// Browser-safe: imports nothing.

// Everything public lives under this prefix; Nginx routes it to the api.
export const API_PREFIX = '/api'
export const SOCKET_PATH = `${API_PREFIX}/socket.io`
// The authentication service over REST: refresh and logout carry the
// HttpOnly cookie, which is scoped to exactly this path (ADR 0010).
export const AUTHENTICATION_URL = `${API_PREFIX}/authentication`
export const SAML_LOGIN_URL = `${API_PREFIX}/auth/saml/login`
// Whether maintenance mode is on, for anyone: `{ active: boolean }`. The
// browser's maintenance page polls it (ADR 0025).
export const MAINTENANCE_URL = `${API_PREFIX}/maintenance`
// The web app's maintenance page, where the ACS sends a refused login.
export const MAINTENANCE_PAGE = '/maintenance'
// Uploads over plain HTTP, since the body is the file (ADR 0020): POST a
// file to FILES_URL; GET its bytes at FILE_CONTENTS_URL/<id>.
export const FILES_URL = `${API_PREFIX}/files`
export const FILE_CONTENTS_URL = `${API_PREFIX}/file-contents`
// A ready GDPR export, as a ZIP, at DATA_EXPORT_CONTENTS_URL/<id> (ADR 0013).
export const DATA_EXPORT_CONTENTS_URL = `${API_PREFIX}/data-export-contents`
