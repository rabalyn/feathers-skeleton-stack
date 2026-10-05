// Quasar CLI configuration (ADR 0014): a single-page application built by
// Quasar's Vite build, served by Nginx. https://v2.quasar.dev/quasar-cli-vite/quasar-config-file
import { readFileSync } from 'node:fs'
import { defineConfig } from '#q-app'

// The product's display name (ADR 0035), from the repository's product.env:
// the page title and the name in the toolbar and on the login page.
const productEnv = readFileSync(new URL('../../product.env', import.meta.url), 'utf8')
const PRODUCT_DISPLAY_NAME = /^PRODUCT_DISPLAY_NAME=(['"]?)(.*)\1$/m.exec(productEnv)?.[2]
if (!PRODUCT_DISPLAY_NAME) throw new Error('product.env sets no PRODUCT_DISPLAY_NAME')

// Where the dev server is reached through Nginx under the `dev` profile
// (ADR 0014); the browser never talks to the dev server directly.
// compose.yaml sets both from product.env.
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? ''
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 0)

export default defineConfig((ctx) => ({
  boot: ['i18n', 'feathers'],
  css: ['app.css'],
  // Bundled with the application, never loaded from a CDN (ADR 0018).
  extras: ['roboto-font', 'material-icons'],
  htmlVariables: { productName: PRODUCT_DISPLAY_NAME },

  build: {
    target: { browser: 'baseline-widely-available' },
    typescript: { strict: true, vueShim: true },
    vueRouterMode: 'history',
    defineEnv: { PRODUCT_DISPLAY_NAME },
    // Hashed file names under /assets/, which Nginx caches as immutable
    // (ADR 0016).
    extendViteConf(viteConf) {
      viteConf.build = { ...viteConf.build, assetsDir: 'assets' }
    },
    vitePlugins: [
      [
        '@intlify/unplugin-vue-i18n/vite',
        {
          ssr: ctx.mode.ssr,
          include: [ctx.appPaths.resolve.app('src/i18n')]
        }
      ]
    ]
  },

  devServer: {
    host: '0.0.0.0',
    port: 5173,
    open: false,
    allowedHosts: [PUBLIC_HOST],
    // Hot reload over the public origin, through Nginx.
    hmr: { protocol: 'wss', host: PUBLIC_HOST, clientPort: PUBLIC_PORT }
  },

  framework: {
    lang: 'de-DE',
    iconSet: 'material-icons',
    plugins: ['Notify', 'Dialog']
  },

  animations: []
}))
