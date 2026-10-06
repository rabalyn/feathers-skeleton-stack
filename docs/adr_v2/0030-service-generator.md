# 0030: New services are scaffolded by a project-local generator

- Status: Accepted
- Date: 2026-09-30
- Scope: Required (v1)
- Related: [0003](0003-postgresql-and-knex.md), [0005](0005-typebox-schema-boundary.md), [0006](0006-feathersjs-typescript-api.md), [0007](0007-typed-client-from-api.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0015](0015-testing-vitest-playwright.md), [0035](0035-products-derived-from-the-skeleton.md)

## Context

Every service so far was written by hand, following the Feathers v5 idiom as these ADRs adapt it, with the nearest existing service as the template. That works, but each new service re-derives the conventions from a neighbour, and a drift is caught in review or not at all.

The stock generator, `@feathersjs/cli`, does not fit this application. Run against it (5.0.50), it refuses to start without `feathers` metadata in `package.json`; with that added, it stops half-way through `client.ts` for want of an import line it anchors on. With that faked as well, what it emits contradicts accepted decisions: relative imports without `.js`, which `NodeNext` rejects; a numeric `id` and a kebab-case table from the schema builder ([0003](0003-postgresql-and-knex.md), [0009](0009-tu-id-identity-model.md)); a patch schema that accepts every field, `id` included ([0005](0005-typebox-schema-boundary.md)); `authenticate('jwt')` per service beside the default-deny boundary ([0011](0011-casl-role-authorization.md)); a `*.shared.ts` module the client entry point imports at runtime, across the dependency boundary ([0007](0007-typed-client-from-api.md)); Mocha tests ([0015](0015-testing-vitest-playwright.md)); and Prettier run over every file it touches. Adapting the application to the generator would still leave every generated service to be rewritten.

## Decision

- New services are created with **`pnpm gen:service --name <path> [--type knex|custom] [--singular <name>]`**, a generator in `apps/api/generators/` built on **pinion**, the library `@feathersjs/cli` itself is built on. `@feathersjs/cli` is not used.
- The path is plural kebab-case, like every existing one; the record type is its singular. Two types:
  - **`knex`** (the default): a table-backed service. Data, patch, query and result schemas with `additionalProperties: false`, a `KnexService` on the shared pagination, a raw-SQL migration with a `uuidv7()` key that rolls forward only ([0003](0003-postgresql-and-knex.md)), and events to whoever reads every record ([0012](0012-role-scoped-channels.md)).
  - **`custom`**: an action asked for with `create`, like `erasures`, without a table. Its result goes to the caller only.
- Beside the service's own files and a Vitest integration test, the generator registers the service in `services/index.ts`, adds it to the client's types in `client.ts` as type-only imports ([0007](0007-typed-client-from-api.md)), adds one `<path>.manage` permission to the catalogue in `abilities.ts` ([0011](0011-casl-role-authorization.md)), and labels that permission in every locale of the web app with placeholder wording to be reviewed. It writes at marker lines, `// gen:service <slot> (ADR 0030)`, which stay in those files for the next service. It checks all of that before writing anything, and writes nothing if any check fails.
- **Where it registers follows `product.env`** ([0035](0035-products-derived-from-the-skeleton.md)): when `PRODUCT` is `feathers-skeleton`, in the skeleton's own `services/index.ts`, `client.ts`, `abilities.ts` and web catalogues; in a product, in the product module, `src/product/services.ts`, `src/product/client.ts`, `src/product/permissions.ts` and `apps/web/src/i18n/product/`, adding the imports those files start without. A name is checked against both sets of files. Decided 2026-10-06.
- It leaves out what needs judgement and prints it as a checklist instead: finer permissions than `<path>.manage`, granting the permission to a seeded role, and personal data, which belongs in the registry and in `erase_user()` ([0013](0013-gdpr-export-and-retention.md)).
- A generated file is a starting point owned by whoever generated it. Nothing is regenerated over it.
- **Every service names its publisher.** Feathers sends the events of a service without one to nobody, which is safe but silent. A service whose results go to the caller only says so with `publishNothing` from `channels.ts` ([0012](0012-role-scoped-channels.md)).
- Three checks keep this true:
  - the **drift check**, `pnpm --filter @app/api gen:check`, a static CI check, generates one service of each type into a copy of the repository's files and typechecks the result, unused locals included, once as the skeleton and once as a product;
  - a unit test holds that every data and patch schema a service exports sets `additionalProperties: false` ([0005](0005-typebox-schema-boundary.md));
  - an integration test holds that every registered service has a publisher.
- Using the generator is required by this ADR, not enforced mechanically: the two convention tests hold what matters of its output for every service, generated or not.

## Consequences

- A new service starts in line with [0005](0005-typebox-schema-boundary.md), [0007](0007-typed-client-from-api.md), [0011](0011-casl-role-authorization.md) and [0012](0012-role-scoped-channels.md), typechecks, and has a passing test before any product code is written.
- The templates are a second place where the conventions live. A change to a convention changes the templates in the same change. The drift check catches templates that no longer compile, not ones that compile but show an outdated pattern.
- Four of the skeleton's files and three of the product module's carry marker lines. Removing one makes the generator refuse to run, with the reason.
- The generated permission labels are placeholders. Unreviewed, they reach the permissions page as they are.
- The API package gains a development dependency on pinion, and through it on `tsx`, `inquirer` and `commander`. None of it reaches the runtime image, which installs production dependencies only.
