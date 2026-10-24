import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import manifest from "./manifest.json";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * One self-contained module, as Buzz's plugin API v1 requires: no imports at
 * run time, no separate assets. React comes from Buzz (src/react.ts); the card
 * packages are bundled from source.
 */
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: here("./src/jsx-runtime.ts") },
      { find: /^react\/jsx-dev-runtime$/, replacement: here("./src/jsx-runtime.ts") },
      { find: /^react$/, replacement: here("./src/react.ts") },
      { find: /^@kybernesis\/cards$/, replacement: here("../../cards/src/index.ts") },
      { find: /^@kybernesis\/cards-react$/, replacement: here("../../cards-react/src/index.ts") },
    ],
  },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    // Committed, so Buzz can install it from a folder or from Git without building.
    outDir: "release",
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "plugin.js" },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [
    {
      name: "buzz-plugin-contract",
      enforce: "pre",
      resolveId(id) {
        if (id === "react-dom" || id.startsWith("react-dom/") || id === "@buzz/author" || id.startsWith("@deepseek-ai/cordis")) {
          throw new Error(`${id} is supplied by Buzz; import its types only`);
        }
      },
      generateBundle(_options, bundle) {
        const outputs = Object.values(bundle);
        const main = outputs[0];
        if (outputs.length !== 1 || main?.type !== "chunk" || main.imports.length) {
          throw new Error("Buzz plugin API v1 needs one self-contained JS module, without separate assets");
        }
        if (!main.exports.includes("apply")) throw new Error("Export apply(ctx)");
        this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(manifest, null, 2) });
        // What Buzz's Plugins screen shows. Signing covers these bytes too, and a
        // rebuild empties release/, so a stale signature never survives a build.
        for (const name of ["README.md", "icon.png"]) {
          this.emitFile({ type: "asset", fileName: name, source: readFileSync(here(`./assets/${name}`)) });
        }
      },
    },
  ],
});
