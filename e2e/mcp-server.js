// The Playwright MCP server for coding agents (ADR 0026), run in the
// `mcp-browser` container over stdio. It is the server playwright-core ships;
// this starts it the way @playwright/mcp's own entry point does, on the
// playwright-core the e2e suite already uses, so the browser is the image's
// own and no second Playwright is installed.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { program } = require('playwright-core/lib/utilsBundle')
const { tools } = require('playwright-core/lib/coreBundle')
const { version } = require('playwright-core/package.json')

tools.decorateMCPCommand(program.version(`Version ${version}`).name('Playwright MCP'), version)
await program.parseAsync(process.argv)
