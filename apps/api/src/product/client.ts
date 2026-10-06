// The product's part of the client entry point (ADR 0007, 0035): the types
// of its services as a browser sees them. Re-exported by src/client.ts, so it
// is bound by the same dependency boundary: server code only as
// `import type`. The service generator adds each service here.
// gen:service imports (ADR 0030)

// gen:service exports (ADR 0030)

export interface ProductServiceTypes {
  // gen:service client-types (ADR 0030)
}
