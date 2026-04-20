// Single source of truth for the shipped server + CLI version string.
// Must be kept in sync with package.json on each release — wiring this to
// auto-derive from package.json at build time is filed in
// plans/2026-04-20-followups.md item 4.
export const VERSION = "0.2.1-alpha.0";
export const MCP_SPEC_VERSION = "2025-11-25";
export const SDK_VERSION_PIN = "^1.29";
