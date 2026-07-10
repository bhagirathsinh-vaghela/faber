import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        // The solid-markdown chain pulls CJS packages (micromark dev build →
        // debug, unified → extend) that vite must pre-bundle or their default
        // imports fail in the browser. They are direct devDependencies so they
        // resolve from the app root (bun's isolated store hides transitive
        // deps from vite's resolver).
        optimizeDeps: {
          include: ["debug", "extend"],
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  tailwindcss(),
  solidPlugin(),
]
