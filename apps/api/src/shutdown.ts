import type { Server } from 'node:http'
import type { Socket } from 'node:net'

// Shutdown on SIGTERM (ADR 0006, 0024): work in progress gets this long to
// finish, then what is left is cut off. Podman sends SIGKILL after 10 s.
export const SHUTDOWN_GRACE_MS = 5000

// Every socket a server accepted, upgraded ones included: `server.close()`
// waits for those too, but `closeAllConnections()` does not reach them.
// Returns a function destroying the ones still open.
export const trackConnections = (server: Server): (() => void) => {
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return () => {
    for (const socket of sockets) socket.destroy()
  }
}

// Runs `work`, giving up waiting after `ms`. `onTimeout` runs when the
// deadline passes first.
export const withDeadline = async <T>(work: Promise<T>, ms: number, onTimeout: () => void = () => {}): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve(undefined)
    }, ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Stops accepting, closes idle keep-alive connections at once, and lets
// requests in flight finish within `graceMs` before cutting them off with
// `destroy`, by default every HTTP connection (not upgraded ones).
export const closeServer = async (
  server: Server,
  { graceMs = SHUTDOWN_GRACE_MS, destroy = () => server.closeAllConnections() } = {}
): Promise<void> => {
  if (!server.listening) return
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeIdleConnections()
  await withDeadline(closed, graceMs, destroy)
  await closed
}
