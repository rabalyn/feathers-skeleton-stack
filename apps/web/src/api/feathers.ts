import { createClient, SOCKET_PATH, type ClientApplication } from '@app/api/client'
import { createPiniaClient } from '@app/feathers-pinia'
import { AuthenticationClient } from '@feathersjs/authentication-client'
import socketio from '@feathersjs/socketio-client'
import type { Pinia } from 'pinia'
import { io } from 'socket.io-client'

// The one connection to the API: a WebSocket through Nginx on the
// application's own origin (ADR 0012, 0016).
export const socket = io({ path: SOCKET_PATH, transports: ['websocket'] })

// The library re-authenticates a reconnected socket with the stored token
// by itself, and leaves the failure unhandled once that token has expired.
// The session store does it instead, refreshing first where needed.
class SessionAuthenticationClient extends AuthenticationClient {
  override handleSocket(): void {}
}

export const client: ClientApplication = createClient(socketio(socket), { Authentication: SessionAuthenticationClient })

// Service stores (ADR 0014). Nothing is persisted to browser storage: the
// data is personal, and a shared computer must not keep it.
export const createApi = (pinia: Pinia) =>
  createPiniaClient(client, {
    pinia,
    idField: 'id',
    ssr: false,
    services: {
      settings: { idField: 'key' }
    }
  })

export type Api = ReturnType<typeof createApi>
