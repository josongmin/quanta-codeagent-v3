/**
 * CLI-03 — App / system-level slash-command registry (ADR-0306).
 *
 * This file owns slash commands that touch system-level concerns —
 * permission store, MCP config, memory store, git/odb rewind, per-turn
 * conversation checkpoints. The bodies live in dedicated `*-cmd.ts`
 * modules; the registry only references the cmd objects.
 *
 * Env-gated entries (`/rewind`, `/fork`, `/memory`) are evaluated at
 * module load: `QUANTA_REWIND=0` / `QUANTA_MEMORY_SLASH=0` removes them
 * from the registry entirely so they can't be discovered, auto-completed,
 * or accidentally dispatched. Default `"1"` (registered). This mirrors
 * the original `slash-commands.ts` behavior byte-for-byte.
 *
 * Composition: `slash-commands.ts` concatenates
 * `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS,
 *   ...APP_SLASH_COMMANDS]` into the historic `BUILTINS`.
 */

import { dreamCmd, isDreamSlashEnabled } from "../dream-cmd"
import { mcpCmd } from "../mcp-cmd"
import { isMemorySlashEnabled, memoryCmd } from "../memory-cmd"
import { permissionCmd } from "../permission-explain"
import { isRewindEnabled, rewindCommands } from "../rewind-cmd"
import { rewindConvCmd } from "../rewind-conv-cmd"
import { rewindToolCmd } from "../rewind-tool-cmd"
import { sessionRegistryCmd } from "../session-registry-cmd"
import { knobsCmd } from "../slash-commands-knobs"
import type { SlashCommand } from "../slash-contract"

// `/rewind` + `/fork` (Claude Code v1.7196 pattern) — env-gated at module
// load: `QUANTA_REWIND=0` removes them from the registry entirely. Default
// `"1"` (registered).
const REWIND_COMMANDS: readonly SlashCommand[] = isRewindEnabled() ? rewindCommands : []

// `/memory` — env-gated the same way: `QUANTA_MEMORY_SLASH=0` removes it
// from the registry at load time. Default `"1"` (registered).
const MEMORY_COMMANDS: readonly SlashCommand[] = isMemorySlashEnabled() ? [memoryCmd] : []

// `/dream` (H16 cross-session auto-dream) — env-gated: `QUANTA_DREAM_SLASH=0`
// removes it at load time. Default `"1"` (registered). The command itself is
// inert (prints "not wired") unless the surface injects a `DreamSlashState`,
// which only happens when `QUANTA_AUTO_DREAM=1`.
const DREAM_COMMANDS: readonly SlashCommand[] = isDreamSlashEnabled() ? [dreamCmd] : []

/** Slot order for the app layer. Tail-appended to the assembled BUILTINS
 *  after the surface + session layers, so historic test pins that asserted
 *  global slots are intentionally re-anchored — see the BUILTINS sweep test
 *  for the new ground truth. */
export const APP_SLASH_COMMANDS: readonly SlashCommand[] = [
  permissionCmd,
  mcpCmd,
  ...REWIND_COMMANDS,
  rewindToolCmd,
  ...MEMORY_COMMANDS,
  ...DREAM_COMMANDS,
  rewindConvCmd,
  knobsCmd,
  // ADR-0370 — operator visibility for the session-resource-registry slice.
  sessionRegistryCmd,
]
