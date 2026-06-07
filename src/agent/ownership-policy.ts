/**
 * §20.4 / ticket-12 — subagent FS owned/forbidden ENFORCEMENT.
 *
 * RCA: `ownedSurfaces`/`forbiddenSurfaces` were injected into the child seed as
 * ADVISORY prompt text only — an LLM that ignores them writes anywhere. This is
 * the hard fence: a path-matcher consulted at the tool-dispatch FS-write seam so
 * a write outside the owned set (or inside the forbidden set) is DENIED.
 *
 * Semantics = SUBTREE containment (FS-natural; glob-free): an owned/forbidden
 * entry is a file (exact) OR a directory (owns its whole subtree). Matching runs
 * on SYMLINK-RESOLVED, `..`-normalized CANONICAL absolute paths (reusing the
 * jail's create-then-escape-proof `canonicalizePath`) so neither `..` nor a
 * symlink can smuggle a write out of the owned region. `forbidden` always wins
 * over `owned`. Default-OFF: `enforced !== true` ⇒ everything allowed (the
 * advisory legacy, byte-identical).
 *
 * The pure core operates on CANONICAL paths + pre-extracted write-effects so it
 * is fully hellgate-testable; the fs-canonicalization (`canonicalizePath`) and
 * the write-target extraction (`extractWriteEffects`, incl. bash `sed -i`/
 * redirect) are reused proven modules — the gate just composes them.
 */

import isPathInside from "is-path-inside"
import { canonicalizePath } from "@/storage"

export interface OwnershipPolicy {
  /** Owned files/dirs — CANONICAL absolute paths. Empty/absent ⇒ no whitelist
   *  (only `forbidden` restricts). */
  readonly owned?: readonly string[]
  /** Forbidden files/dirs — CANONICAL absolute paths. Always wins over owned. */
  readonly forbidden?: readonly string[]
  /** Hard gate. `false`/absent ⇒ advisory-only legacy (byte-identical). */
  readonly enforced?: boolean
}

/** True iff `target` is `dir` itself or inside its subtree (both canonical). */
const insideOrEqual = (target: string, dir: string): boolean =>
  target === dir || isPathInside(target, dir)

/** Verdict for ONE canonical target path against the policy. Pure. */
export const isPathAllowed = (
  targetCanonical: string,
  policy: OwnershipPolicy | undefined,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned" } => {
  if (policy?.enforced !== true) return { allowed: true }
  if (policy.forbidden?.some((d) => insideOrEqual(targetCanonical, d))) {
    return { allowed: false, reason: "forbidden" }
  }
  if (
    policy.owned !== undefined &&
    policy.owned.length > 0 &&
    !policy.owned.some((d) => insideOrEqual(targetCanonical, d))
  ) {
    return { allowed: false, reason: "not_owned" }
  }
  return { allowed: true }
}

/** Consult the policy over a tool call's extracted write-effects (canonical
 *  paths from `extractWriteEffects`). Denies on the FIRST violating path. A
 *  read-only call (no effects) is always allowed. Pure. */
export const consultOwnershipPolicy = (
  effects: readonly { readonly path: string }[],
  policy: OwnershipPolicy | undefined,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned"; path: string } => {
  if (policy?.enforced !== true) return { allowed: true }
  for (const e of effects) {
    const v = isPathAllowed(e.path, policy)
    if (!v.allowed) return { allowed: false, reason: v.reason, path: e.path }
  }
  return { allowed: true }
}

/** Gate-facing check over RAW extracted write-effects: re-canonicalizes each
 *  effect path with the SAME symlink-resolving `canonicalizePath` the policy was
 *  built with, THEN consults the policy. This is SECURITY-load-bearing — the
 *  circumvention extractor's `canonicalizeEffectPath` is LEXICAL-ONLY (resolves
 *  `..`/`.` but NOT symlinks), so comparing its output against a symlink-resolved
 *  policy boundary would be unsound (a `src/link → /secret` symlink would slip
 *  through). Re-canonicalizing both sides symlink-resolved closes that vector. */
export const checkWriteEffects = (
  effects: readonly { readonly path: string }[],
  policy: OwnershipPolicy | undefined,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned"; path: string } => {
  if (policy?.enforced !== true) return { allowed: true }
  return consultOwnershipPolicy(
    effects.map((e) => ({ path: canonicalizePath(e.path) })),
    policy,
  )
}

/** Build a policy from the raw subagent surfaces (relative or absolute strings),
 *  canonicalizing each against `cwd`. Returns `undefined` when neither side has
 *  any entry (⇒ the dispatch gate is never armed). */
export const buildOwnershipPolicy = (args: {
  readonly owned?: readonly string[]
  readonly forbidden?: readonly string[]
  readonly cwd: string
  readonly enforced: boolean
}): OwnershipPolicy | undefined => {
  const owned = (args.owned ?? []).filter((s) => s.trim().length > 0)
  const forbidden = (args.forbidden ?? []).filter((s) => s.trim().length > 0)
  if (owned.length === 0 && forbidden.length === 0) return undefined
  return {
    ...(owned.length > 0 ? { owned: owned.map((p) => canonicalizePath(p, args.cwd)) } : {}),
    ...(forbidden.length > 0
      ? { forbidden: forbidden.map((p) => canonicalizePath(p, args.cwd)) }
      : {}),
    enforced: args.enforced,
  }
}
