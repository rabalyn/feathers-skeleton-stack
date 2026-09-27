import { ConfigError, S3_KEYS, loadConfig } from './config.js'
import { PRODUCTION_BUCKETS, Storage } from './storage.js'

// Empties the configured uploads and exports buckets of a test run:
// `test-uploads` and `test-exports` of the integration tests, `e2e-uploads`
// and `e2e-exports` of the end-to-end api (ADR 0013, 0015, 0020). Their
// databases are dropped between runs; this drops their objects with them.
// Refuses a bucket production has, whatever the environment says.
const main = async () => {
  let config
  try {
    config = await loadConfig(S3_KEYS)
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
  const buckets = [config.s3UploadsBucket, config.s3ExportsBucket]
  const production = buckets.filter((bucket) => (PRODUCTION_BUCKETS as readonly string[]).includes(bucket))
  if (production.length) {
    process.stderr.write(`refusing to empty ${production.join(', ')}: production buckets\n`)
    process.exit(1)
  }
  for (const bucket of buckets) {
    const storage = new Storage(config, bucket)
    try {
      const removed = await storage.empty()
      process.stdout.write(`emptied ${bucket}: ${removed} objects\n`)
    } finally {
      storage.close()
    }
  }
}

await main()
