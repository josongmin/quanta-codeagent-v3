/**
 * P4 (jul-11) — the MCP config-read + load-assembly path is now surface-shared:
 * it moved to `@/host/mcp-composition` (zero apps/cli-local deps — the last one,
 * McpHealthHolder, was promoted to @/host first). BOTH the CLI and the web
 * daemon compose MCP from that one module.
 *
 * This barrel re-exports it verbatim so every existing `./internal/mcp` import
 * site in apps/cli keeps working unchanged (the move is structural only).
 */
export * from "@/host/mcp-composition"
