/**
 * `@/runner` — surface-agnostic Layer-2 orchestration slice.
 *
 * Contains:
 *   - `assemble/`  — typed-config → built collaborators (LLM, Store, Memory, …).
 *                    Input is plain config objects; NO `process.env` / `argv`
 *                    reading. Surface entry (CLI/Web/Tauri) maps its own input
 *                    source (ENV / HTTP / IPC) → typed config first.
 *   - `orchestrate/` — `runAgent` driver: resume FSM, per-turn save, one-shot
 *                      vs interactive routing. UI side is an injected
 *                      `{ out, err, confirm, prompt }` port — surface-agnostic.
 *   - `session-ops/` — `quanta session list/show/delete/…` domain ops. io is
 *                      injected as a port; surface picks how to render.
 *
 * SLICE BOUNDARY:
 *   - May import: `@/agent`, `@/llm`, `@/memory`, `@/mcp`, `@/lsp`,
 *     `@/observability`, `@/permission`, `@/session`, `@/skill`, `@/stream`,
 *     `@/storage`, `@/tool`, `@/auth`, `@/ui`, `@/shared`, `@/security`.
 *   - MUST NOT import: any `apps/**` (would couple to a specific surface).
 *   - Public re-exports go through this barrel so consumers depend on the
 *     slice contract, not internal file paths.
 */
// `assemble/` is the first populated sub-slice (the others — orchestrate/,
// session-ops/ — remain scaffolds for later phases). The barrel re-exports
// the public assemble factories so consumers depend on `@/runner` (the slice
// contract), not internal file paths.
export * from "./assemble"
