import { BadRequest, Forbidden, MethodNotAllowed } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService, type KnexAdapterOptions } from '@feathersjs/knex'
import type { Id, NullableId, Params } from '@feathersjs/feathers'
import { isPermissionKey, isTokenPermission } from '../../abilities.js'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { generateApiToken } from '../../auth/api-tokens.js'
import { publishTo, subjectChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { loadPermissions } from '../../permissions.js'
import {
  API_TOKENS_PATH,
  apiTokenDataValidator,
  apiTokenQueryValidator,
  apiTokenResolver,
  type ApiToken,
  type ApiTokenData,
  type ApiTokenQuery
} from './api-tokens.schema.js'

// API tokens (ADR 0029). Whoever holds `api-tokens.create` makes tokens of
// their own, carrying permissions they hold themselves; everybody sees and
// revokes their own, `api-tokens.manage` everybody's. The token is in the
// result of `create` and nowhere else: not in any event, not in the
// database. Revoking deletes the row; the audit event remains.

export { API_TOKENS_PATH } from './api-tokens.schema.js'
export const API_TOKEN_EXTERNAL_METHODS = ['find', 'get', 'create', 'remove'] as const

export type ApiTokenParams = Params<ApiTokenQuery>

// Never the hash (ADR 0005).
const COLUMNS = ['id', 'userId', 'name', 'permissions', 'hint', 'createdAt', 'expiresAt', 'lastUsedAt']

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null))

export class ApiTokenService extends KnexService<ApiToken, ApiTokenData, ApiTokenParams> {
  async create(data: ApiTokenData, params?: ApiTokenParams): Promise<ApiToken>
  async create(data: ApiTokenData[], params?: ApiTokenParams): Promise<ApiToken[]>
  async create(data: ApiTokenData | ApiTokenData[], params?: ApiTokenParams): Promise<ApiToken | ApiToken[]> {
    if (Array.isArray(data)) throw new MethodNotAllowed('API tokens are created one at a time')
    const owner = params?.user?.id
    if (!owner) throw new Forbidden('An API token belongs to a person')

    const unknown = data.permissions.filter((key) => !isPermissionKey(key))
    if (unknown.length) {
      throw new BadRequest('Unknown permission', { errors: unknown.map((key) => ({ key, message: 'not in the catalogue' })) })
    }
    const excluded = data.permissions.filter((key) => !isTokenPermission(key))
    if (excluded.length) {
      throw new BadRequest('Not grantable to an API token', { errors: excluded.map((key) => ({ key, message: 'not for tokens' })) })
    }
    // Nobody hands a token more than they hold (ADR 0029).
    const held = await loadPermissions(this.Model, owner)
    const missing = data.permissions.filter((key) => !held.includes(key))
    if (missing.length) throw new Forbidden('Permission not held', { errors: missing.map((key) => ({ key, message: 'not held' })) })
    if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now()) {
      throw new BadRequest('Invalid data', { errors: [{ key: 'expiresAt', message: 'must lie in the future' }] })
    }

    const { token, hash, hint } = generateApiToken()
    const id = await this.Model.transaction(async (trx) => {
      const [created]: { id: string }[] = await trx('apiTokens')
        .insert({ userId: owner, name: data.name, tokenHash: hash, hint, permissions: data.permissions, expiresAt: data.expiresAt ?? null })
        .returning(['id'])
      if (!created) throw new Error('api token insert returned nothing')
      await recordAudit(trx, {
        actorId: owner,
        action: 'api-tokens.create',
        resourceType: API_TOKENS_PATH,
        resourceId: created.id,
        detail: { name: data.name, permissions: data.permissions, expiresAt: data.expiresAt ?? null }
      })
      return created.id
    })
    return { ...(await this._get(id, { query: { $select: COLUMNS } } as ApiTokenParams)), token }
  }

  // Revocation, one token at a time.
  async _remove(id: null, params?: ApiTokenParams): Promise<ApiToken[]>
  async _remove(id: Id, params?: ApiTokenParams): Promise<ApiToken>
  async _remove(id: NullableId, params?: ApiTokenParams): Promise<ApiToken | ApiToken[]> {
    if (id === null) throw new MethodNotAllowed('API tokens are revoked one at a time')
    const existing = await this._get(id, params)
    await this.Model.transaction(async (trx) => {
      await trx('apiTokens').where({ id: existing.id }).delete()
      await recordAudit(trx, {
        actorId: params?.user?.id ?? null,
        action: 'api-tokens.revoke',
        resourceType: API_TOKENS_PATH,
        resourceId: existing.id,
        detail: { userId: existing.userId, name: existing.name }
      })
    })
    return existing
  }
}

// Never more than the columns above, whatever the caller asks for.
const columnsOnly = async (context: HookContext<ApiTokenService>) => {
  context.params.query = { ...context.params.query, $select: COLUMNS } as ApiTokenQuery
}

const newestFirst = async (context: HookContext<ApiTokenService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { createdAt: -1, id: -1 } }
}

// The created token goes to its creator in the response only. The event
// carries the record without it (ADR 0012, 0029).
const publishWithoutToken = async (context: HookContext<ApiTokenService>) => {
  context.event = null
  const { token: _token, ...created } = context.result as ApiToken
  const record: ApiToken = {
    ...created,
    createdAt: toIso(created.createdAt) as string,
    expiresAt: toIso(created.expiresAt),
    lastUsedAt: toIso(created.lastUsedAt)
  }
  const service = context.app.service(API_TOKENS_PATH)
  service.emit('created', record, { app: context.app, service, path: API_TOKENS_PATH, method: 'create', params: {}, result: record, dispatch: record })
}

export const apiTokens = (app: Application) => {
  const options = {
    Model: app.get('knex'),
    name: 'api_tokens',
    id: 'id',
    paginate: PAGINATE,
    // Every field: feathers-casl otherwise takes a rule without fields to
    // grant none.
    casl: { availableFields: [...COLUMNS, 'token'] }
  }
  app.use(API_TOKENS_PATH, new ApiTokenService(options as KnexAdapterOptions), { methods: [...API_TOKEN_EXTERNAL_METHODS] })

  app.service(API_TOKENS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveResult(apiTokenResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(apiTokenQueryValidator)],
      find: [columnsOnly, newestFirst],
      get: [columnsOnly],
      remove: [columnsOnly],
      create: [schemaHooks.validateData(apiTokenDataValidator)]
    },
    after: {
      create: [publishWithoutToken]
    }
  })

  // To the owner, and to whoever reads every token (ADR 0012).
  app
    .service(API_TOKENS_PATH)
    .publish(publishTo(app, (payload) => [userChannel(String(payload.userId)), subjectChannel(API_TOKENS_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [API_TOKENS_PATH]: ApiTokenService
  }
}
