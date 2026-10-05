#!/usr/bin/env bash
# The Playwright MCP server for coding agents (ADR 0026), in this product's
# mcp-browser container, whose name carries the project (ADR 0035). Started
# by .mcp.json and by `scripts/stack.sh mcp`; speaks MCP on stdin and stdout.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/product.sh
source "$ROOT/scripts/product.sh"
exec podman exec -i "$(ctr mcp-browser)" node mcp-server.js --config mcp.config.json
