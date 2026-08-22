/**
 * ADR-0221 — Caller-constructed directive shape validation.
 *
 * Even with TS types, a JS-side caller (or a typed caller that downcasts
 * `unknown`) can construct a malformed directive. We pin a small set of
 * structural checks so the emitter rejects garbage BEFORE serialization +
 * sink-write — keeping the public surface no-throw and giving the caller a
 * typed `invalid-directive` error with a human-readable reason.
 *
 * The checks here are deliberately minimal — they catch the shape failures
 * that would otherwise produce broken wire lines downstream. Semantic
 * validation (e.g. "branch name follows refspec rules") is the tool layer's
 * job, not the directive layer's.
 */

import { err, ok, type Result } from "@/shared"
import type { EmitError, GitDirective } from "./types"

type ValidatorOf<K extends GitDirective["kind"]> = (
  d: Extract<GitDirective, { kind: K }>,
) => Result<void, EmitError>

const validateCreateBranch: ValidatorOf<"create-branch"> = (d) => {
  if (typeof d.name !== "string" || d.name.length === 0) {
    return reason("create-branch.name must be non-empty string")
  }
  return ok(undefined)
}

const validateStage: ValidatorOf<"stage"> = (d) => {
  if (!Array.isArray(d.files)) return reason("stage.files must be array")
  for (const p of d.files) {
    if (typeof p !== "string") return reason("stage.files[*] must be string")
  }
  return ok(undefined)
}

const validateCommit: ValidatorOf<"commit"> = (d) => {
  if (typeof d.sha !== "string" || d.sha.length === 0) {
    return reason("commit.sha must be non-empty string")
  }
  if (typeof d.message !== "string") return reason("commit.message must be string")
  return ok(undefined)
}

const validatePush: ValidatorOf<"push"> = (d) => {
  if (typeof d.ref !== "string" || d.ref.length === 0) {
    return reason("push.ref must be non-empty string")
  }
  if (typeof d.force !== "boolean") return reason("push.force must be boolean")
  return ok(undefined)
}

const validateCreatePr: ValidatorOf<"create-pr"> = (d) => {
  if (typeof d.url !== "string" || d.url.length === 0) {
    return reason("create-pr.url must be non-empty string")
  }
  if (typeof d.isDraft !== "boolean") return reason("create-pr.isDraft must be boolean")
  return ok(undefined)
}

/** Structural validation for a caller-constructed directive. */
export const validateDirective = (d: GitDirective): Result<void, EmitError> => {
  switch (d.kind) {
    case "create-branch":
      return validateCreateBranch(d)
    case "stage":
      return validateStage(d)
    case "commit":
      return validateCommit(d)
    case "push":
      return validatePush(d)
    case "create-pr":
      return validateCreatePr(d)
  }
}

const reason = (s: string): Result<void, EmitError> => err({ kind: "invalid-directive", reason: s })
