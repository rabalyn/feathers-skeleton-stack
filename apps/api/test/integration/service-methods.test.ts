import { MethodNotAllowed } from '@feathersjs/errors'
import { getServiceOptions } from '@feathersjs/feathers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createTestApp } from '../support/app.js'

// ADR 0006: `patch` is the only way to change a record. No registered
// service may offer `update` to REST or WebSocket clients, which Feathers
// decides from each service's external method list, and an app-wide hook
// rejects it for server code as well.

let app: Application

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.teardown()
})

describe('update', () => {
  it('no registered service exposes update', () => {
    const paths = Object.keys(app.services)
    // The walk covers the application's services, not an empty registry.
    expect(paths).toEqual(expect.arrayContaining(['users', 'documents', 'settings']))

    const exposingUpdate = paths.filter((path) => getServiceOptions(app.service(path as never))?.methods?.includes('update'))
    expect(exposingUpdate).toEqual([])
  })

  it('server code cannot call update on any service that implements it', async () => {
    const paths = Object.keys(app.services).filter(
      (path) => typeof (app.service(path as never) as { update?: unknown }).update === 'function'
    )
    // The Knex-backed services inherit `update` from their base class.
    expect(paths).toEqual(expect.arrayContaining(['users', 'documents']))

    for (const path of paths) {
      const service = app.service(path as never) as { update: (id: string, data: object) => Promise<unknown> }
      await expect(service.update('00000000-0000-0000-0000-000000000000', {}), path).rejects.toBeInstanceOf(MethodNotAllowed)
    }
  })
})
