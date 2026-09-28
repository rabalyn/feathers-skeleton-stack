import { computed, effectScope, ref } from 'vue'
import { api, makeContactsData } from '../fixtures/index.js'
import { resetService, timeout } from '../test-utils.js'

const service = api.service('contacts')

beforeEach(async () => {
  resetService(service)
  service.service.store = makeContactsData()
})
afterEach(() => resetService(service))

describe('paginateOn: server', () => {
  test('paginateOn: server enables server requests', async () => {
    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })
    const contacts$ = service.useFind(params, { paginateOn: 'server' })
    expect(contacts$.haveBeenRequested).toBe(true)
    expect(contacts$.data.length).toBe(0)

    await contacts$.request
    expect(contacts$.data.length).toBe(3)
  })

  test('paginateOn: server with `immediate` false', async () => {
    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })
    const contacts$ = service.useFind(params, { paginateOn: 'server', immediate: false })
    expect(contacts$.haveBeenRequested).toBe(false)

    await contacts$.request
    expect(contacts$.data.length).toBe(0)
  })

  test('use `queryWhen` to control queries', async () => {
    const params = computed(() => {
      return {
        query: { $limit: 3, $skip: 0 },
        qid: 'test',
      }
    })
    const contacts$ = service.useFind(params, {
      paginateOn: 'server',
    })

    // run the query if we don't already have items.
    contacts$.queryWhen(() => {
      if (!contacts$.currentQuery || !contacts$.currentQuery.items.length)
        return true

      return false
    })

    await contacts$.request
    expect(contacts$.requestCount).toBe(1)

    // Will make another request, since we don't have the page
    await contacts$.next()
    expect(contacts$.requestCount).toBe(2)

    // no request will be made, since we already have data for this page
    await contacts$.prev()
    expect(contacts$.requestCount).toBe(2)
  })

  test('loading indicators during server pagination', async () => {
    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })
    const contacts$ = service.useFind(params, {
      paginateOn: 'server',
    })
    expect(contacts$.isPending).toBe(true)
    expect(contacts$.haveLoaded).toBe(false)
    expect(contacts$.haveBeenRequested).toBe(true)

    await contacts$.request

    expect(contacts$.isPending).toBe(false)
    expect(contacts$.haveLoaded).toBe(true)
    expect(contacts$.haveBeenRequested).toBe(true)

    await contacts$.next()
    expect(contacts$.skip).toBe(3)
  })

  test('errors populate during server pagination, manually clear error', async () => {
    // Throw an error in a hook
    let hasHookRun = false
    const hook = () => {
      if (!hasHookRun) {
        hasHookRun = true
        throw new Error('fail')
      }
    }
    service.hooks({ before: { find: [hook] } })

    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })

    const contacts$ = service.useFind(params, { paginateOn: 'server', immediate: false })
    expect(contacts$.error).toBe(null)
    try {
      expect(await contacts$.find()).toThrow()
    }
    catch (err: any) {
      expect(err.message).toBe('fail')
      expect(contacts$.error.message).toBe('fail')

      contacts$.clearError()

      expect(contacts$.error).toBe(null)
    }
  })

  test('errors populate during server pagination, auto-clear error', async () => {
    // Throw an error in a hook
    let hasHookRun = false
    const hook = () => {
      if (!hasHookRun) {
        hasHookRun = true
        throw new Error('fail')
      }
    }
    service.hooks({ before: { find: [hook] } })

    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })
    const contacts$ = service.useFind(params, { paginateOn: 'server', immediate: false })
    expect(contacts$.error).toBe(null)

    try {
      expect(await contacts$.find()).toThrow()
    }
    catch (err: any) {
      expect(err.message).toBe('fail')
      expect(contacts$.error.message).toBe('fail')

      await contacts$.find()

      expect(contacts$.error).toBe(null)
    }
  })

  // Not upstream: a request the watcher or a service event starts has no
  // caller, so its failure lands in `error` and is not left unhandled.
  test('failed requests started by the params watcher or an event only populate error', async () => {
    // Hooks stay on the shared service: this one is switched off at the end.
    let failing = true
    const hook = () => {
      if (failing)
        throw new Error('fail')
    }
    service.hooks({ before: { find: [hook] } })

    try {
      const skip = ref(0)
      const params = computed(() => {
        return { query: { $limit: 3, $skip: skip.value } }
      })
      const contacts$ = service.useFind(params, { paginateOn: 'server', debounce: 0 })
      await timeout(50)
      expect(contacts$.error.message).toBe('fail')

      contacts$.clearError()
      skip.value = 3
      await timeout(50)
      expect(contacts$.error.message).toBe('fail')

      contacts$.clearError()
      service.emit('created', {})
      await timeout(50)
      expect(contacts$.error.message).toBe('fail')
    }
    finally {
      failing = false
    }
  })
})

// Not upstream: with `paginateOn: 'server'`, each useFind listens to the
// service's created/patched/removed events and re-queries. The listeners live
// as long as the effect scope (component) that created the useFind. Upstream
// never removed them.
describe('paginateOn: server, service event listeners', () => {
  const events = ['created', 'patched', 'removed'] as const
  const listenerCounts = () => events.map(event => service.service.listenerCount(event))
  const params = computed(() => {
    return { query: { $limit: 3, $skip: 0 } }
  })
  const useFindIn = (scope: ReturnType<typeof effectScope>, paginateOn: 'server' | 'client' | 'hybrid' = 'server') =>
    scope.run(() => service.useFind(params, { paginateOn, debounce: 0 }))!

  test.each(events)('a live useFind re-queries on `%s`', async (event) => {
    const scope = effectScope()
    const contacts$ = useFindIn(scope)
    await contacts$.request
    expect(contacts$.requestCount).toBe(1)

    service.emit(event, {})
    await contacts$.request
    expect(contacts$.requestCount).toBe(2)
    scope.stop()
  })

  test('each useFind registers one listener per event, and disposing its scope removes them', async () => {
    const before = listenerCounts()
    const scope = effectScope()
    const contacts$ = useFindIn(scope)
    await contacts$.request
    expect(listenerCounts()).toEqual(before.map(count => count + 1))

    scope.stop()
    expect(listenerCounts()).toEqual(before)
  })

  test('a disposed useFind no longer re-queries on any event', async () => {
    const scope = effectScope()
    const contacts$ = useFindIn(scope)
    await contacts$.request
    scope.stop()

    for (const event of events)
      service.emit(event, {})
    await timeout(50)
    expect(contacts$.requestCount).toBe(1)
  })

  test('remounting does not accumulate listeners', async () => {
    const before = listenerCounts()
    for (let i = 0; i < 5; i++) {
      const scope = effectScope()
      await useFindIn(scope).request
      scope.stop()
    }
    expect(listenerCounts()).toEqual(before)
  })

  test('disposing one useFind leaves another on the same service listening', async () => {
    const disposed = effectScope()
    const live = effectScope()
    const disposed$ = useFindIn(disposed)
    const live$ = useFindIn(live)
    await Promise.all([disposed$.request, live$.request])

    disposed.stop()
    service.emit('created', {})
    await live$.request
    await timeout(50)
    expect(live$.requestCount).toBe(2)
    expect(disposed$.requestCount).toBe(1)
    live.stop()
  })

  test('outside an effect scope the listeners stay and work, without a Vue warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = listenerCounts()
      const contacts$ = service.useFind(params, { paginateOn: 'server', debounce: 0 })
      await contacts$.request
      expect(listenerCounts()).toEqual(before.map(count => count + 1))

      service.emit('created', {})
      await contacts$.request
      expect(contacts$.requestCount).toBe(2)
      expect(warn).not.toHaveBeenCalled()

      // No scope to dispose: remove this test's listeners by hand so they do
      // not re-query during later tests.
      for (const event of events) {
        const listeners = service.service.listeners(event)
        service.service.removeListener(event, listeners[listeners.length - 1])
      }
      expect(listenerCounts()).toEqual(before)
    }
    finally {
      warn.mockRestore()
    }
  })

  test.each(['client', 'hybrid'] as const)('paginateOn: %s registers no listeners', async (paginateOn) => {
    const before = listenerCounts()
    const scope = effectScope()
    useFindIn(scope, paginateOn)
    expect(listenerCounts()).toEqual(before)
    scope.stop()
  })
})

describe('latestQuery and previousQuery', () => {
  test('paginateOn: server stores latestQuery and previousQuery', async () => {
    const params = computed(() => {
      return { query: { $limit: 3, $skip: 0 } }
    })
    const contacts$ = service.useFind(params, {
      paginateOn: 'server',
      immediate: false,
    })

    expect(contacts$.latestQuery).toBe(null)

    await contacts$.find()

    const keys = [
      'qid',
      'query',
      'queryId',
      'queryParams',
      'pageParams',
      'pageId',
      'isExpired',
      'ids',
      'items',
      'total',
      'queriedAt',
      'queryState',
      'ssr',
    ]

    expect(Object.keys(contacts$.latestQuery as any)).toEqual(keys)
    expect(contacts$.previousQuery).toBe(null)

    await contacts$.next()

    expect(Object.keys(contacts$.latestQuery as any)).toEqual(keys)
    expect(Object.keys(contacts$.previousQuery as any)).toEqual(keys)
  })

  describe('Has `allLocalData`', () => {
    test('allLocalData contains all stored data', async () => {
      const _params = computed(() => {
        return { query: { $limit: 4, $skip: 0 } }
      })
      const contacts$ = service.useFind(_params, { paginateOn: 'server' })
      await contacts$.find()
      await contacts$.next()
      expect(contacts$.allLocalData.length).toBe(8)
    })

    test('shows current data while loading new data', async () => {
      // A hook to cause a delay so we can check pending state
      let hasHookRun = false
      const hook = async () => {
        if (!hasHookRun) {
          hasHookRun = true
          await timeout(50)
        }
      }
      service.hooks({ before: { find: [hook] } })
      const params = computed(() => {
        return { query: { $limit: 4, $skip: 0 } }
      })
      const contacts$ = service.useFind(params, {
        paginateOn: 'server',
        immediate: false,
      })
      await contacts$.find()

      const idsFromFirstPage = contacts$.data.map(i => i._id)
      expect(idsFromFirstPage).toEqual(['1', '2', '3', '4'])

      contacts$.next()

      expect(contacts$.isPending).toBe(true)

      await timeout(0)

      const idsWhilePending = contacts$.data.map(i => i._id)
      expect(idsWhilePending).toEqual(idsFromFirstPage)

      await contacts$.request

      const idsAfterRequest = contacts$.data.map(i => i._id)
      expect(idsAfterRequest).not.toEqual(idsFromFirstPage)
      expect(idsAfterRequest).not.toEqual(idsWhilePending)
    }, 400000)
  })

  test('return null from computed params to prevent a request', async () => {
    const shouldQuery = ref(true)
    const name = ref('Moose')

    const params = computed(() => {
      if (!shouldQuery.value)
        return null
      return { query: { name } }
    })
    const contacts$ = service.useFind(params, { paginateOn: 'server' })

    await contacts$.request

    expect(contacts$.data.length).toBe(1)
    expect(contacts$.requestCount).toBe(1)

    shouldQuery.value = false
    name.value = 'Goose'

    await contacts$.request

    // no request send because params were null
    expect(contacts$.requestCount).toBe(1)

    shouldQuery.value = true

    // wait for watcher to update the `request`
    await timeout(0)
    await contacts$.request

    expect(contacts$.requestCount).toBe(2)
  })
})
