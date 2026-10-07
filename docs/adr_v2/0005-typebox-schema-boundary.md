# 0005: TypeBox schemas enforced at the Feathers service boundary

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0013
- Related: [0003](0003-postgresql-and-knex.md), [0006](0006-feathersjs-typescript-api.md), [0007](0007-typed-client-from-api.md), [0018](0018-owasp-security-baseline.md)

## Context

Requests arrive over REST and over WebSocket. Both must be validated identically, and the frontend should derive its types from the same definitions rather than a hand-maintained copy.

## Decision

- Every service defines TypeBox schemas for its **data** (create), **patch**, **query** and **result** shapes, via `@feathersjs/typebox`.
- Validation and resolution run as Feathers hooks at the service boundary. Because Feathers runs one hook pipeline for both transports, REST and WebSocket calls are validated by the same code with no duplication.
- TypeScript types are derived with `Static<>`. There is no code generation step.
- `additionalProperties: false` is the default on every data and patch schema. Unknown fields are rejected rather than ignored, which is the mass-assignment defence.
- A service's validators are made with `lazyValidator` (`apps/api/src/validators.ts`), which compiles one on its first call rather than when its module is imported. Compiling takes tens of milliseconds a validator, about four a service, and every start of the api and the worker and every test file that imports the services paid it for every service, validation or not: about 1.6 s of the 2.8 s that importing the skeleton's services took, and more with each service a product adds. The cost moves to the first request each validator sees. A schema AJV refuses, an unknown `format` say, would then fail only on that first call, so a unit test compiles every validator the services make (`compileValidators`). Validators made per call from a schema chosen at run time (the mail outbox and campaigns) already compile on first use and keep their own cache; the configuration's validator is needed at start and stays eager. Decided 2026-10-07.
- Query schemas declare their operators explicitly and enable coercion for REST query strings, so `?limit=10` validates as a number.
- Field names are **camelCase** at the API boundary — schemas, payloads, the typed client — and **snake_case** in PostgreSQL. The conversion happens in exactly one place, the Knex instance (`wrapIdentifier` / `postProcessResponse`), so services and schemas never see snake_case. Raw SQL written in a service uses the database names.
- Every `find` is **paginated**: 25 items by default, at most 100 per request. A service may lower these; none may disable pagination, so no request can read a whole table.
- Four resolver kinds are used with a fixed division of labour:
  - **data resolvers** set server-controlled fields (timestamps, owner id) and must never take those values from the request,
  - **query resolvers** apply mandatory scoping the client cannot remove,
  - **result resolvers** shape the response,
  - **external resolvers** strip anything the caller must not see — password material, internal identifiers such as object storage keys, session ids and token hashes, other users' fields. A record's own surrogate `id` is not internal in this sense: it is the resource address in the API ([0009](0009-tu-id-identity-model.md)).
- The external resolver is the single place that redacts, and it applies to real-time event payloads as well as direct responses. Nothing may bypass it.
- The database keeps the constraints that guarantee integrity independently of application state (see [0003](0003-postgresql-and-knex.md)). Where an invariant matters for both (unique TU-ID, unique email), it is expressed in both places deliberately.

## Consequences

- One definition drives runtime validation, static types, and the client contract.
- `additionalProperties: false` will reject requests during development whenever a schema falls behind the code; this is the intended trade.
- Resolvers contain server logic and therefore stay in the API package, never in anything the browser imports ([0007](0007-typed-client-from-api.md)).
- The validation error response is a **stable contract**: its shape is defined once as a TypeBox schema (`validationErrorSchema`, `apps/api/src/validation-error.ts`), exported through the client entry point as the type `ValidationError` ([0007](0007-typed-client-from-api.md)), and changed only like any other breaking API change. It is a 400 `Invalid data` whose `errors` name the refused fields, `[{ field: 'title' }]`, and nothing else: never the rule, the pattern or the allowed values ([0018](0018-owasp-security-baseline.md)). The frontend may branch on it, for example to attach messages to form fields. Decided 2026-10-02; until then the response carried the validator's raw output and the schema promised here did not exist.
