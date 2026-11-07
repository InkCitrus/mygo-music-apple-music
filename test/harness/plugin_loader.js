/**
 * Plugin Loader for E2E Test Suite
 * Dynamically resolves and loads the Apple Music plugin under test.
 * Resolves target in order:
 * 1. process.env.PLUGIN_TARGET (explicit path)
 * 2. dist/index.js (compiled production bundle)
 * 3. test/harness/reference_plugin.js (authoritative oracle fallback)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../");

export function getPluginTargetPath() {
  if (process.env.PLUGIN_TARGET && fs.existsSync(process.env.PLUGIN_TARGET)) {
    return path.resolve(process.env.PLUGIN_TARGET);
  }

  const distPath = path.resolve(projectRoot, "dist/index.js");
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  return path.resolve(__dirname, "reference_plugin.js");
}

export async function loadPlugin() {
  const targetPath = getPluginTargetPath();
  // Using file URL with cache-busting timestamp to allow hot-reloading in dynamic tests
  const fileUrl = `${path.toNamespacedPath(targetPath)}?t=${Date.now()}`;
  const pluginModule = await import(`file://${targetPath}`);
  return pluginModule;
}
