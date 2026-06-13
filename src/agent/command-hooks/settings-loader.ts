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
import type { HookGroupSetting, SettingsLayerName } from "@/config"
import { type CommandHookBinding, type CommandHookSource, sourceNeedsReview } from "./types"

/** Map a config {@link SettingsLayerName} → command-hook {@link CommandHookSource}.
 *  `local` (a repo-local `.local` overlay) shares the repo trust class with
 *  `project`, so it folds into `"project"` — both are review-gated; the precise
 *  label is informational, the trust decision is what is load-bearing. */
const LAYER_TO_SOURCE: Readonly<Record<SettingsLayerName, CommandHookSource>> = {
  managed: "managed",
  user: "user",
  project: "project",
  local: "project",
}

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
/** Flatten one hook group into bindings for `event`. Non-object group ⇒ `[]`.
 *
 *  T04 — the LEGACY (non-central) path has no config-layer trust model, so a
 *  binding is review-gated ONLY when the on-disk group carries the migration
 *  `needsReview: true` marker (written by `src/migration/external-config`). This
 *  is read in the TIGHTENING direction ONLY: a `true` marks the binding
 *  `source:"imported"` + `needsReview:true`; an absent / `false` marker yields a
 *  byte-identical un-provenanced binding (no source/needsReview keys), so a
 *  hand-authored `settings.json#hooks` fires exactly as before. A hostile repo
 *  can therefore only ADD a review requirement to its own hook, never remove one. */
const bindingsForGroup = (event: string, rawGroup: unknown): CommandHookBinding[] => {
  const group = asObject(rawGroup)
  if (group === undefined) return []
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  const imported = group.needsReview === true
  return commandsOf(group).map((command) => ({
    event,
    command,
    ...(matcher !== undefined ? { matcher } : {}),
    ...(imported ? { source: "imported" as const, needsReview: true } : {}),
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

/** T04 — the legacy reader loads a REPO-LOCAL file (`<cwd>/settings.json`),
 *  which is ATTACKER-SHIPPABLE in a cloned repo. So every hook it returns is
 *  repo provenance and MUST be review-gated under the trust gate — closing the
 *  default-path RCE hole where a hostile repo's raw `settings.json#hooks` (no
 *  migration marker) would otherwise fire un-reviewed. A binding the parser
 *  already marked `imported` (migration round-trip) keeps that more-specific
 *  source; an un-marked one defaults to `project`. Both are `needsReview:true`.
 *
 *  The flag is INERT when the trust gate is OFF (the runner ignores `needsReview`
 *  unless `gate.trustGate` is armed), so the DEFAULT runtime is byte-identical —
 *  only the binding object gains provenance keys. */
const asRepoProvenance = (b: CommandHookBinding): CommandHookBinding =>
  b.needsReview === true ? b : { ...b, source: "project", needsReview: true }

/** Read `settingsPath` and parse its `hooks` block into bindings. ENOENT /
 *  ENOTDIR ⇒ `[]` (absent is not an error). Malformed JSON ⇒ `[]`. Any other
 *  read error (EACCES, …) propagates so a host sees a real fs fault rather than
 *  silently arming an empty set. Every binding is stamped REPO provenance
 *  ({@link asRepoProvenance}) — the file is repo-local, hence review-gated. */
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
  return parseCommandHookBindings(text).map(asRepoProvenance)
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
  // T04 — `group.source` was STAMPED by the trusted merge from the LAYER NAME
  // (never disk-readable). Derive the command-hook provenance + the review
  // requirement from it. Managed/user ⇒ trusted (no review); project/local ⇒
  // review-gated. Absent source (direct construction in a test / a non-merge
  // caller) ⇒ un-provenanced, byte-identical.
  const source = group.source !== undefined ? LAYER_TO_SOURCE[group.source] : undefined
  const needsReview = sourceNeedsReview(source)
  const provenance: Pick<CommandHookBinding, "source" | "needsReview"> =
    source !== undefined ? { source, needsReview } : {}
  const out: CommandHookBinding[] = []
  for (const h of group.hooks ?? []) {
    if (h.type === "command" && typeof h.command === "string" && h.command.trim().length > 0) {
      out.push({
        event,
        command: h.command,
        ...(matcher !== undefined ? { matcher } : {}),
        ...provenance,
      })
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
