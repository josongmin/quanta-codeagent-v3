/** RFC-02 B1 — pure `DiffSource` → `GitDiffOperation` resolver.
 *
 *  Semantics only: no process, fs, or global env. All git reads go through the
 *  injected {@link GitReadPort}. Missing/ambiguous refs fail CLOSED with a typed
 *  reason — there is NO silent fallback to the working tree or branch default.
 *
 *  `branch-base` is deliberately NOT peeled to oids: it stays symbolic
 *  (`origin/main...HEAD`) so the unset/default source is byte-identical to the
 *  review tool's current argv. `commit`/`range` ARE peeled so a bad ref fails
 *  before any diff runs. */

import type { GitReadPort } from "./ports"
import {
  type DiffSource,
  type DiffSourceResolution,
  type DiffSourceUnavailableReason,
  EMPTY_TREE_OID,
} from "./types"

/** Reject an operand that would be parsed by `git` as an option. */
const invalidRef = (field: string, value: string): DiffSourceUnavailableReason | null =>
  value.startsWith("-") ? { kind: "invalid-ref", field, value } : null

const fail = (reason: DiffSourceUnavailableReason): DiffSourceResolution => ({ ok: false, reason })

const assertNever = (x: never): never => {
  throw new Error(`unhandled DiffSource arm: ${JSON.stringify(x)}`)
}

const resolveBranchBase = (source: { base?: string | undefined }): DiffSourceResolution => {
  const base = source.base ?? "origin/main"
  const head = "HEAD"
  const bad = invalidRef("base", base) ?? invalidRef("head", head)
  if (bad) return fail(bad)
  // Symbolic on purpose (byte-identical default) — no port peel.
  return { ok: true, operation: { kind: "branch-merge-base", base, head } }
}

const resolveCommitSource = async (
  source: { oid: string },
  port: GitReadPort,
): Promise<DiffSourceResolution> => {
  const bad = invalidRef("oid", source.oid)
  if (bad) return fail(bad)
  const commit = await port.resolveCommit(source.oid)
  if (commit === null) return fail({ kind: "unresolvable-ref", field: "oid", value: source.oid })
  // First-parent: `<commit>~1`. Absent ⇒ ROOT commit ⇒ empty-tree base.
  const parent = await port.resolveCommit(`${commit}~1`)
  const base = parent ?? EMPTY_TREE_OID
  return { ok: true, operation: { kind: "commit-first-parent", base, commit } }
}

const resolveRangeSource = async (
  source: { from: string; to: string },
  port: GitReadPort,
): Promise<DiffSourceResolution> => {
  const bad = invalidRef("from", source.from) ?? invalidRef("to", source.to)
  if (bad) return fail(bad)
  const from = await port.resolveCommit(source.from)
  if (from === null) return fail({ kind: "unresolvable-ref", field: "from", value: source.from })
  const to = await port.resolveCommit(source.to)
  if (to === null) return fail({ kind: "unresolvable-ref", field: "to", value: source.to })
  return { ok: true, operation: { kind: "tree-range", from, to } }
}

/** Resolve a closed {@link DiffSource} to a {@link GitDiffOperation}, or a typed
 *  fail-closed reason. Deterministic given a deterministic port. */
export const resolveDiffSource = async (
  source: DiffSource,
  port: GitReadPort,
): Promise<DiffSourceResolution> => {
  switch (source.kind) {
    case "branch-base":
      return resolveBranchBase(source)
    case "commit":
      return resolveCommitSource(source, port)
    case "range":
      return resolveRangeSource(source, port)
    default:
      return assertNever(source)
  }
}
