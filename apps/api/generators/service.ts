// Scaffolds a Feathers service the way this repository writes them (ADR
// 0030). Run from the repository root:
//
//   pnpm gen:service --name widget-things [--type knex|custom] [--singular widget-thing]
//
//   knex    (default) a table-backed service: schemas, a KnexService, a
//           migration, events to whoever reads every record
//   custom  an action asked for with `create`, without a table
//
// Beside its own files it registers the service, adds it to the client's
// types, adds a `<path>.manage` permission to the catalogue and labels that
// permission in every locale. Nothing is written unless all of that can be.
//
// Where it registers depends on product.env (ADR 0035): in the skeleton
// (PRODUCT=feathers-skeleton) in the skeleton's own files, services/index.ts,
// client.ts, abilities.ts and the web app's catalogues; in a product in the
// product module, src/product/ and the web app's i18n/product/.
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
  clientTypeImports,
  indexConfigure,
  indexImport,
  permissionEntry,
  translations,
  type ServiceType,
  type Target
} from './templates/registrations.js'

interface Context extends PinionContext {
  n: Names
  type: ServiceType
  target: Target
  files: Files
  migrationId: string
  // The singular was derived from the path, not given.
  guessed: boolean
}

const API = 'apps/api'
const MIGRATIONS = `${API}/src/migrations`
const LOCALES = ['en', 'de'] as const
const skeletonLocaleFile = (locale: string) => `apps/web/src/i18n/${locale}.json`

// The files a service is registered in.
interface Files {
  index: string
  client: string
  permissions: string
  locale: (locale: string) => string
  // Where personal data goes (ADR 0013).
  personalData: string
  eraseFunction: string
}

const FILES: Record<Target, Files> = {
  skeleton: {
    index: `${API}/src/services/index.ts`,
    client: `${API}/src/client.ts`,
    permissions: `${API}/src/abilities.ts`,
    locale: skeletonLocaleFile,
    personalData: 'src/gdpr/registry.ts',
    eraseFunction: 'erase_user()'
  },
  product: {
    index: `${API}/src/product/services.ts`,
    client: `${API}/src/product/client.ts`,
    permissions: `${API}/src/product/permissions.ts`,
    locale: (locale) => `apps/web/src/i18n/product/${locale}.json`,
    personalData: 'src/product/personal-data.ts',
    eraseFunction: 'erase_user_product()'
  }
}

// The skeleton's own name in product.env (ADR 0035); a product has its own.
const SKELETON_PRODUCT = 'feathers-skeleton'

const targetOf = (root: string): Target => {
  const path = join(root, 'product.env')
  if (!existsSync(path)) throw new Error(`${path} is missing: it names the product (ADR 0035)`)
  const product = /^PRODUCT=['"]?([^'"\s]+)['"]?\s*$/m.exec(readFileSync(path, 'utf8'))?.[1]
  if (!product) throw new Error(`${path} sets no PRODUCT`)
  return product === SKELETON_PRODUCT ? 'skeleton' : 'product'
}

const marker = (slot: string) => `// gen:service ${slot} (ADR 0030)`
const slots = (target: Target, files: Files): [file: string, slot: string][] => [
  [files.index, 'imports'],
  [files.index, 'configure'],
  [files.client, 'imports'],
  [files.client, 'exports'],
  [files.client, 'client-types'],
  [files.permissions, 'permissions'],
  // The product module's files start without the imports a service needs.
  ...(target === 'product' ? ([[files.permissions, 'imports']] as [string, string][]) : [])
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

type Catalogue = { permissions?: Partial<Record<'groups' | 'keys' | 'descriptions', Record<string, string>>> }

// Everything that would make the run stop half-way is checked first. A name
// is checked against the skeleton's files and the product's alike.
const preflight = (root: string, n: Names, target: Target) => {
  const files = FILES[target]
  const problems: string[] = []
  const read = (file: string) => readFileSync(join(root, file), 'utf8')
  if (existsSync(join(root, API, 'src/services', n.path))) problems.push(`src/services/${n.path} exists already`)
  if (existsSync(join(root, API, 'test/integration', `${n.path}.test.ts`))) problems.push(`test/integration/${n.path}.test.ts exists already`)
  for (const [file, slot] of slots(target, files)) {
    const count = read(file).split('\n').filter((line) => line.trim() === marker(slot)).length
    if (count !== 1) problems.push(`${file} needs exactly one line '${marker(slot)}', has ${count}`)
  }
  for (const each of Object.values(FILES)) {
    if (read(each.client).includes(`/services/${n.path}/`)) problems.push(`${each.client} already names ${n.path}`)
    if (read(each.permissions).includes(`'${n.permission}'`)) problems.push(`${each.permissions} already declares ${n.permission}`)
    if (read(each.index).includes(`/${n.path}/${n.path}.js'`)) problems.push(`${each.index} already registers ${n.path}`)
  }
  for (const locale of LOCALES) {
    for (const file of new Set([skeletonLocaleFile(locale), files.locale(locale)])) {
      if (!existsSync(join(root, file))) problems.push(`${file} is missing`)
      else if ((JSON.parse(read(file)) as Catalogue).permissions?.keys?.[n.permissionSlug]) problems.push(`${file} already labels ${n.permission}`)
    }
    const skeleton = (JSON.parse(read(skeletonLocaleFile(locale))) as Catalogue).permissions
    if (!skeleton?.keys || !skeleton.descriptions || !skeleton.groups) problems.push(`${skeletonLocaleFile(locale)} has no permissions.keys/descriptions/groups`)
  }
  if (problems.length) throw new Error(`Nothing was written:\n  - ${problems.join('\n  - ')}`)
}

const at = (slot: string) => before<Context>(marker(slot))
const file = (path: string) => (ctx: Context) => join(ctx.cwd, path)

// The locale files are JSON, written as they are formatted in the
// repository: two spaces, a final newline. A group label that exists is
// kept; a product's catalogue only adds one the skeleton lacks (ADR 0035).
const labelPermission = async (ctx: Context) => {
  const texts = translations(ctx.n, ctx.type)
  for (const locale of LOCALES) {
    const path = join(ctx.cwd, ctx.files.locale(locale))
    const skeletonGroups = (JSON.parse(readFileSync(join(ctx.cwd, skeletonLocaleFile(locale)), 'utf8')) as Catalogue).permissions?.groups ?? {}
    const messages = JSON.parse(readFileSync(path, 'utf8')) as Catalogue
    const permissions = (messages.permissions ??= {})
    const groups = (permissions.groups ??= {})
    if (!skeletonGroups[ctx.n.path]) groups[ctx.n.path] ??= texts[locale].group
    if (!Object.keys(groups).length) delete permissions.groups
    ;(permissions.keys ??= {})[ctx.n.permissionSlug] = texts[locale].key
    ;(permissions.descriptions ??= {})[ctx.n.permissionSlug] = texts[locale].description
    writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`)
    ctx.pinion.logger.notice(`Updated ${relative(ctx.cwd, path)}`)
  }
  return ctx
}

// Adds names to a file's import from a module, or the import itself before
// its imports marker; the product module's files start without them.
const ensureImport = (ctx: Context, file: string, module: string, names: string[], typeOnly: boolean) => {
  const path = join(ctx.cwd, file)
  const text = readFileSync(path, 'utf8')
  const keyword = typeOnly ? 'import type' : 'import'
  const existing = new RegExp(`^${keyword} \\{ ([^}]*) \\} from '${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`, 'm').exec(text)
  const line = (all: string[]) => `${keyword} { ${[...new Set(all)].sort().join(', ')} } from '${module}'`
  const next = existing
    ? text.replace(existing[0], line([...existing[1]!.split(',').map((name) => name.trim()).filter(Boolean), ...names]))
    : text.replace(`${marker('imports')}\n`, `${line(names)}\n${marker('imports')}\n`)
  if (next !== text) writeFileSync(path, next)
}

const productImports = async (ctx: Context) => {
  if (ctx.target !== 'product') return ctx
  for (const [module, names] of clientTypeImports(ctx.type)) ensureImport(ctx, ctx.files.client, module, names, true)
  ensureImport(ctx, ctx.files.permissions, '../permission-entry.js', ['entry'], false)
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
      `  - the wording of '${n.permission}' in ${LOCALES.map(ctx.files.locale).join(' and ')}`,
      `  - finer permissions than '${n.permission}', or granting it to a seeded role, if the product needs that (ADR 0011)`,
      ...(type === 'knex'
        ? [`  - a column referencing users(id) goes into ${ctx.files.personalData} and ${ctx.files.eraseFunction} (ADR 0013)`]
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
  const target = targetOf(root)
  preflight(root, n, target)
  const files = FILES[target]

  const ctx: Context = {
    ...init,
    cwd: root,
    n,
    type: args.type,
    target,
    files,
    migrationId: nextMigrationId(root),
    guessed: args.singular === undefined
  }
  ctx.pinion.logger.notice(`Registering in the ${target === 'skeleton' ? "skeleton's own files" : 'product module'} (product.env, ADR 0035)`)
  // Every file was checked not to exist; nothing asks before writing.
  ctx.pinion.force = true
  return Promise.resolve(ctx)
    .then(args.type === 'knex' ? writeKnex : writeCustom)
    .then(inject(({ n }) => indexImport(n, target), at('imports'), file(files.index)))
    .then(inject(({ n }) => indexConfigure(n, target), at('configure'), file(files.index)))
    .then(inject(({ n, type }) => clientImports(n, type, target), at('imports'), file(files.client)))
    .then(inject(({ n, type }) => clientExport(n, type, target), at('exports'), file(files.client)))
    .then(inject(({ n, type }) => clientType(n, type), at('client-types'), file(files.client)))
    .then(inject(({ n, type }) => permissionEntry(n, type), at('permissions'), file(files.permissions)))
    .then(productImports)
    .then(labelPermission)
    .then(checklist)
}
