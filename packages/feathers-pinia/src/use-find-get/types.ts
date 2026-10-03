import type { Ref } from 'vue'
import type { AnyData, Params, Query } from '../types.js'
import type { MostRecentQuery, PaginationStateQuery } from '../stores/types'

export interface UseFindPage {
  limit: Ref<number>
  skip: Ref<number>
}

export interface UseFindGetDeps {
  service: any
}

export interface UseFindParams extends Params<Query> {
  query: Query
  qid?: string
}

export type UseFindEvent = 'created' | 'patched' | 'removed'

export interface UseFindOptions {
  paginateOn?: 'client' | 'server' | 'hybrid'
  pagination?: UseFindPage
  debounce?: number
  immediate?: boolean
  watch?: boolean
  /**
   * With `paginateOn: 'server'`, whether a service event can change the page,
   * given the event's record and the records shown now. Without it, every
   * event re-queries: only the caller knows its query's server-side meaning
   * (a filter the record does not carry, a sort a patch can move it by).
   */
  isRelevant?: (event: UseFindEvent, item: any, data: any[]) => boolean
}

export interface UseGetParams extends Params<Query> {
  query?: Query
  immediate?: boolean
  watch?: boolean
}

export interface CurrentQuery<M extends AnyData> extends MostRecentQuery {
  qid: string
  ids: number[]
  items: M[]
  total: number
  queriedAt: number
  queryState: PaginationStateQuery
}
