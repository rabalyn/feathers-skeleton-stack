import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// The break-glass password (ADR 0008): argon2id from Node's own crypto, stored
// as a PHC string, so the parameters travel with the hash and can be raised
// later without invalidating it. RFC 9106's second recommended option:
// 64 MiB, three passes, four lanes.

const derive = promisify(argon2)

const PARAMETERS = { memory: 64 * 1024, passes: 3, parallelism: 4, tagLength: 32 }
const SALT_BYTES = 16
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

// Longer than anyone types, so a flood of huge passwords cannot tie up the
// hash; a generated password is 32 characters.
export const MAX_PASSWORD_LENGTH = 256

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '')

// 192 random bits, URL-safe so it survives copying into KeePass and a shell.
export const generatePassword = (): string => randomBytes(24).toString('base64url')

export const hashPassword = async (password: string): Promise<string> => {
  const nonce = randomBytes(SALT_BYTES)
  const tag = await derive('argon2id', { message: password, nonce, ...PARAMETERS })
  const { memory, passes, parallelism } = PARAMETERS
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(nonce)}$${b64(tag)}`
}

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const match = PHC.exec(stored)
  if (!match) return false
  const [, memory, passes, parallelism, salt, hash] = match as unknown as [string, string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64')
  const tag = await derive('argon2id', {
    message: password,
    nonce: Buffer.from(salt, 'base64'),
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expected.length
  })
  return timingSafeEqual(tag, expected)
}

// Verified against when no account matches, so an unknown address takes as
// long to refuse as a wrong password.
let decoy: Promise<string> | undefined
export const decoyHash = (): Promise<string> => (decoy ??= hashPassword(generatePassword()))
