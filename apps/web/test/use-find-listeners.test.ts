// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type * as socketIo from 'socket.io-client'
import { Socket, type ManagerOptions, type SocketOptions } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { createApi, socket, type Api } from '@/api/feathers'

// Server-paginated lists re-query on the service's realtime events, and a
// component's list must stop listening when the component goes away
// (packages/feathers-pinia README, "Changes from upstream"). These tests
// mount real components against the app's own client (createApi): the
// socket.io Socket is real but never connects, requests are answered here,
// and server events are injected through the socket's own emitter.

vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof socketIo>()
  return { ...actual, io: (opts?: Partial<ManagerOptions & SocketOptions>) => actual.io({ ...opts, autoConnect: false }) }
})

const PATH = 'data-exports'
const EVENTS = ['created', 'patched', 'removed'] as const
const DEBOUNCE = 100

// Requests the client sent for PATH, by method.
let sent: string[] = []
const finds = () => sent.filter((method) => method === 'find').length

// Listeners on the socket for PATH's events; the service stores register
// theirs too, so tests compare against a baseline.
const listenerCounts = () => EVENTS.map((event) => socket.listeners(`${PATH} ${event}`).length)

// An event as the server would push it: a connected Socket hands incoming
// events to the emitter it extends, which is what this calls.
const emitter = Object.getPrototypeOf(Socket.prototype) as { emit: (event: string, ...args: unknown[]) => unknown }
const receive = (event: (typeof EVENTS)[number]) => emitter.emit.call(socket, `${PATH} ${event}`, { id: 'e1', state: 'done' })

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 2))
  await flushPromises()
}

let api: Api
let baseline: number[]

beforeEach(() => {
  sent = []
  vi.spyOn(socket, 'emit').mockImplementation(((method: string, path: string, ...args: unknown[]) => {
    const ack = args.at(-1) as ((error: null, result: unknown) => void) | undefined
    if (path === PATH) sent.push(method)
    ack?.(null, { total: 0, limit: 5, skip: 0, data: [] })
    return socket
  }) as typeof socket.emit)
  api = createApi(createPinia())
  api.service(PATH)
  baseline = listenerCounts()
})

afterEach(() => {
  vi.restoreAllMocks()
  socket.removeAllListeners()
})

// A list as the app's components have one (DataExports.vue).
const ExportList = defineComponent({
  setup() {
    const params = computed(() => ({ query: { $limit: 5 } }))
    const list = api.service(PATH).useFind(params, { paginateOn: 'server' })
    return () => h('ul', list.data.map(() => h('li')))
  }
})

describe('useFind with paginateOn: server in a component', () => {
  it('re-queries on each event while mounted, and stops listening on unmount', async () => {
    const wrapper = mount(ExportList)
    await settle()
    expect(finds()).toBe(1)
    expect(listenerCounts()).toEqual(baseline.map((count) => count + 1))

    for (const event of EVENTS) {
      receive(event)
      await settle()
    }
    expect(finds()).toBe(1 + EVENTS.length)

    wrapper.unmount()
    expect(listenerCounts()).toEqual(baseline)

    for (const event of EVENTS) receive(event)
    await settle()
    expect(finds()).toBe(1 + EVENTS.length)
  })

  it('does not accumulate listeners when shown and hidden repeatedly', async () => {
    const shown = ref(true)
    const wrapper = mount(defineComponent({ setup: () => () => (shown.value ? h(ExportList) : h('p')) }))
    await settle()

    for (let i = 0; i < 5; i++) {
      shown.value = false
      await nextTick()
      shown.value = true
      await nextTick()
    }
    await settle()
    expect(listenerCounts()).toEqual(baseline.map((count) => count + 1))

    // One event, one list on screen: one request.
    sent = []
    receive('created')
    await settle()
    expect(finds()).toBe(1)

    wrapper.unmount()
    expect(listenerCounts()).toEqual(baseline)
  })

  it('stops listening when the router navigates away from the page', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/exports', component: ExportList },
        { path: '/elsewhere', component: defineComponent({ render: () => h('p') }) }
      ]
    })
    await router.push('/exports')
    const wrapper = mount(RouterView, { global: { plugins: [router] } })
    await settle()
    expect(listenerCounts()).toEqual(baseline.map((count) => count + 1))

    await router.push('/elsewhere')
    await flushPromises()
    expect(listenerCounts()).toEqual(baseline)

    sent = []
    receive('created')
    await settle()
    expect(finds()).toBe(0)

    await router.push('/exports')
    await settle()
    expect(listenerCounts()).toEqual(baseline.map((count) => count + 1))
    wrapper.unmount()
  })
})
