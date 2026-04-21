// Single source of truth for the shipped server + CLI version string.
// Auto-derived from package.json at build time via tsup's ESM JSON import
// (`with { type: "json" }`). tsup inlines the literal during bundling so
// the dist artifact has no runtime filesystem read and no path surprises
// on symlink invocations.
//
// Prior to 2026-04-21 this was a hardcoded string; it drifted three
// releases behind reality between 0.0.2-alpha.0 and 0.2.0-alpha.0 because
// every release bumped package.json but forgot to update this file.
// Auto-derivation removes that failure mode.

import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;
export const MCP_SPEC_VERSION = "2025-11-25";
export const SDK_VERSION_PIN = "^1.29";
