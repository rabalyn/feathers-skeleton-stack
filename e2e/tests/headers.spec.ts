import { expect, test, type Browser, type Response } from '@playwright/test'
import { HTTP_PORT, origin } from '../playwright.config.js'
import { USER, loginAs } from './support.js'

// The response headers as a browser receives them through Nginx (ADR 0016,
// 0018, 0034): each one exactly once, the document CSP on the application's
// documents and static bundle only, none on API JSON, the api's own stricter
// policy alone on file bytes, and the base headers on the third-party UIs too.

// The same PNG as uploads.spec.ts: a real 1×1 red pixel.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082',
  'hex'
)

const HSTS = 'max-age=31536000; includeSubDomains'

// Every value a header has on the response, however many times it was sent.
const values = async (response: Response, name: string) =>
  (await response.headersArray()).filter((h) => h.name.toLowerCase() === name).map((h) => h.value)

const expectOnce = async (response: Response, name: string, value: string | RegExp) => {
  const found = await values(response, name)
  expect(found, name).toHaveLength(1)
  if (typeof value === 'string') expect(found[0], name).toBe(value)
  else expect(found[0], name).toMatch(value)
}

const expectBaseHeaders = async (response: Response) => {
  await expectOnce(response, 'strict-transport-security', HSTS)
  await expectOnce(response, 'x-content-type-options', 'nosniff')
  expect(await values(response, 'referrer-policy')).toHaveLength(1)
}

const expectApplicationHeaders = async (response: Response) => {
  await expectBaseHeaders(response)
  await expectOnce(response, 'referrer-policy', 'strict-origin-when-cross-origin')
  await expectOnce(response, 'permissions-policy', /camera=\(\)/)
  await expectOnce(response, 'cross-origin-opener-policy', 'same-origin')
}

const DOCUMENT_CSP = /^default-src 'self'; .*frame-ancestors 'none'/

test('documents carry the document policy once, with every security header once', async ({ page }) => {
  for (const path of ['/', '/a/client-side/route']) {
    const response = (await page.goto(path))!
    expect(response.status()).toBe(200)
    await expectApplicationHeaders(response)
    await expectOnce(response, 'content-security-policy', DOCUMENT_CSP)
    await expectOnce(response, 'cache-control', 'no-store')
  }
})

test('the static bundle is cached immutably, a missing asset is not', async ({ page }) => {
  const scripts: Response[] = []
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/assets/') && r.url().endsWith('.js')) scripts.push(r)
  })
  await page.goto('/')
  await expect.poll(() => scripts.length).toBeGreaterThan(0)
  const script = scripts[0]!
  await expectApplicationHeaders(script)
  await expectOnce(script, 'content-security-policy', DOCUMENT_CSP)
  await expectOnce(script, 'cache-control', 'public, max-age=31536000, immutable')

  // Asked for mid-deploy, say: a 404 must not be remembered for a year.
  const missing = (await page.goto('/assets/not-in-this-build.js'))!
  expect(missing.status()).toBe(404)
  await expectApplicationHeaders(missing)
  expect(await values(missing, 'cache-control')).toHaveLength(0)
})

test('API JSON carries the security headers but no content security policy', async ({ page }) => {
  for (const [path, status] of [
    ['/api/ping', 200],
    ['/api/no-such-service', 404]
  ] as const) {
    const response = (await page.goto(path))!
    expect(response.status()).toBe(status)
    await expectApplicationHeaders(response)
    expect(await values(response, 'content-security-policy'), path).toHaveLength(0)
  }
})

test('file bytes carry the api’s sandbox policy as their only policy', async ({ page }) => {
  await loginAs(page, USER, '/profile')
  const bytes = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/api/file-contents/'))
  await page.locator('input[type="file"][data-test="avatar-input"]').setInputFiles({
    name: 'ich.png',
    mimeType: 'image/png',
    buffer: PNG
  })
  const response = await bytes
  expect(response.status()).toBe(200)
  await expectApplicationHeaders(response)
  await expectOnce(response, 'content-security-policy', "default-src 'none'; sandbox")

  await page.getByRole('button', { name: 'Entfernen' }).click()
  await expect(page.getByText('Bild entfernt')).toBeVisible()
})

// The third-party UIs get the base headers only; a stricter Referrer-Policy
// of their own is kept.
test('the IdP, Mailpit and NetBox carry the base headers once, and none of the application’s', async ({ page }) => {
  for (const [url, referrer] of [
    [`${origin('idp')}/realms/feathers/`, 'no-referrer'],
    [`${origin('mail')}/`, 'no-referrer'],
    [`${origin('netbox')}/login/`, 'same-origin']
  ] as const) {
    const response = (await page.goto(url))!
    await expectBaseHeaders(response)
    await expectOnce(response, 'referrer-policy', referrer)
    expect(await values(response, 'permissions-policy'), url).toHaveLength(0)
    const csp = await values(response, 'content-security-policy')
    expect(csp.some((policy) => DOCUMENT_CSP.test(policy)), url).toBe(false)
  }
})

// A context that has never seen this origin's HSTS: otherwise the browser
// upgrades the request itself and Nginx is never asked.
const firstHop = async (browser: Browser, url: string) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const response = (await page.goto(url))!
  let request = response.request()
  while (request.redirectedFrom()) request = request.redirectedFrom()!
  const first = (await request.response())!
  const result = { status: first.status(), location: await first.headerValue('location') }
  await context.close()
  return result
}

test('plain HTTP redirects to the matched name over HTTPS', async ({ browser, baseURL }) => {
  const { hostname, port } = new URL(baseURL!)
  expect(await firstHop(browser, `http://${hostname}:${HTTP_PORT}/a/path?q=1`)).toEqual({
    status: 301,
    location: `https://${hostname}:${port}/a/path?q=1`
  })
})
