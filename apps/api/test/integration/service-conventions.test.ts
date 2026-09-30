import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createTestApp } from '../support/app.js'

// ADR 0030: what a generated service starts with holds for every registered
// service, generated or not. Every service names its publisher (ADR 0012):
// Feathers sends a service without one nothing, which is safe, but whether a
// service's events go out has to be decided where the service is written,
// not left to an application-wide default someone may add later. A service
// whose results go to the caller only says so with `publishNothing`.

// Where @feathersjs/transport-commons keeps a service's publishers.
const PUBLISHERS = Symbol.for('@feathersjs/transport-commons/publishers')

let app: Application

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.teardown()
})

describe('every registered service', () => {
  it('names its publisher', () => {
    const paths = Object.keys(app.services)
    // The walk covers the application's services, not an empty registry.
    expect(paths).toEqual(expect.arrayContaining(['authentication', 'users', 'documents', 'erasures']))

    const withoutPublisher = paths.filter((path) => {
      const publishers = (app.service(path as never) as Record<symbol, Record<string | symbol, unknown> | undefined>)[PUBLISHERS]
      return !publishers || Reflect.ownKeys(publishers).length === 0
    })
    expect(withoutPublisher).toEqual([])
  })
})
