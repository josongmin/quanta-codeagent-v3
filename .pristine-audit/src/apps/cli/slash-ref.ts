/**
 * WS-E.3 (jul-10, UUX-5-01) — `slashRef`: the ONLY way user-facing copy may
 * name a slash command.
 *
 * Root cause this kills: hand-written copy referenced ghost commands — the
 * context warning advertised `/compact` for weeks while the real command is
 * `/summarize-now`. A raw string literal can silently rot when a command is
 * renamed/removed; a `slashRef` cannot:
 *
 *  1. Call sites may only pass a member of {@link REFERENCED_SLASH_COMMANDS}
 *     (compile-time: the parameter is the literal union, not `string`).
 *  2. The slash-ref hellgate enumerates {@link REFERENCED_SLASH_COMMANDS} and
 *     asserts every name resolves in the LIVE registries (`BUILTINS` +
 *     REPL virtual commands) — a ghost reference is RED in CI, structurally.
 *
 * Adding a reference = add the name here + use `slashRef("name")` at the call
 * site. If the command doesn't exist, the hellgate fails; if it is later
 * deleted from the registry, the hellgate fails too (both drift directions).
 *
 * Slice pin: pure data + one pure function, ZERO imports — safe for any CLI
 * copy module (context-warning, welcome-banner, help-render, …) without
 * widening their import fences.
 */

/** Every slash command that user-facing COPY refers to (not the registry
 *  itself — the registry is its own SSOT). The hellgate validates each entry
 *  against the live registries. Keep alphabetized. */
export const REFERENCED_SLASH_COMMANDS = ["help", "knobs", "rewind", "summarize-now"] as const

export type ReferencedSlashName = (typeof REFERENCED_SLASH_COMMANDS)[number]

/** Render a validated slash-command reference for user-facing copy. */
export const slashRef = (name: ReferencedSlashName): string => `/${name}`
