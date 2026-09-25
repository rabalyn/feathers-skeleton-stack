// Public paths shared by the server and the browser client (ADR 0007, 0016).
// Browser-safe: imports nothing.

// Everything public lives under this prefix; Nginx routes it to the api.
export const API_PREFIX = '/api'
export const SOCKET_PATH = `${API_PREFIX}/socket.io`
// The authentication service over REST: refresh and logout carry the
// HttpOnly cookie, which is scoped to exactly this path (ADR 0010).
export const AUTHENTICATION_URL = `${API_PREFIX}/authentication`
export const SAML_LOGIN_URL = `${API_PREFIX}/auth/saml/login`
