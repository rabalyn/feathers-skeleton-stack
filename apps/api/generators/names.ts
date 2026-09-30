// The names a service is known by, derived from its path (ADR 0030). The
// path is plural kebab-case, as every existing one is; the record type is
// its singular.

export interface Names {
  // `widget-things`: the service path, its folder and file names.
  path: string
  // `widget_things`: the table (ADR 0005: snake_case in PostgreSQL).
  table: string
  // `widgetThings`: the configure function.
  configure: string
  // `widgetThing`: the prefix of schemas, validators and resolvers.
  camel: string
  // `WidgetThing`: the record type; `WidgetThingService` the class.
  pascal: string
  // `WIDGET_THINGS_PATH`.
  pathConst: string
  // `WIDGET_THING_EXTERNAL_METHODS`.
  methodsConst: string
  // `widget-things.manage`, and its translation key `widget-things_manage`.
  permission: string
  permissionSlug: string
  // `widget things`, and `Widget things` to begin a sentence, for comments
  // and English labels.
  words: string
  title: string
}

const PATH_PATTERN = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/

const singularOf = (path: string): string | undefined => {
  if (/ies$/.test(path)) return path.replace(/ies$/, 'y')
  if (/(ch|sh|x|ss)es$/.test(path)) return path.replace(/es$/, '')
  if (/[^s]s$/.test(path)) return path.replace(/s$/, '')
  return undefined
}

const camelOf = (kebab: string) => kebab.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
const constOf = (kebab: string) => kebab.replace(/-/g, '_').toUpperCase()

export const namesFor = (path: string, singular?: string): Names => {
  if (!PATH_PATTERN.test(path)) throw new Error(`'${path}' is not a kebab-case path such as 'widget-things'`)
  if (path === 'authentication') throw new Error(`'authentication' is taken by Feathers authentication`)
  const one = singular ?? singularOf(path)
  if (!one) throw new Error(`Cannot tell the singular of '${path}'; pass --singular`)
  if (!PATH_PATTERN.test(one)) throw new Error(`'${one}' is not a kebab-case name`)
  if (one === path) throw new Error(`The singular must differ from the path '${path}'`)
  const camel = camelOf(one)
  return {
    path,
    table: path.replace(/-/g, '_'),
    configure: camelOf(path),
    camel,
    pascal: camel.charAt(0).toUpperCase() + camel.slice(1),
    pathConst: `${constOf(path)}_PATH`,
    methodsConst: `${constOf(one)}_EXTERNAL_METHODS`,
    permission: `${path}.manage`,
    permissionSlug: `${path}_manage`,
    words: path.replace(/-/g, ' '),
    title: path.charAt(0).toUpperCase() + path.slice(1).replace(/-/g, ' ')
  }
}

// A key in an object type: quoted only where it has to be, as client.ts has
// them.
export const propertyKey = (name: string) => (/^[a-z][a-zA-Z0-9]*$/.test(name) ? name : `'${name}'`)
