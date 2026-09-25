import { BreakGlassError, createBreakGlass, rotateBreakGlass } from './auth/break-glass.js'
import { ConfigError, DATABASE_KEYS, loadConfig } from './config.js'
import { createKnex } from './db.js'

// The bootstrap command (ADR 0008): creates the break-glass account, or with
// --rotate gives it a new password. Runs inside the api container, with the
// api's own configuration and database login:
//
//   podman exec api node dist/bootstrap.js --email <address>
//   podman exec api node dist/bootstrap.js --rotate
//
// The password goes to stdout, once, and nowhere else; everything else goes
// to stderr. Runtime settings are seeded by migrate, not here (ADR 0025).

const USAGE = 'usage: bootstrap.js --email <address> | --rotate'

const fail = (message: string): never => {
  process.stderr.write(`bootstrap: ${message}\n`)
  process.exit(1)
}

const parse = (args: string[]): { email: string } | { rotate: true } => {
  if (args.length === 1 && args[0] === '--rotate') return { rotate: true }
  if (args.length === 2 && args[0] === '--email' && args[1]) return { email: args[1] }
  return fail(USAGE)
}

const main = async () => {
  const command = parse(process.argv.slice(2))
  let config
  try {
    config = await loadConfig(DATABASE_KEYS)
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }
  const knex = createKnex({ ...config, databasePoolMax: 1 }, { camelCase: true })
  try {
    if ('rotate' in command) {
      const { email, password } = await rotateBreakGlass(knex)
      process.stderr.write(
        `bootstrap: new password for ${email}; its sessions are revoked. Open WebSockets of the account close on restart of the api.\n`
      )
      process.stdout.write(`${password}\n`)
    } else {
      const { password } = await createBreakGlass(knex, command.email)
      process.stderr.write(`bootstrap: break-glass account ${command.email} created with role admin\n`)
      process.stdout.write(`${password}\n`)
    }
    process.stderr.write('bootstrap: store the password now, e.g. in KeePass; it is not shown again\n')
  } catch (error) {
    if (error instanceof BreakGlassError) fail(error.message)
    throw error
  } finally {
    await knex.destroy()
  }
}

void main()
