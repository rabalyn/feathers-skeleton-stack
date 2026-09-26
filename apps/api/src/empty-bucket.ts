import { ConfigError, S3_KEYS, loadConfig } from './config.js'
import { PRODUCTION_BUCKETS, Storage } from './storage.js'

// Empties the configured uploads bucket of a test run: `test-uploads` of the
// integration tests, `e2e-uploads` of the end-to-end api (ADR 0015, 0020).
// Their databases are dropped between runs; this drops their objects with
// them. Refuses a bucket production has, whatever the environment says.
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
  if ((PRODUCTION_BUCKETS as readonly string[]).includes(config.s3UploadsBucket)) {
    process.stderr.write(`refusing to empty ${config.s3UploadsBucket}: a production bucket\n`)
    process.exit(1)
  }
  const storage = new Storage(config)
  try {
    const removed = await storage.empty()
    process.stdout.write(`emptied ${config.s3UploadsBucket}: ${removed} objects\n`)
  } finally {
    storage.close()
  }
}

await main()
