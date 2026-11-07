#!/usr/bin/env node
/**
 * Executable Test Runner for Apple Music MyGo Music Plugin
 * Runs all 5 test tiers (Features, Boundaries, Pairwise, Scenarios, Remote/Lyrics/Library).
 * Exits with code 0 on success, code 1 on failure.
 */

import { runSuites } from "./harness/framework.js";
import { getPluginTargetPath } from "./harness/plugin_loader.js";

console.log("\x1b[1m\x1b[35m=======================================================\x1b[0m");
console.log("\x1b[1m\x1b[35m  Apple Music MyGo Music Plugin — E2E Test Suite       \x1b[0m");
console.log("\x1b[1m\x1b[35m=======================================================\x1b[0m");
console.log(`Target Plugin: \x1b[33m${getPluginTargetPath()}\x1b[0m\n`);

console.log("Loading Tier 1: Feature Coverage Tests...");
await import("./tier1_features.test.js");

console.log("Loading Tier 2: Boundary & Corner Cases Tests...");
await import("./tier2_boundaries.test.js");

console.log("Loading Tier 3: Cross-Feature Interactions Tests...");
await import("./tier3_pairwise.test.js");

console.log("Loading Tier 4: Real-World Workload Scenarios Tests...");
await import("./tier4_scenarios.test.js");

console.log("Loading Tier 5: Remote Playback, TTML Lyrics & Library Tests...");
await import("./tier5_remote_lyrics_library.test.js");

const result = await runSuites();

if (!result.success) {
  console.error(`\x1b[31mTest Run FAILED with ${result.failed} error(s).\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[32m✔ All ${result.passed} E2E tests PASSED successfully across all 5 tiers!\x1b[0m`);
  process.exit(0);
}
