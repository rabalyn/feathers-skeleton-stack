#!/usr/bin/env bash
# The service generator's drift check (ADR 0030): generates one service of
# each type into a copy of the repository's files and typechecks the result,
# so a change to the conventions that the templates no longer meet fails
# here, not in the hands of whoever generates the next service.
#
# The copy sits inside apps/api so that its imports resolve against this
# package's node_modules. Nothing outside it is touched.
set -euo pipefail
API=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$API/../.." && pwd)
WORK="$API/.generator-check"

rm -rf "$WORK"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/apps/api" "$WORK/apps/web/src"
cp "$ROOT/pnpm-workspace.yaml" "$ROOT/tsconfig.base.json" "$WORK/"
cp -r "$API/src" "$API/test" "$API/tsconfig.json" "$API/vitest.config.ts" "$WORK/apps/api/"
cp -r "$ROOT/apps/web/src/i18n" "$WORK/apps/web/src/"
# The copy checks the generated code, not the generator a second time.
sed -i 's/"generators", //' "$WORK/apps/api/tsconfig.json"

cd "$API"
pnpm exec pinion generators/service.ts --root "$WORK" --name generator-checks
pnpm exec pinion generators/service.ts --root "$WORK" --name generator-probes --type custom

# The markers survive a run, so the next service can be generated as well.
for slot in imports configure; do grep -qF "// gen:service $slot (ADR 0030)" "$WORK/apps/api/src/services/index.ts"; done
pnpm exec tsc -p "$WORK/apps/api/tsconfig.json" --noEmit
echo "service generator: generated services typecheck"
