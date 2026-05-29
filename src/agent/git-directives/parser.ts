/**
 * ADR-0220 — Round-trip parser for `::git-*` directives.
 *
 * Consumes a single line and returns either a typed `GitDirective` or a
 * typed `GitDirectiveParseError`. NEVER throws — UI tail loops that hit a
 * corrupt frame must keep running.
 *
 * Validation strategy:
 *   1. Anchor check: line must start with `::git-`. Anything else returns
 *      `not-a-directive` (the line is not ours; the host can pass it
 *      through to whatever other consumer owns it).
 *   2. Split kind and JSON body at the first `{`.
 *   3. Validate `kind` against the closed enum.
 *   4. `JSON.parse` the body — on failure, `malformed-directive`.
 *   5. Per-kind shape check on the parsed object.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import { GIT_DIRECTIVE_KINDS, type GitDirective, type GitDirectiveParseError } from "./types"

const PREFIX = "::git-"

/** Parse a single line into a directive or a typed error. */
export const parse = (line: string): Result<GitDirective, GitDirectiveParseError> => {
  if (!line.startsWith(PREFIX)) return err({ kind: "not-a-directive" })
  const afterPrefix = line.slice(PREFIX.length)
  const braceIdx = afterPrefix.indexOf("{")
  if (braceIdx < 0) {
    return err({ kind: "malformed-directive", reason: "missing JSON body" })
  }
  const kindStr = afterPrefix.slice(0, braceIdx)
  const body = afterPrefix.slice(braceIdx)
  if (!isKnownKind(kindStr)) {
    return err({ kind: "unknown-kind", received: kindStr })
  }
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (e) {
    return err({
      kind: "malformed-directive",
      reason: errMessage(e),
    })
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return err({ kind: "shape-mismatch", reason: "payload is not an object" })
  }
  return buildDirective(kindStr, payload as Record<string, unknown>)
}

const isKnownKind = (s: string): s is GitDirective["kind"] =>
  (GIT_DIRECTIVE_KINDS as readonly string[]).includes(s)

type Builder = (body: Record<string, unknown>) => Result<GitDirective, GitDirectiveParseError>

const shape = (reason: string): Result<GitDirective, GitDirectiveParseError> =>
  err({ kind: "shape-mismatch", reason })

const buildCreateBranch: Builder = (body) =>
  typeof body.name === "string"
    ? ok({ kind: "create-branch", name: body.name })
    : shape("create-branch.name must be string")

const buildStage: Builder = (body) => {
  const paths = body.paths
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string")) {
    return shape("stage.paths must be string[]")
  }
  // Freeze so HELL-GD-13 round-trip yields an immutable array.
  return ok({ kind: "stage", paths: Object.freeze([...paths]) })
}

const buildCommit: Builder = (body) => {
  if (typeof body.sha !== "string") return shape("commit.sha must be string")
  if (typeof body.message !== "string") return shape("commit.message must be string")
  return ok({ kind: "commit", sha: body.sha, message: body.message })
}

const buildPush: Builder = (body) => {
  if (typeof body.remote !== "string") return shape("push.remote must be string")
  if (typeof body.branch !== "string") return shape("push.branch must be string")
  return ok({ kind: "push", remote: body.remote, branch: body.branch })
}

const buildCreatePr: Builder = (body) => {
  if (typeof body.url !== "string") return shape("create-pr.url must be string")
  if (typeof body.isDraft !== "boolean") return shape("create-pr.isDraft must be boolean")
  return ok({ kind: "create-pr", url: body.url, isDraft: body.isDraft })
}

const BUILDERS: Record<GitDirective["kind"], Builder> = {
  "create-branch": buildCreateBranch,
  stage: buildStage,
  commit: buildCommit,
  push: buildPush,
  "create-pr": buildCreatePr,
}

const buildDirective = (
  kind: GitDirective["kind"],
  body: Record<string, unknown>,
): Result<GitDirective, GitDirectiveParseError> => BUILDERS[kind](body)
