import type { Names } from '../names.js'

// A table-backed service (ADR 0030): KnexService, the four schemas of ADR
// 0005, events to whoever reads every record (ADR 0012).

export const knexSchema = (n: Names) => `import { resolve, virtual } from '@feathersjs/schema'
import { Type, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { dataValidator, queryValidator, lazyValidator } from '../../validators.js'

// ${n.title} (ADR 0005). Schemas and types may be imported by the
// client entry point as types only; resolvers below are server code.

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const ${n.camel}Schema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: '${n.pascal}', additionalProperties: false }
)
export type ${n.pascal} = Static<typeof ${n.camel}Schema>

export const ${n.camel}Resolver = resolve<${n.pascal}, HookContext>({
  createdAt: virtual(async (record) => toIso(record.createdAt)),
  updatedAt: virtual(async (record) => toIso(record.updatedAt))
})

// Strips what the caller must not see (ADR 0005); nothing yet.
export const ${n.camel}ExternalResolver = resolve<${n.pascal}, HookContext>({})

export const ${n.camel}DataSchema = Type.Pick(${n.camel}Schema, ['name'], {
  $id: '${n.pascal}Data',
  additionalProperties: false
})
export type ${n.pascal}Data = Static<typeof ${n.camel}DataSchema>
export const ${n.camel}DataValidator = lazyValidator(${n.camel}DataSchema, dataValidator)
// Server-controlled fields are set here, never taken from the request.
export const ${n.camel}DataResolver = resolve<${n.pascal}, HookContext>({})

export const ${n.camel}PatchSchema = Type.Partial(Type.Pick(${n.camel}Schema, ['name']), {
  $id: '${n.pascal}Patch',
  additionalProperties: false,
  minProperties: 1
})
export type ${n.pascal}Patch = Static<typeof ${n.camel}PatchSchema>
export const ${n.camel}PatchValidator = lazyValidator(${n.camel}PatchSchema, dataValidator)
export const ${n.camel}PatchResolver = resolve<${n.pascal}, HookContext>({
  updatedAt: async () => new Date().toISOString()
})

export const ${n.camel}QueryProperties = Type.Pick(${n.camel}Schema, ['id', 'name', 'createdAt', 'updatedAt'])
export const ${n.camel}QuerySchema = Type.Intersect(
  [querySyntax(${n.camel}QueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type ${n.pascal}Query = Static<typeof ${n.camel}QuerySchema>
export const ${n.camel}QueryValidator = lazyValidator(${n.camel}QuerySchema, queryValidator)
// Mandatory scoping the client cannot remove goes here (ADR 0005).
export const ${n.camel}QueryResolver = resolve<${n.pascal}Query, HookContext>({})
`

export const knexService = (n: Names) => `import type { Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { publishTo, subjectChannel } from '../../channels.js'
import { PAGINATE } from '../../paginate.js'
import {
  ${n.camel}DataResolver,
  ${n.camel}DataValidator,
  ${n.camel}ExternalResolver,
  ${n.camel}PatchResolver,
  ${n.camel}PatchValidator,
  ${n.camel}QueryResolver,
  ${n.camel}QueryValidator,
  ${n.camel}Resolver,
  type ${n.pascal},
  type ${n.pascal}Data,
  type ${n.pascal}Patch,
  type ${n.pascal}Query
} from './${n.path}.schema.js'

// ${n.title}. Who may do what is \`${n.permission}\` in
// abilities.ts (ADR 0011).

export type ${n.pascal}Params = Params<${n.pascal}Query>

export class ${n.pascal}Service extends KnexService<${n.pascal}, ${n.pascal}Data, ${n.pascal}Params, ${n.pascal}Patch> {}

export const ${n.pathConst} = '${n.path}'
export const ${n.methodsConst} = ['find', 'get', 'create', 'patch', 'remove'] as const

export const ${n.configure} = (app: Application) => {
  app.use(
    ${n.pathConst},
    new ${n.pascal}Service({ Model: app.get('knex'), name: '${n.table}', id: 'id', paginate: PAGINATE }),
    { methods: [...${n.methodsConst}] }
  )

  app.service(${n.pathConst}).hooks({
    around: {
      all: [schemaHooks.resolveExternal(${n.camel}ExternalResolver), schemaHooks.resolveResult(${n.camel}Resolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(${n.camel}QueryValidator), schemaHooks.resolveQuery(${n.camel}QueryResolver)],
      create: [schemaHooks.validateData(${n.camel}DataValidator), schemaHooks.resolveData(${n.camel}DataResolver)],
      patch: [schemaHooks.validateData(${n.camel}PatchValidator), schemaHooks.resolveData(${n.camel}PatchResolver)]
    }
  })

  // To whoever reads every record (ADR 0011, 0012).
  app.service(${n.pathConst}).publish(publishTo(app, () => [subjectChannel(${n.pathConst})]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [${n.pathConst}]: ${n.pascal}Service
  }
}
`

// Schema changes roll forward (ADR 0003); the API's role gets its rights
// from the default privileges (migration 20260925000000_privileges).
export const knexMigration = (n: Names, id: string) => `import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// ${n.title}, served by the \`${n.path}\` service.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(\`
    CREATE TABLE ${n.table} (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  \`)
}

export const down = irreversible('${id}_${n.table}')
`

export const knexTest = (n: Names) => `import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// The \`${n.path}\` service as generated (ADR 0030): \`${n.permission}\`
// grants everything, and nobody else gets anything. Extend this with the
// service.

let app: Application
let admin: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'ad01admn', 'admin')
  // Everything but the service's permission, through a role of the test's
  // own (ADR 0035).
  member = await makeUser(app, 'us01user', allBut('${n.permission}'))
})

afterAll(async () => {
  await app.teardown()
})

describe('${n.path}', () => {
  it('creates, reads, changes and removes under ${n.permission}', async () => {
    const service = app.service('${n.path}')
    const created = await service.create({ name: 'First' }, as(admin))
    expect(created).toMatchObject({ name: 'First' })
    await expect(service.find(as(admin))).resolves.toMatchObject({ total: 1 })
    expect(await service.patch(created.id, { name: 'Second' }, as(admin))).toMatchObject({ id: created.id, name: 'Second' })
    await service.remove(created.id, as(admin))
    await expect(service.get(created.id, as(admin))).rejects.toMatchObject({ code: 404 })
  })

  it('refuses whoever lacks the permission (ADR 0011)', async () => {
    await expect(app.service('${n.path}').find(as(member))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('${n.path}').create({ name: 'Mine' }, as(member))).rejects.toMatchObject({ code: 403 })
  })

  it('rejects fields the schemas do not declare (ADR 0005)', async () => {
    const service = app.service('${n.path}')
    await expect(service.create({ name: 'First', unexpected: true } as never, as(admin))).rejects.toMatchObject({ code: 400 })
    const created = await service.create({ name: 'First' }, as(admin))
    await expect(service.patch(created.id, { id: created.id } as never, as(admin))).rejects.toMatchObject({ code: 400 })
    await expect(service.patch(created.id, {}, as(admin))).rejects.toMatchObject({ code: 400 })
  })
})
`
