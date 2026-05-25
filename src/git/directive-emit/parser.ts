/**
 * ADR-0221 — Wire-line parser for `::git-*` directives.
 *
 * Consumes one stdout/stderr line and returns either a typed `GitDirective`
 * or `null` (NEVER throws — tailing loops keep running across corrupt
 * frames). The prefix `::git-` is the ONLY anchor for line classification;
 * anything else returns `null` so the host can pass non-directive lines
 * through to its normal stdout consumer.
 *
 * Wire format: `::git-<kind><canonical-json>` (single line). Example:
 *
 *   ::git-create-pr{"isDraft":true,"url":"https://github.com/x/y/pull/1"}
 *
 * Round-trip with `serialize(d)` is locked by HELL-DE-05 and HELL-DE-06.
 */

import { GIT_DIRECTIVE_KINDS, type GitDirective } from "./types"

const PREFIX = "::git-"

/** Parse one line — returns the directive on success, `null` on any failure. */
export const parse = (line: string): GitDirective | null => {
  if (!line.startsWith(PREFIX)) return null
  const afterPrefix = line.slice(PREFIX.length)
  const braceIdx = afterPrefix.indexOf("{")
  if (braceIdx < 0) return null
  const kindStr = afterPrefix.slice(0, braceIdx)
  const body = afterPrefix.slice(braceIdx)
  if (!isKnownKind(kindStr)) return null
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null
  }
  return buildDirective(kindStr, payload as Record<string, unknown>)
}

const isKnownKind = (s: string): s is GitDirective["kind"] =>
  (GIT_DIRECTIVE_KINDS as readonly string[]).includes(s)

type Builder = (body: Record<string, unknown>) => GitDirective | null

const buildCreateBranch: Builder = (body) =>
  typeof body.name === "string" ? { kind: "create-branch", name: body.name } : null

const buildStage: Builder = (body) => {
  const files = body.files
  if (!Array.isArray(files) || !files.every((p): p is string => typeof p === "string")) {
    return null
  }
  return { kind: "stage", files: Object.freeze([...files]) }
}

const buildCommit: Builder = (body) => {
  if (typeof body.sha !== "string") return null
  if (typeof body.message !== "string") return null
  return { kind: "commit", sha: body.sha, message: body.message }
}

const buildPush: Builder = (body) => {
  if (typeof body.ref !== "string") return null
  if (typeof body.force !== "boolean") return null
  return { kind: "push", ref: body.ref, force: body.force }
}

const buildCreatePr: Builder = (body) => {
  if (typeof body.url !== "string") return null
  if (typeof body.isDraft !== "boolean") return null
  return { kind: "create-pr", url: body.url, isDraft: body.isDraft }
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
): GitDirective | null => BUILDERS[kind](body)
