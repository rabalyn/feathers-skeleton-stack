// The declared versions of what production runs (ADR 0032), read from the
// files that pin every image: compose.yaml's `@digest # version` lines and
// the Containerfiles' `tag@digest` lines, the patterns Renovate reads too.
// Run through scripts/inventory.sh, which writes or checks the result.
//
// Prints the inventory as JSON, or fails with the reasons when an image
// that production runs is not covered by a component below, or a component's
// pin cannot be found or disagrees between files.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? '.'

// Each component and where its image is pinned. `files` lists every file
// that pins it; all of them must agree. A component without an image
// (PgBouncer and the host's OS) has its version from the running system only.
const COMPONENTS = [
  { id: 'postgresql', image: 'docker.io/library/postgres', files: ['compose.yaml'] },
  { id: 'pgbouncer', image: null, files: [] },
  { id: 'valkey', image: 'docker.io/valkey/valkey', files: ['compose.yaml'] },
  { id: 'openbao', image: 'docker.io/openbao/openbao', files: ['compose.yaml'] },
  { id: 'garage', image: 'docker.io/dxflrs/garage', files: ['containers/s3/Containerfile'] },
  { id: 'nginx', image: 'docker.io/library/nginx', files: ['containers/nginx/Containerfile'] },
  { id: 'netbox', image: 'docker.io/netboxcommunity/netbox', files: ['containers/netbox/Containerfile'] },
  { id: 'node', image: 'docker.io/library/node', files: ['containers/api/Containerfile', 'containers/nginx/Containerfile'] },
  { id: 'restic', image: 'docker.io/restic/restic', files: ['containers/api/Containerfile'] },
  { id: 'alpine', image: 'docker.io/library/alpine', files: ['containers/pgbouncer/Containerfile', 'containers/s3/Containerfile'] },
  { id: 'prometheus', image: 'docker.io/prom/prometheus', files: ['compose.yaml'] },
  { id: 'loki', image: 'docker.io/grafana/loki', files: ['compose.yaml'] },
  { id: 'grafana', image: 'docker.io/grafana/grafana', files: ['compose.yaml'] },
  { id: 'alloy', image: 'docker.io/grafana/alloy', files: ['compose.yaml'] },
  { id: 'node-exporter', image: 'quay.io/prometheus/node-exporter', files: ['compose.yaml'] },
  { id: 'blackbox-exporter', image: 'quay.io/prometheus/blackbox-exporter', files: ['compose.yaml'] },
  { id: 'postgres-exporter', image: 'quay.io/prometheuscommunity/postgres-exporter', files: ['compose.yaml'] },
  { id: 'pgbouncer-exporter', image: 'quay.io/prometheuscommunity/pgbouncer-exporter', files: ['compose.yaml'] },
  { id: 'redis-exporter', image: 'docker.io/oliver006/redis_exporter', files: ['compose.yaml'] },
  { id: 'host', image: null, files: [] }
]

// The images production builds itself, by the directory of their
// Containerfile: every image those pin must belong to a component.
const BUILT = { api: 'api', backup: 'api', netbox: 'netbox', nginx: 'nginx', pgbouncer: 'pgbouncer', s3: 's3' }

const VERSION = /^v?\d+(\.\d+)+([-+][\w.-]+)?$/
const errors = []
const read = (file) => readFileSync(join(ROOT, file), 'utf8').split('\n')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The version of one pin: the tag (`repo:tag@digest`), else a trailing
// `# version` on the line, else an adjacent comment line that is a bare
// version or names the image (`# restic 0.19.1, …`).
const pinsIn = (file, image) => {
  const lines = read(file)
  const name = image.split('/').pop()
  const pattern = new RegExp(`${escape(image)}(?::([^@\\s]+))?@(sha256:[a-f0-9]{64})`)
  const pins = []
  lines.forEach((line, i) => {
    const match = pattern.exec(line)
    if (!match) return
    let version = match[1]
    if (!version) version = /#\s*(\S+)\s*$/.exec(line)?.[1]
    for (const near of [lines[i - 1], lines[i + 1]]) {
      if (version || !near?.trimStart().startsWith('#')) continue
      const words = near.replace(/^\s*#\s*/, '').split(/[\s,]+/)
      if (words.length === 1 && VERSION.test(words[0])) version = words[0]
      else if (words[0] === name && VERSION.test(words[1] ?? '')) version = words[1]
    }
    if (!version || !VERSION.test(version)) errors.push(`${file}:${i + 1}: no version for ${image}`)
    else pins.push({ file, line: i + 1, tag: version, digest: match[2] })
  })
  return pins
}

const components = COMPONENTS.map(({ id, image, files }) => {
  if (!image) return { id, image: null, version: null, digest: null }
  const pins = files.flatMap((file) => {
    const found = pinsIn(file, image)
    if (!found.length) errors.push(`${file}: ${id} (${image}) is not pinned there`)
    return found
  })
  const distinct = new Set(pins.map((pin) => `${pin.tag}@${pin.digest}`))
  if (distinct.size > 1) {
    errors.push(`${id}: the pins disagree: ${pins.map((pin) => `${pin.file}:${pin.line} ${pin.tag}`).join(', ')}`)
  }
  return { id, image, version: pins[0]?.tag ?? null, digest: pins[0]?.digest ?? null }
})

// Coverage: every image production runs belongs to a component.
const digests = new Set(components.map((component) => component.digest).filter(Boolean))
const quadlet = join(ROOT, 'deploy/quadlet')
for (const unit of readdirSync(quadlet).filter((file) => file.endsWith('.container'))) {
  const image = /^Image=(\S+)$/m.exec(readFileSync(join(quadlet, unit), 'utf8'))?.[1]
  if (!image) continue
  const built = /^localhost\/feathers-([a-z0-9-]+):/.exec(image)
  if (built) {
    const dir = BUILT[built[1]]
    if (!dir) {
      errors.push(`${unit}: ${image} is built here but not listed in BUILT (scripts/inventory.mjs)`)
      continue
    }
    for (const line of read(`containers/${dir}/Containerfile`)) {
      const pinned = /((?:docker\.io|quay\.io|ghcr\.io)\/[^:@\s]+)(?::[^@\s]+)?@(sha256:[a-f0-9]{64})/.exec(line)
      if (pinned && !digests.has(pinned[2])) {
        errors.push(`containers/${dir}/Containerfile: ${pinned[1]} has no component (scripts/inventory.mjs)`)
      }
    }
  } else {
    const digest = /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1]
    if (!digest || !digests.has(digest)) errors.push(`${unit}: ${image} has no component (scripts/inventory.mjs)`)
  }
}

if (errors.length) {
  for (const error of [...new Set(errors)]) console.error(`inventory: ${error}`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify({ components }, null, 2)}\n`)
