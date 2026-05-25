/**
 * ADR-0204 wire hellgate — runShell × ShellSnapshot seam.
 *
 * 3 invariants on the opt-in `shellSnapshot` option added to `ShellOptions`:
 *
 *   HELL-SS-WIRE-01  default-OFF byte-identical — absent seam ⇒ runShell
 *                    spawns `bash -lc <cmd>` verbatim, no restore call.
 *   HELL-SS-WIRE-02  present seam ⇒ runShell calls `restore(handle, argv)`
 *                    exactly once with the prefix sandboxed argv; the
 *                    spawned argv reflects the restore-augmented form
 *                    (verified end-to-end via the actual bash exec that
 *                    sources the snapshot file).
 *   HELL-SS-WIRE-03  seam.restore can be a passthrough (no-op shape) and
 *                    runShell still produces a normal `ShellResult` — the
 *                    wire never crashes the run regardless of restore body.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "@/runtime"
import type { ShellSnapshotRestoreSeam } from "@/runtime/types"

// ---------------------------------------------------------------------------
// Harness: build a tiny snapshot file that exports a known variable, then
// observe whether the spawned shell saw it.
// ---------------------------------------------------------------------------

let workDir: string
let snapPath: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "quanta-shell-snap-wire-"))
  snapPath = join(workDir, "snap.sh")
  // The snapshot exports HELLGATE_MARK so a child bash invocation can echo
  // it back — proving the snapshot was actually sourced into argv.
  writeFileSync(snapPath, "export HELLGATE_MARK=present\n", "utf8")
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const stubSeam = (): { seam: ShellSnapshotRestoreSeam; calls: { n: number } } => {
  const calls = { n: 0 }
  const seam: ShellSnapshotRestoreSeam = {
    handle: { id: "test", path: snapPath },
    restore(handle, prefix) {
      calls.n += 1
      // Mimic the production `buildRestoredArgv` shape: if the prefix looks
      // like `*sh -lc <cmd>`, fold a `source <path>; <cmd>` into the cmd
      // slot. Tests use the simplest shape: 3-arg `bash -lc cmd`.
      if (prefix.length === 3 && prefix[1] === "-lc") {
        const original = prefix[2] ?? ""
        return { argv: [prefix[0] ?? "bash", "-lc", `source ${handle.path}; ${original}`] }
      }
      return { argv: [...prefix] }
    },
  }
  return { seam, calls }
}

// ---------------------------------------------------------------------------
// HELL-SS-WIRE-01: default-OFF byte-identical
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-01 default-OFF byte-identical", () => {
  test("absent shellSnapshot: HELLGATE_MARK is unset (snapshot never sourced)", async () => {
    const r = await runShell("echo MARK=${HELLGATE_MARK:-unset}", { cwd: workDir })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("MARK=unset")
  })
})

// ---------------------------------------------------------------------------
// HELL-SS-WIRE-02: seam exercised → restore called + argv augmented
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-02 seam present → restore called + argv reflects source", () => {
  test("snapshot seam wired: HELLGATE_MARK=present from sourced snapshot", async () => {
    const { seam, calls } = stubSeam()
    const r = await runShell("echo MARK=${HELLGATE_MARK:-unset}", {
      cwd: workDir,
      shellSnapshot: seam,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("MARK=present")
    expect(calls.n).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// HELL-SS-WIRE-03: passthrough restore body still completes the run
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-03 passthrough seam still produces ShellResult", () => {
  test("seam.restore is identity → run still succeeds, HELLGATE_MARK unset", async () => {
    const calls = { n: 0 }
    const seam: ShellSnapshotRestoreSeam = {
      handle: { id: "noop", path: snapPath },
      restore(_h, prefix) {
        calls.n += 1
        return { argv: [...prefix] }
      },
    }
    const r = await runShell("echo MARK=${HELLGATE_MARK:-unset}", {
      cwd: workDir,
      shellSnapshot: seam,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe("MARK=unset")
    expect(calls.n).toBe(1)
  })
})
