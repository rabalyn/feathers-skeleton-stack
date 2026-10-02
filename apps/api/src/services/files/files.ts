import type { Readable } from 'node:stream'
import { BadRequest, MethodNotAllowed, NotFound } from '@feathersjs/errors'
import type { NextFunction, Params } from '@feathersjs/feathers'
import type { Middleware } from '@feathersjs/koa'
import { KnexService } from '@feathersjs/knex'
import type { Knex } from 'knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { subject } from '@casl/ability'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { limitPerUser } from '../../rate-limit.js'
import type { HookContext } from '../../declarations.js'
import {
  FILENAME_HEADER,
  fileDataValidator,
  fileExternalResolver,
  fileQueryValidator,
  fileResolver,
  type File,
  type FileData,
  type FileQuery
} from './files.schema.js'
import { receive, type Upload } from './upload.js'

// Uploads (ADR 0020). `files` stores an upload and describes it; the bytes
// come back through `file-contents`. The browser never talks to the object
// store: both go through these authorized service calls.

export const FILES_PATH = 'files'
export const FILE_CONTENTS_PATH = 'file-contents'
// Uploads arrive over HTTP only (the body is the file); over a socket, the
// metadata can be read.
export const FILE_EXTERNAL_METHODS = ['get', 'create'] as const

export interface FileParams extends Params<FileQuery> {
  upload?: Upload
}

export class FileService extends KnexService<File, FileData, FileParams> {
  constructor(
    options: ConstructorParameters<typeof KnexService<File, FileData, FileParams>>[0],
    private readonly app: Application
  ) {
    super(options)
  }

  override async create(data: FileData, params?: FileParams): Promise<File>
  override async create(data: FileData[], params?: FileParams): Promise<File[]>
  override async create(data: FileData | FileData[], params?: FileParams): Promise<File | File[]> {
    if (Array.isArray(data)) throw new BadRequest('One file per request')
    const user = params?.user as { id: string } | undefined
    if (!params?.upload || !user) throw new BadRequest('A file is uploaded over HTTP, as the request body')
    const { id } = await receive({
      knex: this.app.get('knex'),
      settings: this.app.get('settings'),
      storage: this.app.get('storage'),
      ownerId: user.id,
      filename: data.filename,
      upload: params.upload
    })
    return this._get(id)
  }
}

// Soft-deleted files and unfinished uploads do not exist for callers.
const onlyStored = async (context: HookContext<FileService>) => {
  context.params.query = { ...context.params.query, state: 'stored', deletedAt: null } as FileQuery
}

// The raw body goes to the service as a stream; the filename arrives
// percent-encoded in its header, so any Unicode name survives.
const takeUpload: Middleware = async (ctx, next) => {
  if (ctx.method === 'POST') {
    let filename: string
    try {
      filename = decodeURIComponent(ctx.get(FILENAME_HEADER))
    } catch {
      throw new BadRequest(`${FILENAME_HEADER} is not percent-encoded`)
    }
    ctx.request.body = { filename }
    const length = ctx.get('content-length')
    ctx.feathers = {
      ...ctx.feathers,
      upload: {
        stream: ctx.req,
        contentType: ctx.get('content-type') || undefined,
        contentLength: /^\d+$/.test(length) ? Number(length) : undefined
      } satisfies Upload
    } as typeof ctx.feathers
  }
  await next()
}

// RFC 6266: an ASCII fallback, and the real name percent-encoded.
export const contentDisposition = (kind: 'inline' | 'attachment', filename: string) => {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export interface FileContent {
  file: File
  body: Readable
  inline: boolean
}

type Ability = { can(action: string, subject: unknown): boolean }

// Whether the caller may read a file's bytes (ADR 0020): their own file
// (`files.own`), or the file of a record they may read, which is what a
// reference is for: the avatar of a user, the file of a document. Each is
// checked on the record itself, so it is exactly the caller's rule over that
// record, in a view-as the intersected one (ADR 0028). Nobody reads a file
// because they know its id.
const mayRead = async (knex: Knex, ability: Ability | undefined, file: File, avatarOf: object | undefined) => {
  if (!ability) return false
  if (ability.can('read', subject(FILES_PATH, { ...file }))) return true
  if (avatarOf && ability.can('read', subject('users', { ...avatarOf }))) return true
  const document = await knex('documents').where({ fileId: file.id }).first<object | undefined>()
  return Boolean(document && ability.can('read', subject('documents', { ...document })))
}

// get(id) streams the object to whoever may read it (mayRead); to anybody
// else it is a 404, worded like a file that does not exist, so the answer
// tells nothing about which ids exist (ADR 0011).
export class FileContentService {
  constructor(private readonly app: Application) {}

  async get(id: string, params?: Params): Promise<FileContent> {
    const knex = this.app.get('knex')
    const files = this.app.service(FILES_PATH)
    const file = await files
      ._get(id, { query: { state: 'stored', deletedAt: null } as FileQuery })
      .catch(() => undefined)
    // Only a current avatar is shown inline, and only a verified raster
    // image can be one (ADR 0020).
    const avatarOf = file ? await knex('users').where({ avatarFileId: id }).first<object | undefined>() : undefined
    const ability = params?.ability as Ability | undefined
    if (!file || (params?.provider && !(await mayRead(knex, ability, file, avatarOf)))) {
      throw new NotFound(`No record found for id '${id}'`)
    }
    const stored = await this.app.get('storage').get(id)
    if (!stored) {
      this.app.get('logger').error({ fileId: id }, 'object missing for a stored file')
      throw new NotFound(`No record found for id '${id}'`)
    }
    return { file: await fileResolver.resolve(file, {} as HookContext), body: stored.body, inline: Boolean(avatarOf) }
  }
}

// An avatar, shown inline, goes out under a name of the server's choosing
// with the extension of its verified type, so saving it never yields a file
// a desktop would open as something else (decided 2026-10-02, ADR 0020).
const AVATAR_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const avatarFilename = (contentType: string) => `avatar.${AVATAR_EXTENSIONS[contentType] ?? 'bin'}`

// Bytes are only ever sent over HTTP, with headers that keep a browser from
// running them: nosniff, the verified type, attachment unless an avatar, and
// a CSP that allows nothing should one be opened directly.
const sendContent = async (context: HookContext<FileContentService>, next: NextFunction) => {
  if (context.params.provider && context.params.provider !== 'rest') {
    throw new MethodNotAllowed('File contents are served over HTTP only')
  }
  await next()
  const { file, body, inline } = context.result as FileContent
  context.http = {
    ...context.http,
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.sizeBytes),
      'content-disposition': inline
        ? contentDisposition('inline', avatarFilename(file.contentType))
        : contentDisposition('attachment', file.filename),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store'
    }
  }
  context.result = body as unknown as FileContent
}

export const files = (app: Application) => {
  app.use(
    FILES_PATH,
    new FileService({ Model: app.get('knex'), name: 'files', id: 'id' }, app),
    { methods: [...FILE_EXTERNAL_METHODS], koa: { before: [takeUpload] } }
  )
  app.service(FILES_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(fileExternalResolver), schemaHooks.resolveResult(fileResolver)],
      // Storing an upload is costly (ADR 0010).
      create: [limitPerUser('uploads')]
    },
    before: {
      get: [schemaHooks.validateQuery(fileQueryValidator), onlyStored],
      create: [schemaHooks.validateData(fileDataValidator)]
    }
  })
  // An upload concerns the uploader, who has the result; what attaches the
  // file publishes itself.
  app.service(FILES_PATH).publish(publishNothing)

  app.use(FILE_CONTENTS_PATH, new FileContentService(app), { methods: ['get'] })
  app.service(FILE_CONTENTS_PATH).hooks({ around: { get: [sendContent] } })
  // Read only.
  app.service(FILE_CONTENTS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [FILES_PATH]: FileService
    [FILE_CONTENTS_PATH]: FileContentService
  }
}
