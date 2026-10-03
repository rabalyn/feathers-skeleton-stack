import type { ClientService, Paginated, Params, Service } from '@feathersjs/feathers'
import type { SvcData, SvcParams, SvcPatchData, SvcResult } from '../../src'

interface Result { id: number, name: string }
interface Data { name: string }
interface PatchData { name?: string }
interface Q { name?: string }

// Not upstream: SvcData came out as never for a ClientService.
// Both shapes the types are read from: the client's, with `create(data)` as
// its last overload, and the server's, with `create(data[])`.
type Client = Pick<ClientService<Result, Data, PatchData, Paginated<Result>, Params<Q>>, 'find' | 'get' | 'create' | 'patch' | 'remove'>
type Server = Service<Result, Data, Params<Q>, PatchData>

describe('service types', () => {
  it('reads a ClientService', () => {
    expectTypeOf<SvcResult<Client>>().toEqualTypeOf<Result>()
    expectTypeOf<SvcData<Client>>().toEqualTypeOf<Data>()
    expectTypeOf<SvcPatchData<Client>>().toEqualTypeOf<PatchData>()
    expectTypeOf<SvcParams<Client>>().toMatchTypeOf<Params<Q>>()
  })

  it('reads a Service', () => {
    expectTypeOf<SvcResult<Server>>().toEqualTypeOf<Result>()
    expectTypeOf<SvcData<Server>>().toEqualTypeOf<Data>()
    expectTypeOf<SvcPatchData<Server>>().toEqualTypeOf<PatchData>()
    expectTypeOf<SvcParams<Server>>().toMatchTypeOf<Params<Q>>()
  })
})
