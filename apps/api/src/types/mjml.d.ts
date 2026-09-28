// mjml ships no types; only what mail/layout.ts uses (MJML 5, asynchronous).
declare module 'mjml' {
  interface MjmlOptions {
    validationLevel?: 'strict' | 'soft' | 'skip'
    keepComments?: boolean
    minify?: boolean
  }

  interface MjmlResult {
    html: string
    errors: { line: number; message: string; tagName: string; formattedMessage: string }[]
  }

  export default function mjml2html(input: string, options?: MjmlOptions): Promise<MjmlResult>
}
