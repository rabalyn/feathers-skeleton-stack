// Scaffolds a Feathers service the way this repository writes them (ADR
// 0030). Run from the repository root:
//
//   pnpm gen:service --name widget-things [--type knex|custom] [--singular widget-thing]
//
//   knex    (default) a table-backed service: schemas, a KnexService, a
//           migration, events to whoever reads every record
//   custom  an action asked for with `create`, without a table
//
// Beside its own files it registers the service in services/index.ts, adds
// it to the client's types, adds a `<path>.manage` permission to the
// catalogue and labels that permission in every locale. Nothing is written
// unless all of that can be.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { before, inject, renderTemplate, toFile, type PinionContext } from '@featherscloud/pinion'
import { namesFor, type Names } from './names.js'
import { customService, customTest } from './templates/custom.js'
import { knexMigration, knexSchema, knexService, knexTest } from './templates/knex.js'
import {
  clientExport,
  clientImports,
  clientType,
  indexConfigure,
  indexImport,
  permissionEntry,
  translations,
  type ServiceType
} from './templates/registrations.js'

interface Context extends PinionContext {
  n: Names
  type: ServiceType
  migrationId: string
  // The singular was derived from the path, not given.
  guessed: boolean
}

const API = 'apps/api'
const SERVICES_INDEX = `${API}/src/services/index.ts`
const CLIENT = `${API}/src/client.ts`
const ABILITIES = `${API}/src/abilities.ts`
const MIGRATIONS = `${API}/src/migrations`
const LOCALES = ['en', 'de'] as const
const localeFile = (locale: string) => `apps/web/src/i18n/${locale}.json`

const marker = (slot: string) => `// gen:service ${slot} (ADR 0030)`
const SLOTS: [file: string, slot: string][] = [
  [SERVICES_INDEX, 'imports'],
  [SERVICES_INDEX, 'configure'],
  [CLIENT, 'imports'],
  [CLIENT, 'exports'],
  [CLIENT, 'client-types'],
  [ABILITIES, 'permissions']
]

interface Args {
  name: string
  type: ServiceType
  singular: string | undefined
  root: string | undefined
}

const parse = (argv: string[]): Args => {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      type: { type: 'string', default: 'knex' },
      singular: { type: 'string' },
      // The repository root; by default the one this package sits in.
      root: { type: 'string' }
    },
    strict: true
  })
  if (!values.name) throw new Error('Usage: pnpm gen:service --name <kebab-case-plural> [--type knex|custom] [--singular <name>]')
  const type = values.type
  if (type !== 'knex' && type !== 'custom') throw new Error(`--type is knex or custom, not '${type}'`)
  return { name: values.name, type, singular: values.singular, root: values.root }
}

// Migrations are named <date><sequence>_<table>: the next free sequence of
// today, after every existing migration.
const nextMigrationId = (root: string) => {
  const now = new Date()
  const today = Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}000000`
  )
  const latest = readdirSync(join(root, MIGRATIONS))
    .map((file) => /^(\d{14})_/.exec(file)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number)
    .reduce((max, id) => Math.max(max, id), 0)
  return String(latest >= today ? latest + 100 : today)
}

// Everything that would make the run stop half-way is checked first.
const preflight = (root: string, n: Names) => {
  const problems: string[] = []
  const read = (file: string) => readFileSync(join(root, file), 'utf8')
  if (existsSync(join(root, API, 'src/services', n.path))) problems.push(`src/services/${n.path} exists already`)
  if (existsSync(join(root, API, 'test/integration', `${n.path}.test.ts`))) problems.push(`test/integration/${n.path}.test.ts exists already`)
  for (const [file, slot] of SLOTS) {
    const count = read(file).split('\n').filter((line) => line.trim() === marker(slot)).length
    if (count !== 1) problems.push(`${file} needs exactly one line '${marker(slot)}', has ${count}`)
  }
  if (read(CLIENT).includes(`/services/${n.path}/`)) problems.push(`${CLIENT} already names ${n.path}`)
  if (read(ABILITIES).includes(`'${n.permission}'`)) problems.push(`${ABILITIES} already declares ${n.permission}`)
  if (read(SERVICES_INDEX).includes(`app.configure(${n.configure})`)) problems.push(`${SERVICES_INDEX} already configures ${n.configure}`)
  for (const locale of LOCALES) {
    const permissions = (JSON.parse(read(localeFile(locale))) as { permissions?: Record<string, Record<string, string>> }).permissions
    if (!permissions?.keys || !permissions.descriptions || !permissions.groups) problems.push(`${localeFile(locale)} has no permissions.keys/descriptions/groups`)
    else if (permissions.keys[n.permissionSlug]) problems.push(`${localeFile(locale)} already labels ${n.permission}`)
  }
  if (problems.length) throw new Error(`Nothing was written:\n  - ${problems.join('\n  - ')}`)
}

const at = (slot: string) => before<Context>(marker(slot))
const file = (path: string) => (ctx: Context) => join(ctx.cwd, path)

// The locale files are JSON, written as they are formatted in the
// repository: two spaces, a final newline. A group label that exists is
// kept.
const labelPermission = async (ctx: Context) => {
  const texts = translations(ctx.n, ctx.type)
  for (const locale of LOCALES) {
    const path = join(ctx.cwd, localeFile(locale))
    const messages = JSON.parse(readFileSync(path, 'utf8')) as { permissions: Record<string, Record<string, string>> }
    const { groups, keys, descriptions } = messages.permissions as Record<'groups' | 'keys' | 'descriptions', Record<string, string>>
    groups[ctx.n.path] ??= texts[locale].group
    keys[ctx.n.permissionSlug] = texts[locale].key
    descriptions[ctx.n.permissionSlug] = texts[locale].description
    writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`)
    ctx.pinion.logger.notice(`Updated ${relative(ctx.cwd, path)}`)
  }
  return ctx
}

const serviceFile = (suffix: string) => toFile<Context>(API, 'src/services', ({ n }) => n.path, ({ n }) => `${n.path}${suffix}.ts`)
const testFile = toFile<Context>(API, 'test/integration', ({ n }) => `${n.path}.test.ts`)

const writeKnex = (ctx: Context) =>
  Promise.resolve(ctx)
    .then(renderTemplate(({ n }) => knexSchema(n), serviceFile('.schema')))
    .then(renderTemplate(({ n }) => knexService(n), serviceFile('')))
    .then(renderTemplate(({ n, migrationId }) => knexMigration(n, migrationId), toFile<Context>(MIGRATIONS, ({ n, migrationId }) => `${migrationId}_${n.table}.ts`)))
    .then(renderTemplate(({ n }) => knexTest(n), testFile))

const writeCustom = (ctx: Context) =>
  Promise.resolve(ctx)
    .then(renderTemplate(({ n }) => customService(n), serviceFile('')))
    .then(renderTemplate(({ n }) => customTest(n), testFile))

const checklist = async (ctx: Context) => {
  const { n, type } = ctx
  ctx.pinion.logger.notice(
    [
      '',
      `Generated the ${type} service '${n.path}', record type ${n.pascal}. Next:`,
      ...(ctx.guessed ? [`  - ${n.pascal} is guessed from the path: if it is wrong, remove what was generated and pass --singular`] : []),
      `  - its fields: ${type === 'knex' ? 'the schemas, the migration and ' : 'the data schema, the result and '}the test`,
      `  - the wording of '${n.permission}' in ${LOCALES.map(localeFile).join(' and ')}`,
      `  - finer permissions than '${n.permission}', or granting it to a seeded role, if the product needs that (ADR 0011)`,
      ...(type === 'knex'
        ? ['  - a column referencing users(id) goes into src/gdpr/registry.ts and erase_user() (ADR 0013)']
        : []),
      `  - pnpm typecheck; scripts/stack.sh test test/integration/${n.path}.test.ts`
    ].join('\n')
  )
  return ctx
}

export const generate = async (init: PinionContext) => {
  const args = parse(init.argv)
  const root = resolve(args.root ?? resolve(init.cwd, '../..'))
  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) throw new Error(`${root} is not the repository root; pass --root`)
  const n = namesFor(args.name, args.singular)
  preflight(root, n)

  const ctx: Context = { ...init, cwd: root, n, type: args.type, migrationId: nextMigrationId(root), guessed: args.singular === undefined }
  // Every file was checked not to exist; nothing asks before writing.
  ctx.pinion.force = true
  return Promise.resolve(ctx)
    .then(args.type === 'knex' ? writeKnex : writeCustom)
    .then(inject(({ n }) => indexImport(n), at('imports'), file(SERVICES_INDEX)))
    .then(inject(({ n }) => indexConfigure(n), at('configure'), file(SERVICES_INDEX)))
    .then(inject(({ n, type }) => clientImports(n, type), at('imports'), file(CLIENT)))
    .then(inject(({ n, type }) => clientExport(n, type), at('exports'), file(CLIENT)))
    .then(inject(({ n, type }) => clientType(n, type), at('client-types'), file(CLIENT)))
    .then(inject(({ n, type }) => permissionEntry(n, type), at('permissions'), file(ABILITIES)))
    .then(labelPermission)
    .then(checklist)
}
