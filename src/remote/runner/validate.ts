/**
 * ADR-0288 — Spec validator shared by every adapter.
 *
 * Pure function — no I/O, no clock. Returns the same `RemoteError` shape
 * every adapter would, with kind `invalid-spec`.
 *
 * Rules (HELL-RR-02, HELL-RR-03):
 *   - `image` MUST be a non-empty, non-whitespace string.
 *   - `env` keys (when present) MUST match `[A-Z_][A-Z0-9_]*`. A `null`
 *     VALUE is allowed (delete-env convention from node:child_process).
 *   - `timeoutMs` (when present) MUST be a non-negative finite number.
 *     `0` is HONORED (immediate timeout — HELL-RR-07).
 *   - `mounts[i].source` / `target` MUST be non-empty strings.
 *
 * Structure: each rule above is ONE top-level `SpecCheck`, and `validateSpec`
 * is a walk over {@link SPEC_CHECKS} in declaration order. The rules are
 * mutually independent (no check reads another's result), so a table is the
 * honest shape — and it keeps each rule's own guards at nesting depth 0
 * instead of paying the guard→loop→condition nesting surcharge that made the
 * single inlined function score 25 on cognitive complexity.
 *
 * ORDER IS PART OF THE CONTRACT: the first failing check wins and its message
 * is returned verbatim, so `SPEC_CHECKS` MUST stay in the original
 * image → cmd → env → timeoutMs → mounts sequence.
 */

import { err, ok, type Result } from "@/shared"
import type { RemoteSpec } from "./types"
import { RemoteError } from "./types"

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/

/** One validation rule. Returns the failure to report, or `undefined` when
 *  the rule is satisfied (including "field absent, rule not applicable"). */
type SpecCheck = (spec: RemoteSpec) => RemoteError | undefined

const invalid = (message: string): RemoteError => new RemoteError("invalid-spec", message)

/** HELL-RR-02: `image` is the only REQUIRED string; whitespace-only is empty. */
const checkImage: SpecCheck = (spec) =>
  typeof spec.image !== "string" || spec.image.trim() === ""
    ? invalid("image must be a non-empty string")
    : undefined

/** `cmd` is required and must be an array (an empty array is legal — it means
 *  "use the image entrypoint"). */
const checkCmd: SpecCheck = (spec) =>
  Array.isArray(spec.cmd) ? undefined : invalid("cmd must be an array")

/** HELL-RR-03: env KEYS are constrained; a `null` VALUE is the documented
 *  delete-env convention and is deliberately NOT rejected here. The explicit
 *  `null` guard on the container is defensive — the declared type says
 *  `| undefined`, but a JSON-sourced spec can carry a literal `null`. */
const checkEnv: SpecCheck = (spec) => {
  if (spec.env === undefined || spec.env === null) return undefined
  for (const k of Object.keys(spec.env)) {
    if (!ENV_KEY.test(k)) return invalid(`env key invalid: ${k}`)
  }
  return undefined
}

/** HELL-RR-07: `0` is a HONORED immediate timeout, so the guard rejects only
 *  non-numbers, non-finite numbers, and negatives — never falsiness. */
const checkTimeoutMs: SpecCheck = (spec) => {
  if (spec.timeoutMs === undefined) return undefined
  const t = spec.timeoutMs
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
    return invalid(`timeoutMs invalid: ${String(spec.timeoutMs)}`)
  }
  return undefined
}

/** Both mount endpoints are non-empty strings. `source` is checked before
 *  `target` WITHIN each mount, and mounts are checked in array order, so a
 *  spec with several bad mounts reports the first offending endpoint. */
const checkMounts: SpecCheck = (spec) => {
  if (spec.mounts === undefined) return undefined
  for (const m of spec.mounts) {
    if (typeof m.source !== "string" || m.source === "") return invalid("mount.source empty")
    if (typeof m.target !== "string" || m.target === "") return invalid("mount.target empty")
  }
  return undefined
}

/** Declaration order IS the reporting order — see the module docstring. */
const SPEC_CHECKS: readonly SpecCheck[] = [
  checkImage,
  checkCmd,
  checkEnv,
  checkTimeoutMs,
  checkMounts,
]

export const validateSpec = (spec: RemoteSpec): Result<true, RemoteError> => {
  for (const check of SPEC_CHECKS) {
    const failure = check(spec)
    if (failure !== undefined) return err(failure)
  }
  return ok(true)
}
