import { MAINTENANCE_URL } from '@app/api/client'

// Maintenance mode as the browser sees it (ADR 0025). Kept free of Vue and
// of the Feathers client so it can be tested on its own.

// How often the maintenance page asks whether the mode is over.
export const MAINTENANCE_POLL_MS = 30_000

// `unknown`: the API did not answer, or could not say. The API is expected
// to be down for part of a maintenance window, so this counts as one.
export type MaintenanceState = 'active' | 'inactive' | 'unknown'

export const fetchMaintenanceState = async (fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<MaintenanceState> => {
  try {
    const response = await fetcher(MAINTENANCE_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!response.ok) return 'unknown'
    const { active } = (await response.json()) as { active?: unknown }
    return active === true ? 'active' : active === false ? 'inactive' : 'unknown'
  } catch {
    return 'unknown'
  }
}

// A refusal because of maintenance: 503 with `data.maintenance`, as a
// Feathers error or as the JSON body of a REST answer.
export const isMaintenanceRefusal = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const { code, data } = error as { code?: unknown; data?: unknown }
  return code === 503 && !!data && typeof data === 'object' && (data as { maintenance?: unknown }).maintenance === true
}
