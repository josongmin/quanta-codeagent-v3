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
// Sub-slice barrels — each populated independently across Phase-1 tracks.
// `assemble/` — typed-config → built collaborators (Track-A).
// `orchestrate/` — public resume/persist helpers; one-shot compat helpers stay
// internal and are consumed via concrete files / the legacy session host.
// `session-ops/` re-exports go through its own barrel (`./session-ops`); not
// re-spread here to keep the top-level `@/runner` surface tight (consumers
// reach session-ops via `@/runner/session-ops` to make the dependency
// explicit at the call site).
export * from "./assemble"
export * from "./orchestrate"
export type {
  SideConversationPort,
  SideConversationStartArgs,
} from "./side-conversation-port"
