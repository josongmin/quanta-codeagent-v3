/**
 * Slash-command registry assembly (ADR-0306, CLI-03 split).
 *
 * The historical monolith owned 763 LOC spanning three different ownership
 * layers: surface-only commands, session-bound commands, and app/system
 * commands. After CLI-03 the bodies live in three sibling registries under
 * `./slash/`, and this file does just one thing: concatenate them into the
 * `BUILTINS` array the runtime + completer + describe helpers consume.
 *
 *   BUILTINS = [...SURFACE, ...SESSION, ...APP]
 *
 * Slot ordering: the layered concatenation does NOT preserve the historic
 * BUILTINS slot indices — `/retry-with` (old index 6) now appears in the
 * session block, after every surface command. Tests that pinned absolute
 * indices were updated to assert the layered order + per-layer counts; the
 * SET of registered names is unchanged.
 *
 * Public surface (`runSlashCommand`, `slashCompleter`, `describeSlashCommand`,
 * `isSlashCommand`, the `SlashContext` types) is preserved verbatim — every
 * caller continues to import from `./slash-commands` and the `declare module
 * "./slash-commands"` augmentations in the per-command files still resolve.
 */

import { APP_SLASH_COMMANDS } from "./slash/registry-app"
import { SESSION_SLASH_COMMANDS } from "./slash/registry-session"
import { buildSurfaceSlashCommands, radarCmd } from "./slash/registry-surface"
import type { SlashCommand } from "./slash-contract"
import { createSlashRuntime, isSlashCommand } from "./slash-engine"

export type { SkillRow, SlashCommand, SlashCompletionHint, SlashContext } from "./slash-contract"

/** Surface layer — built with a closure that returns the assembled BUILTINS
 *  so `/help` reflects the live full registry (all three layers). The
 *  surface registry exposes a static export too, but the assembly path uses
 *  the closure-bound variant to avoid pinning `/help` to the surface-only
 *  subset. */
const SURFACE_SLASH_COMMANDS = buildSurfaceSlashCommands(() => BUILTINS)

export const BUILTINS: readonly SlashCommand[] = [
  ...SURFACE_SLASH_COMMANDS,
  ...SESSION_SLASH_COMMANDS,
  ...APP_SLASH_COMMANDS,
]

/** `/exit` and `/quit` are short-circuited by `composePromptPipeline` BEFORE the
 *  BUILTINS dispatch — they aren't `SlashCommand` entries but a user
 *  pressing <Tab> at the prompt expects them in the completion list. */
const REPL_VIRTUAL_COMMANDS = ["/exit", "/quit"] as const

const slashRuntime = createSlashRuntime(BUILTINS, { virtualCommands: REPL_VIRTUAL_COMMANDS })

export const describeSlashCommand = slashRuntime.describe
export const slashCompleter = slashRuntime.complete
export const runSlashCommand = slashRuntime.run
/** ADR-0231 — re-exported for the radar wire hellgate (direct cmd invocation
 *  against a synthetic `SlashContext`). */
export { isSlashCommand, radarCmd }
