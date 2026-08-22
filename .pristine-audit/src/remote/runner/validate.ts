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
 */

import { err, ok, type Result } from "@/shared"
import type { RemoteSpec } from "./types"
import { RemoteError } from "./types"

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/

export const validateSpec = (spec: RemoteSpec): Result<true, RemoteError> => {
  if (typeof spec.image !== "string" || spec.image.trim() === "") {
    return err(new RemoteError("invalid-spec", "image must be a non-empty string"))
  }
  if (!Array.isArray(spec.cmd)) {
    return err(new RemoteError("invalid-spec", "cmd must be an array"))
  }
  if (spec.env !== undefined && spec.env !== null) {
    for (const k of Object.keys(spec.env)) {
      if (!ENV_KEY.test(k)) {
        return err(new RemoteError("invalid-spec", `env key invalid: ${k}`))
      }
    }
  }
  if (spec.timeoutMs !== undefined) {
    const t = spec.timeoutMs
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      return err(new RemoteError("invalid-spec", `timeoutMs invalid: ${String(spec.timeoutMs)}`))
    }
  }
  if (spec.mounts !== undefined) {
    for (const m of spec.mounts) {
      if (typeof m.source !== "string" || m.source === "") {
        return err(new RemoteError("invalid-spec", "mount.source empty"))
      }
      if (typeof m.target !== "string" || m.target === "") {
        return err(new RemoteError("invalid-spec", "mount.target empty"))
      }
    }
  }
  return ok(true)
}
