/**
 * PR-5 self-audit fix: compile-time bidirectional assignability check between
 * `ShellExecEvent` (canonical, owned by `@/tool/shell-exec-types`) and
 * `RunShellEvent` (structural mirror in `@/runtime/types`, kept there so
 * `@/runtime` does NOT depend on `@/tool`).
 *
 * The ADR-0081 self-audit found the original promise of "verified by a
 * compile-time assignability check in src/runtime/shell.ts" was vacuous: the
 * two unions were sibling-defined without any cross-check. This test file is
 * the canonical defense — it cannot live in src/ because that would re-create
 * the runtime → tool import the slice boundary forbids. As a test file it
 * imports both freely; if either union drifts the type assertions below fail
 * to compile and `bun run typecheck` (and `bun test`) refuse the change.
 *
 * The assertions are TYPE-ONLY: the bottom-tuple is a thin runtime artifact
 * needed to keep the file a valid module — its types do the work.
 */
import { describe, expect, test } from "bun:test"
import type { RunShellEvent } from "@/runtime/types"
import type { ShellExecEvent } from "@/tool/shell-exec-types"

// Bidirectional structural-assignability check. If RunShellEvent gains a
// variant ShellExecEvent doesn't have (or vice versa) one of these two
// conditional types resolves to `never`, and the `const _check` line below
// fails to compile.
type _RunIsExec = RunShellEvent extends ShellExecEvent ? true : never
type _ExecIsRun = ShellExecEvent extends RunShellEvent ? true : never

const _check: readonly [_RunIsExec, _ExecIsRun] = [true, true]

describe("PR-5 self-audit — RunShellEvent ↔ ShellExecEvent compile-time mirror", () => {
  test("the bidirectional assignability check holds at runtime witness", () => {
    // The real work is in the type system above. This runtime probe exists so
    // a test discovery / CI step that filters by file count still sees a
    // green test; the failure mode is `tsc --noEmit` refusing to compile.
    expect(_check).toEqual([true, true])
  })
})
