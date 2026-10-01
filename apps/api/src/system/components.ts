import { INVENTORY as GENERATED } from './inventory.js'
import type { TagRule } from './versions.js'

// What production runs (ADR 0032): the declared versions come from
// inventory.ts, which scripts/inventory.sh generates from the image pins;
// this file says, per component, how to read its running version, how its
// tags count as versions, and where its end of life is published.

export interface InventoryEntry {
  id: string
  image: string | null
  version: string | null
  digest: string | null
}

// Where the running version comes from.
export type LiveSource =
  // A Prometheus series and the label that holds the version.
  | { kind: 'prometheus'; query: string; label: string; strip?: RegExp }
  | { kind: 'valkey' }
  | { kind: 'netbox' }
  | { kind: 'process' }
  // Nothing reports it: the declared version is all there is.
  | { kind: 'none' }

export interface Component {
  id: string
  name: string
  rule: TagRule
  // The endoflife.date product, where it knows the component.
  eol?: string
  live: LiveSource
}

const build = (metric: string): LiveSource => ({ kind: 'prometheus', query: metric, label: 'version' })

export const COMPONENTS: readonly Component[] = [
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    rule: { lineDepth: 1 },
    eol: 'postgresql',
    live: { kind: 'prometheus', query: 'pg_static', label: 'short_version' }
  },
  {
    id: 'pgbouncer',
    name: 'PgBouncer',
    rule: { lineDepth: 2 },
    live: { kind: 'prometheus', query: 'pgbouncer_version_info', label: 'version', strip: /^PgBouncer\s+/ }
  },
  { id: 'valkey', name: 'Valkey', rule: { lineDepth: 2 }, eol: 'valkey', live: { kind: 'valkey' } },
  { id: 'openbao', name: 'OpenBao', rule: { lineDepth: 2 }, eol: 'openbao', live: { kind: 'none' } },
  { id: 'garage', name: 'Garage', rule: { lineDepth: 2 }, live: build('garage_build_info') },
  { id: 'nginx', name: 'Nginx', rule: { lineDepth: 2 }, eol: 'nginx', live: { kind: 'none' } },
  { id: 'netbox', name: 'NetBox', rule: { lineDepth: 2, revision: true }, live: { kind: 'netbox' } },
  { id: 'node', name: 'Node.js', rule: { lineDepth: 1 }, eol: 'nodejs', live: { kind: 'process' } },
  { id: 'restic', name: 'restic', rule: { lineDepth: 2 }, live: { kind: 'none' } },
  { id: 'alpine', name: 'Alpine Linux', rule: { lineDepth: 2 }, eol: 'alpine-linux', live: { kind: 'none' } },
  { id: 'prometheus', name: 'Prometheus', rule: { lineDepth: 2 }, eol: 'prometheus', live: build('prometheus_build_info') },
  { id: 'loki', name: 'Loki', rule: { lineDepth: 2 }, eol: 'grafana-loki', live: build('loki_build_info') },
  { id: 'grafana', name: 'Grafana', rule: { lineDepth: 2 }, eol: 'grafana', live: build('grafana_build_info') },
  { id: 'alloy', name: 'Alloy', rule: { lineDepth: 2 }, live: { kind: 'none' } },
  { id: 'node-exporter', name: 'node_exporter', rule: { lineDepth: 2 }, live: build('node_exporter_build_info') },
  { id: 'blackbox-exporter', name: 'blackbox_exporter', rule: { lineDepth: 2 }, live: { kind: 'none' } },
  { id: 'postgres-exporter', name: 'postgres_exporter', rule: { lineDepth: 2 }, live: build('postgres_exporter_build_info') },
  { id: 'pgbouncer-exporter', name: 'pgbouncer_exporter', rule: { lineDepth: 2 }, live: build('pgbouncer_exporter_build_info') },
  { id: 'redis-exporter', name: 'redis_exporter', rule: { lineDepth: 2 }, live: build('redis_exporter_build_info') },
  // The host's operating system: no image, no update check, only its end of
  // life, from what node_exporter reports. Its readable name is shown: a
  // rolling distribution has no version at all.
  { id: 'host', name: 'Host OS', rule: { lineDepth: 1 }, live: { kind: 'prometheus', query: 'node_os_info', label: 'pretty_name' } }
]

export const INVENTORY: readonly InventoryEntry[] = GENERATED

export const componentById = new Map(COMPONENTS.map((component) => [component.id, component]))
export const inventoryById = new Map(INVENTORY.map((entry) => [entry.id, entry]))
