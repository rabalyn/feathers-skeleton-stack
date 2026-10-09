import { expect, test, type Page } from '@playwright/test'
import { adminApi, type AdminApi } from './admin-api.js'
import { loginAs, nav, type Account } from './support.js'
import { WALK_FIXTURES } from './walk-fixtures.js'

// The gate walk (ADR 0038): for every permission of the catalogue, the
// skeleton's and the product's, as the fixed admin's own record lists it
// (ADR 0011), the walk account holds a role with that
// permission alone, besides `everyone`, which every account holds. It opens
// every page its navigation shows, and where a route says so the first
// record's panel. No call may be refused (401, 403, 404) and no failure
// notice may show: what a page offers, the permission makes work.
//
// The walk account wk01walk is the walk's alone (containers/ldap/seed/
// walker.ldif). Records a panel needs are made first by the fixture its
// route names (walk-fixtures.ts).

const WALKER: Account = { tuId: 'wk01walk', password: 'walk-test-password' }
const ROLE = { key: 'e2e-walk', name: { de: 'E2E-Rundgang', en: 'E2E walk' } }

// Socket.io packets (the API's transport, ADR 0012): `42<id>[method, path,
// ...]` asks with an acknowledgement, `43<id>[error, result]` answers it.
const ASK = /^42(\d+)\[\s*"([^"]+)"\s*,\s*"([^"]+)"/
const ANSWER = /^43(\d+)(\[.*)$/s

interface Watch {
  // The calls open on the page's current socket.
  pending: Map<string, string>
  refused: string[]
}

// Every call the page makes on its current socket, and those refused. A
// role change ends the connection (ADR 0012) and a reload opens a new one:
// what was open on an earlier socket is never answered and is dropped.
const watchCalls = (page: Page): Watch => {
  const watch: Watch = { pending: new Map(), refused: [] }
  page.on('websocket', (socket) => {
    watch.pending = new Map()
    const pending = watch.pending
    socket.on('framesent', ({ payload }) => {
      const ask = typeof payload === 'string' ? ASK.exec(payload) : null
      if (ask) pending.set(ask[1]!, `${ask[2]} ${ask[3]}`)
    })
    socket.on('framereceived', ({ payload }) => {
      const answer = typeof payload === 'string' ? ANSWER.exec(payload) : null
      if (!answer) return
      const call = pending.get(answer[1]!)
      pending.delete(answer[1]!)
      let error: { code?: number; message?: string } | null | undefined
      try {
        error = (JSON.parse(answer[2]!) as [{ code?: number; message?: string } | null])[0]
      } catch {
        return
      }
      if (error && [401, 403, 404].includes(error.code ?? 0)) watch.refused.push(`${call ?? '?'}: ${error.code} ${error.message ?? ''}`)
    })
  })
  return watch
}

// Until no call has been open for a moment; the calls still open after
// that are reported.
const settle = async (page: Page, watch: Watch): Promise<string[]> => {
  let quiet = 0
  for (let waited = 0; waited < 15_000 && quiet < 3; waited += 200) {
    await page.waitForTimeout(200)
    quiet = watch.pending.size ? 0 : quiet + 1
  }
  return quiet < 3 ? [...watch.pending.values()].map((call) => `unanswered: ${call}`) : []
}

const failureNotices = async (page: Page) =>
  (await page.locator('.q-notification.bg-negative').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim())

let admin: AdminApi
let walker: Page
let calls: Watch
let roleId: string
const fixturesMade = new Set<string>()

test.beforeAll(async ({ browser }) => {
  admin = await adminApi(browser)
  const existing = (await admin.call<{ data: { id: string }[] }>(`/roles?key=${ROLE.key}`)).data[0]
  roleId = existing
    ? (await admin.call<{ id: string }>(`/roles/${existing.id}`, { method: 'PATCH', body: { name: ROLE.name, permissions: [] } })).id
    : (await admin.call<{ id: string }>('/roles', { method: 'POST', body: { ...ROLE, permissions: [] } })).id
  walker = await (await browser.newContext()).newPage()
  calls = watchCalls(walker)
  // The first login makes the account (ADR 0009), which then gets the role.
  const { user } = await loginAs(walker, WALKER)
  await admin.call(`/user-roles/${user.id}`, { method: 'PATCH', body: { roleIds: [roleId] } })
})

test.afterAll(async () => {
  await admin?.call(`/roles/${roleId}`, { method: 'PATCH', body: { permissions: [] } }).catch(() => undefined)
  await admin?.close()
})

// What went wrong on the page shown: refused calls, calls left open, and
// failure notices; then the same for its first record's panel where its
// route asks for one, after making the record its route names.
const checkPage = async (label: string, reopen: () => Promise<void>): Promise<string[]> => {
  let problems = (await settle(walker, calls)).map((each) => `${label}: ${each}`)
  const container = walker.locator('.q-page-container')
  const fixture = await container.getAttribute('data-walk-fixture')
  if (fixture && !fixturesMade.has(fixture)) {
    const make = WALK_FIXTURES[fixture]
    if (!make) return [`${label}: no walk fixture ${fixture}`]
    await make(admin)
    fixturesMade.add(fixture)
    await reopen()
    problems = (await settle(walker, calls)).map((each) => `${label}: ${each}`)
  }
  problems.push(...calls.refused.map((refusal) => `${label}: ${refusal}`))
  if ((await container.getAttribute('data-walk-panel')) !== null) {
    const row = walker.locator('[data-walk="list"]').locator('tbody tr:not(.q-tr--no-data), .q-item').first()
    if (await row.count()) {
      calls.refused.length = 0
      await row.click()
      problems.push(...(await settle(walker, calls)).map((each) => `${label} (panel): ${each}`))
      problems.push(...calls.refused.map((refusal) => `${label} (panel): ${refusal}`))
    } else {
      problems.push(`${label}: no record to open the panel of`)
    }
  }
  problems.push(...(await failureNotices(walker)).map((notice) => `${label}: notice "${notice}"`))
  return problems
}

// Loads the app afresh at this path, with no call refused yet.
const load = async (path: string) => {
  await walker.goto('about:blank')
  calls.refused.length = 0
  await walker.goto(path)
  await expect(walker.getByRole('heading', { level: 1 })).toBeVisible()
}

const walkWith = async (permissions: readonly string[]) => {
  // Away from the app first, so the open page does not answer the change.
  await walker.goto('about:blank')
  await admin.call(`/roles/${roleId}`, { method: 'PATCH', body: { permissions } })
  await load('/profile')
  const start = new URL(walker.url()).pathname
  const problems = await checkPage(start, () => load(start))
  const hrefs = await nav(walker)
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')!))
  for (const href of hrefs.filter((each) => each !== start)) {
    const open = async () => {
      calls.refused.length = 0
      await nav(walker).locator(`a[href="${href}"]`).click()
      await expect(walker).toHaveURL((url) => url.pathname.startsWith(href))
    }
    await open()
    problems.push(...(await checkPage(href, () => load(href))))
  }
  expect.soft(problems, `holding ${permissions.join(', ') || 'nothing but everyone'}`).toEqual([])
}

test('every page `everyone` alone reaches works', async () => {
  await walkWith([])
})

// One permission after another, each reported on its own. The catalogue is
// read off the admin's record, so a product's permissions are walked too.
test('every page a single permission reaches works', async () => {
  const catalogue = admin.user.permissions.filter((key) => key !== 'roles.manage')
  expect(catalogue.length).toBeGreaterThan(0)
  test.setTimeout(catalogue.length * 30_000)
  for (const key of catalogue) await walkWith([key])
})
