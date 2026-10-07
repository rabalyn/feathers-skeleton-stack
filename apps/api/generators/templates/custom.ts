import type { Names } from '../names.js'

// A service without a table of its own (ADR 0030): an action the caller asks
// for with `create`, like `erasures` or `view-as`. Its result goes to the
// caller only.

export const customService = (n: Names) => `import type { Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { dataValidator, lazyValidator } from '../../validators.js'

// ${n.title}: an action, asked for with \`create\`. Who may ask is
// \`${n.permission}\` in abilities.ts (ADR 0011).

export const ${n.pathConst} = '${n.path}'
export const ${n.methodsConst} = ['create'] as const

export const ${n.camel}DataSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }) },
  { $id: '${n.pascal}Data', additionalProperties: false }
)
export type ${n.pascal}Data = Static<typeof ${n.camel}DataSchema>
export const ${n.camel}DataValidator = lazyValidator(${n.camel}DataSchema, dataValidator)

export interface ${n.pascal} {
  name: string
  doneAt: string
}

export class ${n.pascal}Service {
  constructor(private readonly app: Application) {}

  async create(data: ${n.pascal}Data, _params?: Params): Promise<${n.pascal}> {
    this.app.get('logger').debug({ path: ${n.pathConst} }, '${n.words} asked for')
    return { name: data.name, doneAt: new Date().toISOString() }
  }
}

export const ${n.configure} = (app: Application) => {
  app.use(${n.pathConst}, new ${n.pascal}Service(app), { methods: [...${n.methodsConst}] })
  app.service(${n.pathConst}).hooks({
    before: { create: [schemaHooks.validateData(${n.camel}DataValidator)] }
  })
  // The result goes to the caller only (ADR 0012).
  app.service(${n.pathConst}).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [${n.pathConst}]: ${n.pascal}Service
  }
}
`

export const customTest = (n: Names) => `import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// The \`${n.path}\` service as generated (ADR 0030): \`${n.permission}\`
// lets one ask for it, and nobody else may. Extend this with the service.

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
  it('does it for whoever holds ${n.permission}', async () => {
    await expect(app.service('${n.path}').create({ name: 'First' }, as(admin))).resolves.toMatchObject({ name: 'First' })
  })

  it('refuses whoever lacks the permission (ADR 0011)', async () => {
    await expect(app.service('${n.path}').create({ name: 'First' }, as(member))).rejects.toMatchObject({ code: 403 })
  })

  it('rejects fields the schema does not declare (ADR 0005)', async () => {
    await expect(app.service('${n.path}').create({ name: 'First', unexpected: true } as never, as(admin))).rejects.toMatchObject({ code: 400 })
  })
})
`
