import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../src/locales.js'
import { MAIL_KINDS } from '../../src/mail/registry.js'
import { TemplateError, escapeMarkdown, renderMail, templateVariablePaths } from '../../src/mail/render.js'

// ADR 0027: Liquid, then Markdown, then the HTML layout, with every output
// escaped.

const app = { name: 'Example product', url: 'https://app.example.org' }
const recipient = { givenName: 'Erika', surname: 'Mustermann' }

const render = (body: string, variables: Record<string, unknown> = {}, subject = 'Betreff') =>
  renderMail({ locale: 'de', subject, body, variables: { recipient, app, ...variables } })

describe('renderMail', () => {
  it.each(MAIL_KINDS.flatMap((kind) => LOCALES.map((locale) => [kind.key, locale, kind] as const)))(
    '%s renders its %s default against its sample',
    async (_key, locale, kind) => {
      const mail = await renderMail({ locale, ...kind.defaults[locale], variables: { ...kind.sample, recipient, app } })
      expect(mail.subject).not.toBe('')
      expect(mail.html).toContain('<!doctype html>')
      expect(mail.html).toContain(app.name)
      expect(mail.html).toContain('Erika')
      expect(mail.text).toContain('Erika Mustermann')
      expect(mail.text).not.toMatch(/[<>]/)
    }
  )

  it('uses only markup every client renders in full', async () => {
    const mail = await render('# Titel\n\nText\n\n---\n\n- a\n- b\n\n***\n\n[Öffnen](https://app.example.org/x)')
    expect(mail.html).not.toMatch(/<(body|style|link|hr)\b/)
    expect(mail.html).not.toMatch(/(margin|padding|width|background|line-height|font-weight|border)\s*:/)
    expect(mail.html).toContain('<p>---</p>')
    expect(mail.html).toContain('<li>a</li>')
  })

  it('shows markup and Markdown in values as text, never as links or HTML', async () => {
    const evil = { givenName: '[x](https://evil.example) <img src=x onerror=alert(1)>', surname: '# *bold*\n\n- item' }
    const mail = await renderMail({
      locale: 'en',
      subject: 'Hi {{ recipient.givenName }}',
      body: 'Hello {{ recipient.givenName }} {{ recipient.surname }}',
      variables: { recipient: evil, app }
    })
    expect(mail.html).not.toContain('evil.example"')
    expect(mail.html).not.toContain('<img')
    expect(mail.html).not.toContain('<h1')
    expect(mail.html).not.toContain('<em>')
    expect(mail.html).toContain('[x](https://evil.example) &lt;img src=x onerror=alert(1)&gt;')
    expect(mail.text).toContain('[x](https://evil.example) <img src=x onerror=alert(1)> # *bold* - item')
    // The subject is plain text, one line, escaped only in the HTML title.
    expect(mail.subject).toBe('Hi [x](https://evil.example) <img src=x onerror=alert(1)>')
    expect(mail.html).toContain('<title>Hi [x](https://evil.example) &lt;img')
  })

  it('refuses raw HTML in the template itself', async () => {
    const mail = await render('<script>alert(1)</script> <b>bold</b>')
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).not.toContain('<b>')
  })

  it('renders Markdown and links into the application, in HTML and text', async () => {
    const mail = await render('**Wichtig**\n\n- eins\n- zwei\n\n[Öffnen]({{ app.url }}/documents)')
    expect(mail.html).toContain('<strong>Wichtig</strong>')
    expect(mail.html).toContain('<a href="https://app.example.org/documents">Öffnen</a>')
    expect(mail.text).toContain('Wichtig\n\n- eins\n- zwei\n\nÖffnen (https://app.example.org/documents)')
  })

  it('refuses links out of the application and images', async () => {
    await expect(render('[Hier](https://evil.example/x)')).rejects.toThrow(/links must point into the application/)
    await expect(render('[Hier](https://app.example.org.evil.example/)')).rejects.toThrow(TemplateError)
    // Markdown itself never makes this a link.
    expect((await render('[Hier](javascript:alert(1))')).html).not.toContain('href="javascript')
    const mail = await render('![Bild]({{ app.url }}/x.png)')
    expect(mail.html).not.toContain('<img')
  })

  it('refuses unknown variables and filters outside the set', async () => {
    await expect(render('{{ nope }}')).rejects.toThrow(TemplateError)
    await expect(render('{{ recipient.password }}')).rejects.toThrow(TemplateError)
    await expect(render('{{ recipient.givenName | raw }}')).rejects.toThrow(/raw/)
    await expect(render('{{ recipient.givenName | url_encode }}')).rejects.toThrow(TemplateError)
    await expect(render('{{ recipient.givenName | upcase }}')).resolves.toMatchObject({ text: expect.stringContaining('ERIKA') })
  })

  it('cannot include files', async () => {
    await expect(render("{% include '/etc/passwd' %}")).rejects.toThrow(TemplateError)
    await expect(render("{% render 'x' %}")).rejects.toThrow(TemplateError)
  })

  it('bounds how much a template may render', async () => {
    await expect(render('{% for i in (1..100000000) %}{{ i }}{% endfor %}')).rejects.toThrow(TemplateError)
  })

  it('formats dates and numbers for the locale, in the university time zone', async () => {
    const variables = { recipient, app, at: '2026-09-28T22:30:00.000Z', n: 1234.5 }
    const body = '{{ at | date }} / {{ at | datetime }} / {{ n | number }}'
    const de = await renderMail({ locale: 'de', subject: 's', body, variables })
    const en = await renderMail({ locale: 'en', subject: 's', body, variables })
    expect(de.text).toContain('29. September 2026 / 29. September 2026 um 00:30 / 1.234,5')
    expect(en.text).toContain('September 29, 2026 / September 29, 2026 at 12:30 AM / 1,234.5')
    await expect(renderMail({ locale: 'de', subject: 's', body: '{{ n | date }}x{{ "x" | date }}', variables })).rejects.toThrow(/not a date/)
  })

  it('names the line of a Liquid error', async () => {
    await expect(render('eins\n\nzwei {{ nope }}')).rejects.toMatchObject({ line: 3 })
  })
})

describe('templateVariablePaths', () => {
  it('lists the paths a template reads, not the loop variables', () => {
    const paths = templateVariablePaths(
      'de',
      'body',
      '{{ recipient.givenName }}\n{% for d in documents %}{{ d.title }}{% endfor %}\n{{ documents.size }}'
    )
    expect(paths).toEqual(
      expect.arrayContaining([
        { segments: ['recipient', 'givenName'], line: 1 },
        { segments: ['documents'], line: 2 },
        { segments: ['documents', 'size'], line: 3 }
      ])
    )
    expect(paths.some((path) => path.segments[0] === 'd')).toBe(false)
  })
})

describe('escapeMarkdown', () => {
  it('escapes every ASCII punctuation character and joins lines', () => {
    expect(escapeMarkdown('a_b*c\n#d')).toBe('a\\_b\\*c \\#d')
  })
})
