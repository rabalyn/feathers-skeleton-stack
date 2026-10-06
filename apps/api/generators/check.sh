#!/usr/bin/env bash
# The service generator's drift check (ADR 0030): generates one service of
# each type into a copy of the repository's files and typechecks the result,
# so a change to the conventions that the templates no longer meet fails
# here, not in the hands of whoever generates the next service. It does so
# twice: as the skeleton, which registers in its own files, and as a product,
# which registers in the product module (ADR 0035).
#
# The copy sits inside apps/api so that its imports resolve against this
# package's node_modules. Nothing outside it is touched.
set -euo pipefail
API=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$API/../.." && pwd)
WORK="$API/.generator-check"

trap 'rm -rf "$WORK"' EXIT

# check <PRODUCT> <the file services are registered in>
check() {
  local product=$1 index=$2
  rm -rf "$WORK"
  mkdir -p "$WORK/apps/api" "$WORK/apps/web/src"
  cp "$ROOT/pnpm-workspace.yaml" "$ROOT/tsconfig.base.json" "$WORK/"
  sed "s/^PRODUCT=.*/PRODUCT=$product/" "$ROOT/product.env" >"$WORK/product.env"
  cp -r "$API/src" "$API/test" "$API/tsconfig.json" "$API/vitest.config.ts" "$WORK/apps/api/"
  cp -r "$ROOT/apps/web/src/i18n" "$WORK/apps/web/src/"
  # The copy checks the generated code, not the generator a second time.
  sed -i 's/"generators", //' "$WORK/apps/api/tsconfig.json"

  (
    cd "$API"
    pnpm exec pinion generators/service.ts --root "$WORK" --name generator-checks
    pnpm exec pinion generators/service.ts --root "$WORK" --name generator-probes --type custom
  )

  # The markers survive a run, so the next service can be generated as well.
  for slot in imports configure; do grep -qF "// gen:service $slot (ADR 0030)" "$WORK/apps/api/src/$index"; done
  grep -qF "/generator-checks/generator-checks.js'" "$WORK/apps/api/src/$index"
  # Unused locals too: the imports the generator adds to the product module
  # must be the ones its code uses.
  (cd "$API" && pnpm exec tsc -p "$WORK/apps/api/tsconfig.json" --noEmit --noUnusedLocals)
}

check feathers-skeleton services/index.ts
echo "service generator: the skeleton's generated services typecheck"
check generator-check-product product/services.ts
echo "service generator: a product's generated services typecheck"
