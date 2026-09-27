import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import type { Knex } from 'knex'
import { ZipFile } from 'yazl'
import type { Storage } from '../storage.js'
import { TABLE_ENTRIES, exportedFiles } from './registry.js'

// A person's data export (ADR 0013): a ZIP holding export.json, everything
// the registry collects about the person, and the bytes of their files under
// files/<id>/<filename>. Written to the exports bucket under the id of its
// data_exports row.

export const EXPORT_FORMAT = 'data-export/1'
export const EXPORT_CONTENT_TYPE = 'application/zip'

export interface ExportResult {
  exportId: string
  state: 'ready' | 'skipped'
  sizeBytes?: number
  sha256?: string
  // Files whose object was not in the uploads bucket (an integrity fault).
  missingFiles?: string[]
}

interface ExportedFile {
  id: string
  filename: string
  contentType: string
  sizeBytes: string | number
  sha256: string
  createdAt: Date
  path?: string | null
  missing?: boolean
}

// A name that is one path segment in every unzip tool: no separators, no
// control characters, no leading dots.
export const zipSegment = (name: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  name.replace(/[\u0000-\u001f\u007f/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200) || '_'

export const collectExport = async (knex: Knex, subjectId: string) => {
  const data: Record<string, unknown> = {}
  for (const entry of TABLE_ENTRIES) {
    if (entry.export) data[entry.export.key] = await entry.export.collect(knex, subjectId)
  }
  const files = (await exportedFiles(knex, subjectId)) as ExportedFile[]
  data.files = files.map((file) => ({
    ...file,
    sizeBytes: Number(file.sizeBytes),
    path: `files/${file.id}/${zipSegment(file.filename)}`
  }))
  return data as Record<string, unknown> & { files: (ExportedFile & { path: string | null; sizeBytes: number })[] }
}

export interface BuildOptions {
  knex: Knex
  uploads: Storage
  exports: Storage
  exportId: string
}

// Builds the export of one pending row. A row that is gone or no longer
// pending (erased meanwhile, or finished by an earlier attempt) is skipped.
// A file whose object is missing is still listed, with `missing: true` and
// no path, and reported in the result: the person gets everything that
// exists, and the gap is visible rather than silent (ADR 0013). An object
// that vanishes while the ZIP is written fails the attempt.
export const buildExport = async ({ knex, uploads, exports, exportId }: BuildOptions): Promise<ExportResult> => {
  const row = await knex('dataExports').where({ id: exportId }).first<{ subjectId: string; state: string } | undefined>()
  if (!row || row.state !== 'pending') return { exportId, state: 'skipped' }

  const data = await collectExport(knex, row.subjectId)
  const missingFiles: string[] = []
  for (const file of data.files) {
    if (await uploads.exists(file.id)) continue
    missingFiles.push(file.id)
    file.missing = true
    file.path = null
  }
  const json = Buffer.from(
    JSON.stringify({ format: EXPORT_FORMAT, generatedAt: new Date().toISOString(), subjectId: row.subjectId, ...data }, null, 2)
  )

  // Hashed and counted on the way to the bucket. A failing entry destroys
  // the stream, which aborts the upload.
  const hash = createHash('sha256')
  let sizeBytes = 0
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      sizeBytes += chunk.length
      callback(null, chunk)
    }
  })

  // The error surfaces through the upload's reading of the stream; until
  // that has begun (the multipart upload is still being created), nothing
  // else listens, and an unheard 'error' would end the process.
  counted.on('error', () => {})

  const zip = new ZipFile()
  zip.on('error', (error: Error) => counted.destroy(error))
  zip.addBuffer(json, 'export.json')
  for (const file of data.files) {
    if (!file.path) continue
    const path = file.path
    // Opened when yazl reaches the entry, so one object is read at a time.
    // Images and PDFs are compressed already.
    zip.addReadStreamLazy(path, { size: file.sizeBytes, mtime: new Date(file.createdAt), compress: false }, (callback) => {
      uploads.get(file.id).then(
        (stored) => (stored ? callback(null, stored.body) : callback(new Error(`object missing for file ${file.id}`), undefined as never)),
        (error: Error) => callback(error, undefined as never)
      )
    })
  }
  zip.end()
  zip.outputStream.pipe(counted)
  await exports.putStream(exportId, counted, EXPORT_CONTENT_TYPE)
  const sha256 = hash.digest('hex')

  const updated = await knex('dataExports')
    .where({ id: exportId, state: 'pending' })
    .update({ state: 'ready', sizeBytes, sha256, completedAt: knex.fn.now() })
  if (updated !== 1) {
    // Erased while it was built: the object must not outlive its row.
    await exports.delete(exportId)
    return { exportId, state: 'skipped' }
  }
  return { exportId, state: 'ready', sizeBytes, sha256, ...(missingFiles.length ? { missingFiles } : {}) }
}
