// pino-roll ships no types; only what logger.ts uses.
declare module 'pino-roll' {
  import type { DestinationStream } from 'pino'

  interface PinoRollOptions {
    file: string
    size?: string | number
    frequency?: string | number
    extension?: string
    symlink?: boolean
    limit?: { count?: number; removeOtherLogFiles?: boolean }
    mkdir?: boolean
  }

  export default function roll(options: PinoRollOptions): Promise<DestinationStream>
}
