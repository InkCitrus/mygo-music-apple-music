import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  platform: "neutral",
  clean: true,
  bundle: true,
  minify: false,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],
  outDir: "dist",
  outExtension() {
    return {
      js: ".js",
    };
  },
});
