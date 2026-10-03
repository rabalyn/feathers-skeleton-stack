# @app/feathers-pinia

A vendored fork of [feathers-pinia](https://github.com/marshallswain/feathers-pinia) 4.5.4 (commit `de1d7db`, 2025-08-10), ported to Pinia 4, Vue 3.5 and TypeScript 6 (ADR 0014). Private to this workspace and never published.

Upstream's documentation applies: <https://feathers-pinia.pages.dev>. Import from `@app/feathers-pinia` instead of `feathers-pinia`.

## License

Upstream states "MIT Licensed" on its documentation site. The repository has no LICENSE file and its `package.json` has no `license` field. Copyright remains with the upstream authors.

## Changes from upstream

What the port needed, and bug fixes this project ran into, each with a test marked "Not upstream"; nothing else, so that upstream fixes can still be compared:

- Dependencies: `vue-demi` and the `@vue/composition-api` peer dropped; peers `pinia` ^4 and `vue` ^3.5; `@vueuse/core` ^15; unused runtime dependencies (`lz-string`, `bson-objectid`, `events`) dropped; `@feathersjs/rest-client` moved from optional to regular dependency; test dependencies updated, including `@faker-js/faker` 10 (8 has a high-severity advisory) and the missing `@feathersjs/errors`, which the fixtures import.
- `from 'vue-demi'` is now `from 'vue'`. Vue 2's `set` and `del`, which `vue-demi` re-exported, are replaced by `src/utils/vue2-compat.ts`.
- `MaybeRef` is imported from `vue`, not `@vueuse/core`.
- `moduleResolution: "bundler"`, because TypeScript 6 deprecates `"node"`. The package is built with `tsc` into `dist/` (ESM and declarations) instead of upstream's Vite library build.
- `src/stores/local-queries.ts`: a dead `|| {}` after an object spread removed, and one cast added in `createInStore`.
- Tests, for Vitest 5: `mock.results` is now `mock.settledResults` for async mocks, and `tests/localstorage/storage-sync.test.ts` captures the store's module-level storage read before Vitest clears mock history between tests. The four `useGet` tests upstream skips without a reason (`tests/use-find-get/use-get.test.ts`: changing id, previous record while loading, `queryWhen`, disabled watch) run, and pass, against the fork.
- `useFind` (`src/use-find-get/use-find.ts`): a request it starts by itself, from its params watcher or a service event, keeps a failure in `error` instead of leaving an unhandled promise rejection, as `useGet` already does. A `find()` call still rejects to its caller. Upstream's version showed as an uncaught error whenever such a refetch failed, for instance on a socket whose session had just ended.
- `useFind` (`src/use-find-get/use-find.ts`): with `paginateOn: 'server'`, the `created`, `patched` and `removed` listeners it registers on the service are removed when the effect scope that created it (usually a component) is disposed. Upstream never removed them, so every mounted `useFind` kept re-querying after its component was gone, and the listeners accumulated with each remount. Outside an effect scope the listeners stay, as upstream.
- `useFind` (`src/use-find-get/use-find.ts`): without `pagination` refs in its options, a new `$limit` or `$skip` in its params moves its `limit` and `skip`. Upstream only seeded them from the first params and replaced the params' values with them, so a server-paginated table that pages through its params fetched its first page again on every page turn.
- `useFind` (`src/use-find-get/use-find.ts`): `data` and `total` move to new params only once those have been answered, or their page is already in the store. Upstream moved them when any debounced call resolved, including one the debounce had cancelled without a request, so turning pages quickly showed an empty page with a total of 0 until the answer came (a paginated QTable then reset itself to page 1).
- `useFind` (`src/use-find-get/use-find.ts`): with `paginateOn: 'server'`, an `isRelevant(event, item, data)` option decides whether a `created`, `patched` or `removed` event re-queries, given the event's record and the records shown. Without it every event re-queries, as upstream; upstream's "only re-query when relevant" TODO is not done by matching the record against the query locally, because that misses filters only the server understands (a field the record does not carry) and records a patch moves onto the page. An `isRelevant` that throws re-queries.
- `src/stores/local-queries.ts`: `patchInStore(null, data)` refuses a missing query as it refused an empty one; it patched every record in the store.
- `src/create-pinia-service.ts`: the service's data type was read from `create(data[])`, but TypeScript infers from the last overload only, which on a `ClientService` is `create(data)`, so it came out as `never`. The helper types (`SvcResult`, `SvcParams`, `SvcData`, `SvcPatchData`) are exported and tested in `tests/vue-service/service-types.test-d.ts`; `patchInStore`'s query overload takes params, not patch data.

As upstream does, only `src/` is typechecked by `pnpm typecheck`; the tests run under Vitest, which also typechecks the `*.test-d.ts` type tests (`tsconfig.test.json`).
