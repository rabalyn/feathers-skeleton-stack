import { getServiceOptions } from '@feathersjs/feathers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createTestApp } from '../support/app.js'

// ADR 0006: `patch` is the only way to change a record. No registered
// service may offer `update` to REST or WebSocket clients, which Feathers
// decides from each service's external method list.

let app: Application

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.teardown()
})

describe('external service methods', () => {
  it('no registered service exposes update', () => {
    const paths = Object.keys(app.services)
    // The walk covers the application's services, not an empty registry.
    expect(paths).toEqual(expect.arrayContaining(['users', 'documents', 'settings']))

    const exposingUpdate = paths.filter((path) => getServiceOptions(app.service(path as never))?.methods?.includes('update'))
    expect(exposingUpdate).toEqual([])
  })
})
