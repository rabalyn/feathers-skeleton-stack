import type { Locale } from '../locales.js'

// The frame of every mail (ADR 0027), owned by code: the product's name, the
// admin's content, and the footer. It is plain HTML on purpose: only
// elements and inline properties that every client renders in full
// (caniemail, as Mailpit's HTML check reports it), so no <body>, no <style>,
// no <hr>, and nothing for spacing, width or background. A product that
// wants another look changes this file and keeps that check clean.

// The product's name, in the header, the footer and `app.name`.
export const APP_NAME = 'claude-feathers'

const FOOTER: Record<Locale, string> = {
  de: 'Diese Nachricht wurde automatisch versendet.',
  en: 'This message was sent automatically.'
}

const FONT = 'font-family:Helvetica, Arial, sans-serif;font-size:15px;color:#1d1d1d'
const MUTED = 'font-size:12px;color:#666666'

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export interface LayoutInput {
  // Plain text; escaped here.
  subject: string
  // HTML from the Markdown renderer, which allows no raw HTML.
  content: string
  app: { name: string; url: string }
}

export const layout = (locale: Locale, { subject, content, app }: LayoutInput): string => `<!doctype html>
<html lang="${locale}" dir="ltr">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<div style="${FONT}">
<p style="font-size:18px"><strong>${escapeHtml(APP_NAME)}</strong></p>
${content}<p style="${MUTED}">${escapeHtml(FOOTER[locale])} <a href="${escapeHtml(app.url)}" style="${MUTED}">${escapeHtml(APP_NAME)}</a></p>
</div>
</html>
`
