/**
 * RFC-06 F5 — per-skill management ACTIONS over the live runtime authority:
 * copy (bounded raw markdown), reveal (capability-based), enable/disable (CAS).
 *
 * This is F5's behavior owner. It closes the three F5 REDs, and every arm is a
 * TYPED receipt — never a silent optional-success no-op (the jul-15 badge-lie
 * class on the model/operator's own surface):
 *
 *   (a) ACTION-TIME RE-RESOLUTION (copy). A construction-time snapshot of a
 *       `Skill` cannot reflect a disk mutation that lands AFTER the surface was
 *       built. {@link copySkillMarkdown} re-resolves the canonical winner BY NAME
 *       through {@link SkillActionPorts.resolveCanonicalSkill} at the moment of
 *       the action, then reads the RAW on-disk bytes of THAT winner's
 *       `sourcePath` — so the copy reflects the current file (frontmatter and
 *       all), not the parsed `body` captured at construction.
 *
 *   (b) PATH-JAIL (copy). The re-resolved `sourcePath` is confirmed to still
 *       resolve (symlinks followed) UNDER the skill's own directory before any
 *       bytes are read — a repurposed dir / symlink escape is a typed
 *       `path_jail` refusal, never an out-of-tree read. The read is additionally
 *       BOUNDED: an oversize file is a typed `too_large` refusal (no unbounded
 *       slurp).
 *
 *   (c) CAPABILITY-BASED REVEAL. {@link revealSkill} reveals only when the
 *       surface wired a reveal capability; an ABSENT capability is the DISTINCT
 *       typed `unsupported` receipt — reveal-absence is never indistinguishable
 *       from success (RFC-06 F5 RED (c) / hard rule), mirroring E4's
 *       `SessionPostureUnsupportedError`.
 *
 * enable/disable route through the F1 authority's CAS `setEnabled` (a stale
 * revision is rejected there — RED (b)); {@link setSkillEnabledAction} forwards
 * the CALLER's `expectedRevision` VERBATIM (it never self-reads the live
 * revision, which would make every disable spuriously "fresh" and defeat the
 * CAS). NO delete/uninstall operation exists here — F6 stays PARKED.
 *
 * Slice rules: `@/skill` siblings + `@/shared` only (leaf). No `@/storage` /
 * node:fs / host references — the fs + OS-reveal effects are INJECTED as a port
 * (mirroring `admin-policy-loader-fs` / the disabled-store fs adapter).
 * exactOptionalPropertyTypes: optional fields are `x?: T | undefined`, omitted
 * when absent.
 */

import type { Skill, SkillScope } from "../types"
import type { SkillRuntimeAuthority, SkillSetEnabledResult } from "./authority"

/** Default copy byte bound (1 MiB). A SKILL.md far past this is not a copy
 *  target — refuse with `too_large` rather than slurp unbounded bytes. */
export const DEFAULT_SKILL_COPY_MAX_BYTES = 1_048_576 as const

/**
 * The injected side-effect port for F5 actions. `@/skill` may not import
 * `@/storage` / node:fs, so the composition root wires the concrete fs +
 * OS-reveal effects (see `./adapters/node-skill-actions`); tests inject fakes.
 *
 * `resolveCanonicalSkill` is the ACTION-TIME re-resolution seam — it MUST read
 * the LIVE winner (a re-scan or a live-authority read), NOT a value captured
 * when the surface was constructed, or RED (a) reopens.
 */
export interface SkillActionPorts {
  /** Re-resolve the canonical precedence-winner skill BY NAME at ACTION TIME.
   *  Returns the live winner (with its current on-disk `sourcePath`), or
   *  `undefined` when no skill of that name is discoverable now. */
  resolveCanonicalSkill(name: string): Promise<Skill | undefined>
  /** Byte size of an ABSOLUTE path — checked BEFORE the read so an oversize file
   *  is refused without being slurped. */
  statBytes(absPath: string): Promise<number>
  /** Read the full UTF-8 bytes of an ABSOLUTE path (the RAW markdown, frontmatter
   *  included). Called only after the jail + bound pass. */
  readFileUtf8(absPath: string): Promise<string>
  /** Resolve the REAL (symlink-followed) absolute path — the path-jail anchor.
   *  A symlinked `sourcePath` escaping the skill dir is caught here. */
  realpath(absPath: string): Promise<string>
  /** OPTIONAL OS reveal-in-file-manager capability. ABSENT ⇒ {@link revealSkill}
   *  returns the typed `unsupported` receipt (never a silent success). */
  reveal?(absPath: string): Promise<void>
}

/* ------------------------------------------------------------------------- *
 * copy — bounded raw-markdown, action-time re-resolved, path-jailed.
 * ------------------------------------------------------------------------- */

/** Why a {@link copySkillMarkdown} refused — every arm a typed negative. */
export type SkillCopyRejection =
  | { readonly kind: "unknown_skill"; readonly name: string }
  | { readonly kind: "path_jail"; readonly name: string; readonly detail: string }
  | {
      readonly kind: "too_large"
      readonly name: string
      readonly bytes: number
      readonly limit: number
    }
  | { readonly kind: "read_failed"; readonly name: string; readonly detail: string }

export type SkillCopyResult =
  | {
      readonly ok: true
      readonly name: string
      readonly scope: SkillScope
      readonly sourcePath: string
      readonly markdown: string
      readonly bytes: number
    }
  | { readonly ok: false; readonly rejection: SkillCopyRejection }

/** Directory that JAILS a skill's readable bytes — the winner's own directory.
 *  For both directory-form (`<dir>/SKILL.md`) and file-form (`<dir>/foo.md`)
 *  skills the source file lives directly in this dir, so a real path that does
 *  not sit under it (a symlink / repurpose escape) is out of jail. */
const skillDirOf = (sourcePath: string): string => {
  const norm = sourcePath.replace(/[/\\]+$/u, "")
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"))
  return cut <= 0 ? norm : norm.slice(0, cut)
}

/** True when `realFile` is inside `realDir` (path-segment containment, not a
 *  bare string prefix — `/a/skillx` must NOT count as inside `/a/skill`). */
const isInsideDir = (realFile: string, realDir: string): boolean => {
  if (realFile === realDir) return false
  const dir = realDir.replace(/[/\\]+$/u, "")
  return realFile.startsWith(`${dir}/`) || realFile.startsWith(`${dir}\\`)
}

/**
 * RFC-06 F5 (a)/(b) — copy a skill's RAW on-disk markdown, re-resolving the
 * canonical winner BY NAME at ACTION TIME and reading its current `sourcePath`
 * bytes under a path-jail + byte-bound. A disk mutation that landed after the
 * surface was built IS reflected (the resolve + read both happen now); a
 * symlink/repurpose escape or an oversize file is a typed refusal.
 */
export const copySkillMarkdown = async (
  ports: SkillActionPorts,
  args: { readonly name: string; readonly maxBytes?: number },
): Promise<SkillCopyResult> => {
  const limit = args.maxBytes ?? DEFAULT_SKILL_COPY_MAX_BYTES
  // ACTION-TIME re-resolution — never a construction-time captured Skill.
  const skill = await ports.resolveCanonicalSkill(args.name)
  if (skill === undefined)
    return { ok: false, rejection: { kind: "unknown_skill", name: args.name } }
  const sourcePath = skill.sourcePath
  const jailDir = skillDirOf(sourcePath)
  // PATH-JAIL — the real (symlink-followed) file must stay under the skill dir.
  let realFile: string
  let realDir: string
  try {
    realFile = await ports.realpath(sourcePath)
    realDir = await ports.realpath(jailDir)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, rejection: { kind: "read_failed", name: args.name, detail } }
  }
  if (!isInsideDir(realFile, realDir)) {
    return {
      ok: false,
      rejection: {
        kind: "path_jail",
        name: args.name,
        detail: `resolved source ${realFile} escapes skill dir ${realDir}`,
      },
    }
  }
  // BOUND before read — refuse oversize without slurping.
  let bytes: number
  try {
    bytes = await ports.statBytes(realFile)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, rejection: { kind: "read_failed", name: args.name, detail } }
  }
  if (bytes > limit) {
    return { ok: false, rejection: { kind: "too_large", name: args.name, bytes, limit } }
  }
  let markdown: string
  try {
    markdown = await ports.readFileUtf8(realFile)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, rejection: { kind: "read_failed", name: args.name, detail } }
  }
  return {
    ok: true,
    name: skill.name,
    scope: skill.scope ?? "builtIn",
    sourcePath,
    markdown,
    bytes,
  }
}

/* ------------------------------------------------------------------------- *
 * reveal — capability-based; absent capability ⇒ typed unsupported.
 * ------------------------------------------------------------------------- */

/** Why a {@link revealSkill} refused — `unsupported` is the capability-absence
 *  negative that must never masquerade as success (RFC-06 F5 RED (c)). */
export type SkillRevealRejection =
  | { readonly kind: "unknown_skill"; readonly name: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "reveal_failed"; readonly name: string; readonly detail: string }

export type SkillRevealResult =
  | { readonly ok: true; readonly name: string; readonly sourcePath: string }
  | { readonly ok: false; readonly rejection: SkillRevealRejection }

/**
 * RFC-06 F5 (c) — reveal a skill's source in the OS file manager, re-resolving
 * the canonical winner at ACTION TIME. When the surface wired NO reveal
 * capability the result is the DISTINCT typed `unsupported` receipt — the
 * absence is legible, never a silent success.
 */
export const revealSkill = async (
  ports: SkillActionPorts,
  args: { readonly name: string },
): Promise<SkillRevealResult> => {
  const skill = await ports.resolveCanonicalSkill(args.name)
  if (skill === undefined)
    return { ok: false, rejection: { kind: "unknown_skill", name: args.name } }
  if (ports.reveal === undefined) return { ok: false, rejection: { kind: "unsupported" } }
  try {
    await ports.reveal(skill.sourcePath)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, rejection: { kind: "reveal_failed", name: args.name, detail } }
  }
  return { ok: true, name: skill.name, sourcePath: skill.sourcePath }
}

/* ------------------------------------------------------------------------- *
 * enable / disable — CAS through the F1 authority. NO delete (F6 PARKED).
 * ------------------------------------------------------------------------- */

/**
 * RFC-06 F5 — enable/disable a skill by CAS through the F1 authority. The
 * CALLER's `expectedRevision` is forwarded VERBATIM — this function NEVER
 * self-reads `authority.read().revision`, because a self-read would make every
 * mutation appear fresh and silently defeat the stale-revision rejection (RED
 * (b)). A stale caller therefore gets the authority's typed `stale_revision`
 * rejection; a required/banned policy denial and an unknown skill are the F1
 * typed negatives. There is NO delete/uninstall arm (F6 PARKED).
 */
export const setSkillEnabledAction = (
  authority: SkillRuntimeAuthority,
  args: { readonly name: string; readonly enabled: boolean; readonly expectedRevision: number },
): Promise<SkillSetEnabledResult> =>
  authority.setEnabled(args.name, args.enabled, args.expectedRevision)
