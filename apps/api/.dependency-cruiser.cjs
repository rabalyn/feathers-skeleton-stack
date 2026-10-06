// The client entry point's dependency boundary (ADR 0007), checked across
// whole import chains. src/client.ts ships to the browser, so at runtime it
// may reach only the modules allowlisted here; everything else it names must
// be a type-only import, which compiles away and is therefore not followed.
// An allowlist rather than a list of forbidden packages: a new server-only
// dependency is refused without anybody remembering to add it.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'client-entry-is-browser-safe',
      comment:
        'src/client.ts is imported by the browser (ADR 0007). At runtime it may reach only abilities, permission-entry, product/client, product/permissions, locales, paginate, paths, limits, uploads, @casl/ability and the Feathers client core. Import server code with `import type`, or move browser-safe code into an allowlisted module.',
      severity: 'error',
      from: { path: '^src/client\\.ts$' },
      to: {
        reachable: true,
        pathNot: [
          '^src/(client|abilities|permission-entry|locales|paginate|paths|limits|uploads)\\.ts$',
          // The product's part of the entry point and its permissions (ADR 0035).
          '^src/product/(client|permissions)\\.ts$',
          '(^|/)node_modules/@casl/ability/',
          '(^|/)node_modules/@feathersjs/(feathers|authentication-client)/'
        ]
      }
    }
  ],
  options: {
    // Only dependencies that survive compilation: `import type` is erased.
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(dist|test)/' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] }
  }
}
