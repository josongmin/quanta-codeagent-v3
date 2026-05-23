/** LSP-nav tool slice contract (Codex `may-20-codex-lsp.md` absorption
 *  — ADR-0015).
 *
 *  Slice isolation (RFC §3.1, enforced by biome): `@/tool` MUST NOT import
 *  `@/lsp`. So this module owns no LSP knowledge; it talks to an injected
 *  {@link LspNavProvider}. The real provider that knows about pyright /
 *  typescript-language-server is assembled in `src/agent/lsp-bridge.ts` (the
 *  agent slice is the only assembler allowed to cross slices — exactly how
 *  `mcp-bridge.ts` and the diagnostics tool do it). This keeps the tools
 *  unit-testable with a fake provider in the normal gate (no real server
 *  needed). */
export {};
