# The product module, web side (ADR 0035)

A product adds its pages and links in `routes.ts`, its pages and components
anywhere under `src/` as new files, and its messages in
`src/i18n/product/{de,en}.json`. Those catalogues are merged into the
skeleton's and may only add keys: a key the skeleton defines is refused by
`test/product-i18n.test.ts`; wording of the skeleton's own screens is changed
upstream. The API side is in `apps/api/src/product/`.
