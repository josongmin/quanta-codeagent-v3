/**
 * Disk source for command-hook bindings (ADR-0454).
 *
 * quanta has no central Claude-style `settings.json` loader today, so this is
 * a focused reader for exactly the `hooks` block. It parses the SAME Claude
 * Code shape the migration translator already understands
 * (src/migration/translators/claude-code-config.ts):
 *
 *   { "hooks": { "<EventName>": [ { "matcher"?, "hooks": [ {type:"command", command} ] } ] } }
 *
 * flattening each `{type:"command", command}` into one {@link CommandHookBinding}
 * per command. The loader is PURE w.r.t. side effects beyond the single read:
 * a missing file ⇒ `[]`, a malformed file ⇒ `[]` (skip, never throw).
 *
 * NOTE — loading bindings does NOT arm anything. The bindings only run if the
 * gate (opt-in + acknowledgement + permission) arms them. Reading the disk is
 * always safe.
 */

import { readFile } from "node:fs/promises"
import type { HookGroupSetting } from "@/config"
import type { CommandHookBinding } from "./types"

/** Coerce an unknown into a non-null plain object, else undefined. */
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Extract the `{type:"command", command}` commands from one hook group. */
const commandsOf = (group: Record<string, unknown>): string[] => {
  const hooks = group.hooks
  if (!Array.isArray(hooks)) return []
  const cmds: string[] = []
  for (const h of hooks) {
    const ho = asObject(h)
    if (ho?.type === "command" && typeof ho.command === "string" && ho.command.trim().length > 0) {
      cmds.push(ho.command)
    }
  }
  return cmds
}

/** Parse already-read JSON text into bindings. Exported so a host that loads
 *  settings through another path (or a test) can reuse the exact parse without
 *  a filesystem round-trip. Malformed text ⇒ `[]`. */
/** Flatten one hook group into bindings for `event`. Non-object group ⇒ `[]`. */
const bindingsForGroup = (event: string, rawGroup: unknown): CommandHookBinding[] => {
  const group = asObject(rawGroup)
  if (group === undefined) return []
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  return commandsOf(group).map((command) => ({
    event,
    command,
    ...(matcher !== undefined ? { matcher } : {}),
  }))
}

export const parseCommandHookBindings = (text: string): CommandHookBinding[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const hooks = asObject(asObject(parsed)?.hooks)
  if (hooks === undefined) return []
  const out: CommandHookBinding[] = []
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      out.push(...bindingsForGroup(event, rawGroup))
    }
  }
  return out
}

/** Read `settingsPath` and parse its `hooks` block into bindings. ENOENT /
 *  ENOTDIR ⇒ `[]` (absent is not an error). Malformed JSON ⇒ `[]`. Any other
 *  read error (EACCES, …) propagates so a host sees a real fs fault rather than
 *  silently arming an empty set. */
export const loadCommandHookBindings = async (
  settingsPath: string,
): Promise<CommandHookBinding[]> => {
  let text: string
  try {
    text = await readFile(settingsPath, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw err
  }
  return parseCommandHookBindings(text)
}

/**
 * Convert the `@/config` resolved-and-TRUST-GATED hook events into
 * {@link CommandHookBinding}s (ADR-0497, jun-7-misc 05). This is the
 * trust-gated replacement for the §2 `process.cwd()`-relative
 * {@link loadCommandHookBindings} read: when `QUANTA_CENTRAL_CONFIG` is on, the
 * composition root feeds `resolveDiskConfig(...).hooks` (already gated — an
 * UNTRUSTED repo's hook commands have ALREADY been dropped by the merge) here
 * instead of reading `<cwd>/settings.json` directly with no trust gate.
 *
 * The flatten is byte-identical to {@link parseCommandHookBindings}: one
 * binding per `{type:"command", command}` (the `@/config` loader already
 * filtered non-command / empty-command hooks), preserving the per-group
 * `matcher`. A repo whose grants were dropped for untrust yields ZERO bindings
 * for those layers — the malicious hook command never becomes a binding.
 */
const bindingsFromConfigGroup = (event: string, group: HookGroupSetting): CommandHookBinding[] => {
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  const out: CommandHookBinding[] = []
  for (const h of group.hooks ?? []) {
    if (h.type === "command" && typeof h.command === "string" && h.command.trim().length > 0) {
      out.push({ event, command: h.command, ...(matcher !== undefined ? { matcher } : {}) })
    }
  }
  return out
}

export const bindingsFromHookEvents = (
  events: Readonly<Record<string, readonly HookGroupSetting[]>>,
): CommandHookBinding[] => {
  const out: CommandHookBinding[] = []
  for (const [event, groups] of Object.entries(events)) {
    for (const group of groups) out.push(...bindingsFromConfigGroup(event, group))
  }
  return out
}
