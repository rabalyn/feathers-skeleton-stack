// The product's permissions (ADR 0011, 0035), appended to the skeleton's
// catalogue in abilities.ts. Browser-safe like it: nothing but
// ../permission-entry.js and @casl/ability. The web app labels each key in
// apps/web/src/i18n/product/. The service generator adds one per service.
// gen:service imports (ADR 0030)

export const PRODUCT_PERMISSIONS = [
  // gen:service permissions (ADR 0030)
]

// Product permissions an API token may never carry (ADR 0029): one's own
// data, and whatever is irreversible or needs a person in the UI.
export const PRODUCT_TOKEN_EXCLUDED_PERMISSIONS: readonly (typeof PRODUCT_PERMISSIONS)[number]['key'][] = []
