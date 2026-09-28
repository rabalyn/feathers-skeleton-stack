// Quasar CLI configuration (ADR 0014): a single-page application built by
// Quasar's Vite build, served by Nginx. https://v2.quasar.dev/quasar-cli-vite/quasar-config-file
import { defineConfig } from '#q-app'

// Where the dev server is reached through Nginx under the `dev` profile
// (ADR 0014); the browser never talks to the dev server directly.
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? 'app.localhost'
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 8443)

export default defineConfig((ctx) => ({
  boot: ['i18n', 'feathers'],
  css: ['app.css'],
  // Bundled with the application, never loaded from a CDN (ADR 0018).
  extras: ['roboto-font', 'material-icons'],

  build: {
    target: { browser: 'baseline-widely-available' },
    typescript: { strict: true, vueShim: true },
    vueRouterMode: 'history',
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
