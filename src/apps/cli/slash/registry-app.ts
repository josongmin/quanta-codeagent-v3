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

import { bugCmd } from "../bug-cmd"
import { doctorCmd } from "../doctor"
import { dreamCmd, isDreamSlashEnabled } from "../dream-cmd"
import { mcpCmd } from "../mcp-cmd"
import { isMemorySlashEnabled, memoryCmd } from "../memory-cmd"
import { permissionCmd } from "../permission-explain"
import { isRewindEnabled, rewindCommands } from "../rewind-cmd"
import { rewindConvCmd } from "../rewind-conv-cmd"
import { rewindToolCmd } from "../rewind-tool-cmd"
import { sessionRegistryCmd } from "../session-registry-cmd"
import { isHunkUndoEnabled, undoCmd } from "../undo-cmd"
import { capabilitiesCmd, capsAliasCmd } from "../slash-commands-capabilities"
import { knobsCmd } from "../slash-commands-knobs"
import type { SlashCommand } from "../slash-contract"
import { releaseNotesCmd, versionCmd } from "../version-cmd"

// `/rewind` + `/fork` (Claude Code v1.7196 pattern) — env-gated at module
// load: `QUANTA_REWIND=0` removes them from the registry entirely. Default
// `"1"` (registered).
const REWIND_COMMANDS: readonly SlashCommand[] = isRewindEnabled() ? rewindCommands : []

// `/memory` — env-gated the same way: `QUANTA_MEMORY_SLASH=0` removes it
// from the registry at load time. Default `"1"` (registered).
const MEMORY_COMMANDS: readonly SlashCommand[] = isMemorySlashEnabled() ? [memoryCmd] : []

// `/undo` (RFC-def hunk-revert) — DESTRUCTIVE ⇒ default OFF. Registered only
// when `QUANTA_HUNK_UNDO=1`; absent ⇒ the command is not in the registry at all
// (byte-identical, no undo surface). Even registered it is inert (`not wired`)
// unless the composition root injects a `HunkUndoSlashState`, which happens
// under the SAME gate.
const UNDO_COMMANDS: readonly SlashCommand[] = isHunkUndoEnabled() ? [undoCmd] : []

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
  ...UNDO_COMMANDS,
  ...DREAM_COMMANDS,
  rewindConvCmd,
  knobsCmd,
  // ADR-0503 P3 — operator visibility for the cross-surface capability layer
  // (gates + per-surface exposure grid). Read-only; `/caps` is the alias.
  capabilitiesCmd,
  capsAliasCmd,
  // ADR-0370 — operator visibility for the session-resource-registry slice.
  sessionRegistryCmd,
  // jun-6 (RFC jun-6-doctor-selfcheck) — `/doctor` environment self-check.
  doctorCmd,
  // §23.3/§23.4 transparency — `/version`, `/release-notes`, `/bug`. All
  // read-only + additive (no existing command changes; no network).
  versionCmd,
  releaseNotesCmd,
  bugCmd,
]
