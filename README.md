# @vcf/cli

**Status:** alpha — under active initial construction. Not production ready.

Vibe Coding Framework MCP — an LLM-agnostic Model Context Protocol server + `vcf` CLI for the vibe-coding lifecycle (capture → spec → init → plan → build → test → review → ship).

## Install

```bash
npm install -g @vcf/cli
```

## Binaries

This package ships two bins:

- `vcf` — the maintenance CLI (`vcf init`, `vcf reindex`, `vcf verify`, …).
- `vcf-mcp` — the MCP server entry point. Launched by clients via `.mcp.json`.

## Scopes

The server runs in one of two scopes, selected at launch:

- `--scope global` (user-level `.mcp.json`) — idea / spec / project-init / catalog tools.
- `--scope project` (project-level `.mcp.json`, auto-written by `vcf init`) — full lifecycle.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## MCP spec / SDK versions

- MCP spec targeted: **2025-11-25**
- SDK pinned: `@modelcontextprotocol/sdk` `^1.29`
- Node: `>= 20 LTS`
