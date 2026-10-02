// Checks docs/adr_v2/diagrams/topology.md against the configuration it is
// drawn from (ADR 0019, *Diagrams*). Run through scripts/diagrams.sh, which
// hands it compose.yaml as JSON on stdin.
//
// - The network membership matrix: its columns are compose.yaml's networks,
//   every service on a network has a row, each row marks exactly that
//   service's networks, with ● for every environment, L for the `local`
//   profile and T for the `test` profile.
// - The listener table: every `service:port` the configuration connects to
//   (URLs and upstreams, *_HOST/*_PORT pairs, scrape targets) has a row.
//
// Prints nothing and exits 0 when both agree, else lists every difference.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? '.'
const PAGE = 'docs/adr_v2/diagrams/topology.md'
// Files besides compose.yaml that name a service and the port they reach it
// on; stack.sh sets the dev profile's Vite upstream.
const PORT_SOURCES = [
  'compose.yaml',
  'containers/prometheus/prometheus.yml',
  'containers/grafana/provisioning/datasources/datasources.yaml',
  'containers/alloy/config.alloy',
  'scripts/stack.sh'
]

const compose = JSON.parse(readFileSync(0, 'utf8'))
const page = readFileSync(join(ROOT, PAGE), 'utf8')
const errors = []

const services = compose.services
const names = Object.keys(services)
const networksOf = (name) => {
  const networks = services[name].networks ?? []
  return new Set(Array.isArray(networks) ? networks : Object.keys(networks))
}
const markerOf = (name) => {
  const profiles = services[name].profiles ?? []
  if (profiles.includes('test')) return 'T'
  if (profiles.includes('local')) return 'L'
  return '●'
}

// The Markdown table that follows a heading, as rows of trimmed cells.
const tableAfter = (heading) => {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) {
    errors.push(`${PAGE}: no "${heading}" section`)
    return []
  }
  const rows = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break
    if (!line.startsWith('|')) {
      if (rows.length) break
      continue
    }
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()))
  }
  return rows.filter((row) => !row.every((cell) => /^-+$/.test(cell)))
}

// The services a first cell names, comma-separated, in backticks or not,
// with remarks in parentheses ignored. `*-agent` stands for every agent no
// other row of the same table names (`named`).
const servicesIn = (cell, named = new Set()) => {
  const listed = cell
    .replace(/\(.*?\)/g, '')
    .replace(/`/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return listed.flatMap((entry) => {
    if (entry === '*-agent') return names.filter((name) => name.endsWith('-agent') && !named.has(name))
    if (!names.includes(entry)) {
      errors.push(`${PAGE}: "${entry}" is not a service in compose.yaml`)
      return []
    }
    return [entry]
  })
}

// --- network membership matrix ---------------------------------------------

const [header, ...matrix] = tableAfter('## Network membership')
if (header) {
  const columns = header.slice(1)
  const declared = Object.keys(compose.networks ?? {})
  for (const network of declared) if (!columns.includes(network)) errors.push(`matrix: no column for network ${network}`)
  for (const column of columns) if (!declared.includes(column)) errors.push(`matrix: column ${column} is not a network in compose.yaml`)

  const named = new Set(matrix.flatMap(([label]) => (label.includes('*-agent') ? [] : servicesIn(label))))
  const covered = new Set()
  for (const [label, ...cells] of matrix) {
    for (const name of servicesIn(label, named)) {
      covered.add(name)
      const actual = networksOf(name)
      columns.forEach((network, i) => {
        const cell = cells[i] ?? ''
        if (actual.has(network) && cell !== markerOf(name)) {
          errors.push(`matrix: ${name} on ${network} should be ${markerOf(name)}, is "${cell}"`)
        } else if (!actual.has(network) && cell !== '') {
          errors.push(`matrix: ${name} is not on ${network}, but the matrix marks "${cell}"`)
        }
      })
    }
  }
  for (const name of names) {
    if (networksOf(name).size && !covered.has(name)) errors.push(`matrix: no row for ${name}`)
  }
}

// --- listeners ---------------------------------------------------------------

const [, ...listenerRows] = tableAfter('## Listeners')
const listed = new Set()
for (const [label, port] of listenerRows) {
  const number = /^\d+/.exec(port ?? '')?.[0]
  for (const name of servicesIn(label)) listed.add(`${name}:${number}`)
}

const reached = new Map() // "service:port" → where it was found
const serviceAlternation = names
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[-]/g, '\\-'))
  .join('|')
const hostPort = new RegExp(`(?<![\\w.-])(${serviceAlternation}):(\\d{2,5})\\b`, 'g')
for (const file of PORT_SOURCES) {
  for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(hostPort)) {
    reached.set(`${match[1]}:${match[2]}`, file)
  }
}
for (const [name, service] of Object.entries(services)) {
  const env = Array.isArray(service.environment) ? {} : (service.environment ?? {})
  for (const [key, host] of Object.entries(env)) {
    const prefix = /^(.*)_HOST$/.exec(key)?.[1]
    const port = prefix && env[`${prefix}_PORT`]
    if (port && names.includes(host)) reached.set(`${host}:${port}`, `compose.yaml (${name}: ${key})`)
  }
}
for (const [target, where] of reached) {
  if (!listed.has(target)) errors.push(`listeners: ${target}, reached in ${where}, has no row`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
