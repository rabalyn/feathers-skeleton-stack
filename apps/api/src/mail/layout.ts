import mjml2html from 'mjml'
import type { Locale } from '../locales.js'

// The frame of every mail (ADR 0027), owned by code: the product's name, the
// admin's content, and the footer. MJML compiles it once per locale, with
// markers where the subject and the content go, so sending a mail costs a
// string replacement rather than an MJML run. A product that wants another
// look changes this file.

// The product's name, in the header, the footer and `app.name`.
export const APP_NAME = 'claude-feathers'

const FOOTER: Record<Locale, string> = {
  de: 'Diese Nachricht wurde automatisch versendet.',
  en: 'This message was sent automatically.'
}

const SUBJECT = '%%MAIL_SUBJECT%%'
const CONTENT = '%%MAIL_CONTENT%%'
const APP_URL = '%%MAIL_APP_URL%%'

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const source = (locale: Locale) => `
<mjml lang="${locale}">
  <mj-head>
    <mj-title>${SUBJECT}</mj-title>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.5" color="#1d1d1d" />
    </mj-attributes>
    <mj-style>
      .content p { margin: 0 0 12px; }
      .content ul, .content ol { margin: 0 0 12px; padding-left: 20px; }
      .content a { color: #1565c0; }
      .content h1, .content h2, .content h3 { margin: 0 0 12px; line-height: 1.3; }
    </mj-style>
  </mj-head>
  <mj-body background-color="#f4f4f4">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold">${escapeHtml(APP_NAME)}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="16px 8px">
      <mj-column>
        <mj-text css-class="content">${CONTENT}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding="8px 0 24px">
      <mj-column>
        <mj-text font-size="12px" color="#666666">${escapeHtml(FOOTER[locale])} <a href="${APP_URL}" style="color:#666666">${escapeHtml(APP_NAME)}</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`

const compiled = new Map<Locale, Promise<string>>()

const compile = async (locale: Locale): Promise<string> => {
  const result = await mjml2html(source(locale), { validationLevel: 'strict', keepComments: false })
  return result.html
}

export interface LayoutInput {
  // Plain text; escaped here.
  subject: string
  // HTML from the Markdown renderer, which allows no raw HTML.
  content: string
  app: { name: string; url: string }
}

export const layout = async (locale: Locale, { subject, content, app }: LayoutInput): Promise<string> => {
  let frame = compiled.get(locale)
  if (!frame) {
    frame = compile(locale)
    compiled.set(locale, frame)
    frame.catch(() => compiled.delete(locale))
  }
  const values: Record<string, string> = { [SUBJECT]: escapeHtml(subject), [CONTENT]: content, [APP_URL]: escapeHtml(app.url) }
  return (await frame).replace(/%%MAIL_(SUBJECT|CONTENT|APP_URL)%%/g, (marker) => values[marker]!)
}
