import { api, localStorageMock } from '../fixtures/index.js'
import { resetService, timeout } from '../test-utils.js'

const service = api.service('contacts')

// The store reads storage once, when the service is set up. Vitest clears
// mock history before each test, so the read is captured here.
const getItemCalls = [...(localStorageMock.getItem as any).mock.calls]

const reset = () => resetService(service)

describe('Storage Sync', () => {
  beforeEach(() => {
    reset()
  })

  test('writes to storage', async () => {
    const msg = service.createInStore({ name: 'test' })
    await timeout(600)
    expect(localStorageMock.setItem).toHaveBeenCalled()
    const [key, value] = (localStorageMock.setItem as any).mock.calls[0]
    expect(key).toBe('service:contacts')
    const val = JSON.parse(value)
    expect(val.tempsById[msg.__tempId]).toBeTruthy()
  })

  test('reads from storage', async () => {
    service.createInStore({ name: 'test2' })
    await timeout(1000)
    expect(getItemCalls.length).toBeGreaterThan(0)
    const [key, value] = getItemCalls[0]
    expect(key).toBe('service:contacts')
    expect(value).toBeUndefined()
  })
})
