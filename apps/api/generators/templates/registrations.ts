import { propertyKey, type Names } from '../names.js'

// What a new service adds to the files every service shares, each at the
// `// gen:service <slot>` marker line there (ADR 0030).

export type ServiceType = 'knex' | 'custom'

export const indexImport = (n: Names) => `import { ${n.configure} } from './${n.path}/${n.path}.js'`
export const indexConfigure = (n: Names) => `  app.configure(${n.configure})`

// The client entry point takes types only (ADR 0007), so the dependency
// boundary is untouched.
const typesModule = (n: Names, type: ServiceType) =>
  `./services/${n.path}/${n.path}${type === 'knex' ? '.schema' : ''}.js`

const recordTypes = (n: Names, type: ServiceType) =>
  type === 'knex' ? [n.pascal, `${n.pascal}Data`, `${n.pascal}Patch`, `${n.pascal}Query`] : [n.pascal, `${n.pascal}Data`]

export const clientImports = (n: Names, type: ServiceType) =>
  type === 'knex'
    ? [
        `import type { ${recordTypes(n, type).join(', ')} } from '${typesModule(n, type)}'`,
        `import type { ${n.methodsConst} } from './services/${n.path}/${n.path}.js'`
      ].join('\n')
    : `import type { ${[...recordTypes(n, type), n.methodsConst].join(', ')} } from '${typesModule(n, type)}'`

export const clientExport = (n: Names, type: ServiceType) =>
  `export type { ${recordTypes(n, type).join(', ')} } from '${typesModule(n, type)}'`

export const clientType = (n: Names, type: ServiceType) => {
  const service =
    type === 'knex'
      ? `ClientService<${n.pascal}, ${n.pascal}Data, ${n.pascal}Patch, Paginated<${n.pascal}>, Params<${n.pascal}Query>>`
      : `ClientService<${n.pascal}, ${n.pascal}Data, never, never, Params>`
  return [`  ${propertyKey(n.path)}: External<`, `    ${service},`, `    typeof ${n.methodsConst}`, `  >`].join('\n')
}

// One permission for everything the service offers; split it once the
// product needs finer rights (ADR 0011). `read` on an action is for
// feathers-casl's check of the create's result.
export const permissionEntry = (n: Names, type: ServiceType) =>
  type === 'knex'
    ? `  entry('${n.permission}', '${n.path}', (can) => can(['read', 'write', 'delete'], '${n.path}')),`
    : `  // \`read\` for feathers-casl's check of the create's result.\n  entry('${n.permission}', '${n.path}', (can) => can(['create', 'read'], '${n.path}')),`

// Labels for the permissions page, in every locale the web app has (ADR
// 0011, 0014). Placeholder wording, to be reviewed.
const nouns = (words: string) => words.replace(/(^| )([a-z])/g, (_match, space: string, letter: string) => space + letter.toUpperCase())

export const translations = (n: Names, type: ServiceType): Record<'en' | 'de', { group: string; key: string; description: string }> => ({
  en: {
    group: n.title,
    key: `Manage ${n.words}`,
    description: type === 'knex' ? `Read, create, change and delete ${n.words}.` : `Ask for ${n.words}.`
  },
  de: {
    group: nouns(n.words),
    key: `${nouns(n.words)} verwalten`,
    description: type === 'knex' ? `${nouns(n.words)} lesen, anlegen, ändern und löschen.` : `${nouns(n.words)} anstoßen.`
  }
})
