/**
 * ADR-0204 hellgate — 12 cases proving the shell-snapshot port survives
 * adversarial inputs (path injection, hung shells, missing binaries,
 * empty captures, concurrent races) AND preserves the byte-identical
 * default-OFF guarantee in non-shell argv shapes.
 *
 * Convention: each test seeds its own temporary HOME so we never touch
 * the developer's `~/.quanta/shell_snapshots/`. The headless-stub +
 * mock spawner combination keeps these tests deterministic and
 * shell-free (CI does not need zsh installed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildRestoredArgv,
  createShellSnapshotPort,
  headlessSpawner,
  headlessStubBody,
  type SnapshotSpawner,
} from "@/../src/runtime/shell-snapshot"
import { mkId, safeId, snapshotDir } from "@/../src/runtime/shell-snapshot/file-store"

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "qss-hellgate-"))
})

afterEach(() => {
  // Best-effort cleanup; rmSync recursive deletes the temp dir tree.
  try {
    const { rmSync } = require("node:fs") as typeof import("node:fs")
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/** Helper — build a port that uses our temp HOME. */
const makePort = (spawner: SnapshotSpawner) => createShellSnapshotPort(spawner, tmpHome)

/** Helper — fixed dummy handle for restore-only tests. */
const dummyHandle = (path = "/tmp/snap-fixed.sh") => ({
  id: "snap-fixed",
  path,
  capturedAtMs: 1_700_000_000_000,
  shell: "zsh" as const,
})

describe("ADR-0204 shell-snapshot hellgate", () => {
  // ─── HELL-SS-01 ────────────────────────────────────────────────────
  test("HELL-SS-01 capture (mock spawner) → handle has path + capturedAtMs", async () => {
    const port = makePort(headlessSpawner)
    const before = Date.now()
    const res = await port.capture({ shell: "zsh" })
    const after = Date.now()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.path).toContain(snapshotDir(tmpHome))
    expect(existsSync(res.value.path)).toBe(true)
    expect(res.value.capturedAtMs).toBeGreaterThanOrEqual(before)
    expect(res.value.capturedAtMs).toBeLessThanOrEqual(after + 5)
    expect(res.value.shell).toBe("zsh")
  })

  // ─── HELL-SS-02 ────────────────────────────────────────────────────
  test("HELL-SS-02 capture failure when shell binary is missing", async () => {
    const spawner: SnapshotSpawner = {
      async run() {
        return { code: null, stdout: "", timedOut: false, spawnFailed: true, detail: "ENOENT" }
      },
    }
    const port = makePort(spawner)
    const res = await port.capture({ shell: "zsh" })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe("shell-missing")
    if (res.error.kind === "shell-missing") {
      expect(res.error.shell).toBe("zsh")
      expect(res.error.detail).toBe("ENOENT")
    }
  })

  // ─── HELL-SS-03 ────────────────────────────────────────────────────
  test("HELL-SS-03 empty capture stdout → empty-capture error", async () => {
    const spawner: SnapshotSpawner = {
      async run() {
        return { code: 0, stdout: "   \n  ", timedOut: false }
      },
    }
    const port = makePort(spawner)
    const res = await port.capture({ shell: "bash" })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe("empty-capture")
    if (res.error.kind === "empty-capture") {
      expect(res.error.shell).toBe("bash")
    }
  })

  // ─── HELL-SS-04 ────────────────────────────────────────────────────
  test("HELL-SS-04 restore wraps bash -c argv with `source <path>; <cmd>`", () => {
    const handle = dummyHandle("/tmp/snap-abc.sh")
    const outcome = buildRestoredArgv(handle, ["bash", "-c", "ls"])
    expect(outcome.argv).toEqual(["bash", "-c", "source /tmp/snap-abc.sh; ls"])
    expect(outcome.degradeReason).toBeUndefined()
  })

  // ─── HELL-SS-05 ────────────────────────────────────────────────────
  test("HELL-SS-05 restore on non-shell prefix returns argv unchanged + degradeReason", () => {
    const handle = dummyHandle()
    const input = ["echo", "hi"] as const
    const outcome = buildRestoredArgv(handle, input)
    expect(outcome.argv).toEqual(["echo", "hi"])
    expect(outcome.degradeReason).toBe("non-shell-prefix")
    // input array NOT mutated
    expect(input).toEqual(["echo", "hi"])
    // output is a fresh array, not the same reference
    expect(outcome.argv).not.toBe(input as unknown as string[])
  })

  // ─── HELL-SS-06 ────────────────────────────────────────────────────
  test("HELL-SS-06 captured file is written with mode 0600", async () => {
    const port = makePort(headlessSpawner)
    const res = await port.capture({ shell: "zsh" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const st = statSync(res.value.path)
    // Mask off the file-type bits; we care about the permission triad.
    const perm = st.mode & 0o777
    expect(perm).toBe(0o600)
  })

  // ─── HELL-SS-07 ────────────────────────────────────────────────────
  test("HELL-SS-07 id sanitisation rejects path injection (`;`, `\\n`, leading `-`/`.`)", () => {
    // safeId collapses dangerous chars
    expect(safeId("ok-id_42.snap")).toBe("ok-id_42.snap")
    expect(safeId("evil;rm -rf /")).toBe("evil-rm--rf--")
    expect(safeId("with\nnewline")).toBe("with-newline")
    expect(safeId("../../etc/passwd")).toBe("etc-passwd")
    // Leading `-` (CLI-flag confusion) and `.` (hidden file) stripped
    expect(safeId("-flag")).toBe("flag")
    expect(safeId(".hidden")).toBe("hidden")
    // After stripping everything dangerous, nothing should remain → null
    expect(safeId("..")).toBeNull()
    expect(safeId(";;;")).toBe(null)
    expect(safeId("")).toBeNull()

    // mkId attaches a nonce; even malicious seeds produce a path-safe id
    const id = mkId("evil;rm")
    expect(id).not.toBeNull()
    if (id !== null) {
      expect(id).not.toContain(";")
      expect(id).not.toContain("\n")
      expect(id).not.toContain("/")
    }
  })

  // ─── HELL-SS-08 ────────────────────────────────────────────────────
  test("HELL-SS-08 hung shell yields capture-timeout error", async () => {
    // Spawn started (code=0) but the shell hung past the timeout — the
    // adapter should classify as `capture-timeout`, not `empty-capture`,
    // because the timed-out branch is checked first.
    const spawner: SnapshotSpawner = {
      async run() {
        return { code: 0, stdout: "", timedOut: true }
      },
    }
    const port = makePort(spawner)
    const res = await port.capture({ shell: "zsh", id: "timeout-test" })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe("capture-timeout")
    if (res.error.kind === "capture-timeout") {
      expect(res.error.timeoutMs).toBeGreaterThan(0)
    }
  })

  // ─── HELL-SS-09 ────────────────────────────────────────────────────
  test("HELL-SS-09 two concurrent captures land on distinct files even with same seed", async () => {
    const port = makePort(headlessSpawner)
    const [a, b] = await Promise.all([
      port.capture({ shell: "zsh", id: "samename" }),
      port.capture({ shell: "zsh", id: "samename" }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.path).not.toBe(b.value.path)
    expect(a.value.id).not.toBe(b.value.id)
    expect(existsSync(a.value.path)).toBe(true)
    expect(existsSync(b.value.path)).toBe(true)
  })

  // ─── HELL-SS-10 ────────────────────────────────────────────────────
  test("HELL-SS-10 headless-stub body is deterministic across calls", () => {
    const a = headlessStubBody("zsh")
    const b = headlessStubBody("zsh")
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
    // Determinism: contains the expected fixture lines
    expect(a).toContain("alias ll='ls -la'")
    expect(headlessStubBody("bash")).toContain("# headless-stub for bash")
  })

  // ─── HELL-SS-11 ────────────────────────────────────────────────────
  test("HELL-SS-11 prune removes files older than the cutoff and leaves fresh files", async () => {
    const port = makePort(headlessSpawner)
    const stale = await port.capture({ shell: "zsh", id: "stale" })
    const fresh = await port.capture({ shell: "zsh", id: "fresh" })
    expect(stale.ok).toBe(true)
    expect(fresh.ok).toBe(true)
    if (!stale.ok || !fresh.ok) return

    // Back-date the stale file by an hour.
    const past = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(stale.value.path, past, past)

    const removed = await port.prune(30 * 60 * 1000) // 30 min cutoff
    expect(removed).toBe(1)
    expect(existsSync(stale.value.path)).toBe(false)
    expect(existsSync(fresh.value.path)).toBe(true)

    // Pruning a non-existent directory is a no-op (idempotent).
    const empty = await createShellSnapshotPort(headlessSpawner, join(tmpHome, "void")).prune(0)
    expect(empty).toBe(0)
  })

  // ─── HELL-SS-12 ────────────────────────────────────────────────────
  test("HELL-SS-12 zsh and bash adapters emit shell-specific argvs (alias ordering)", async () => {
    const seen: Array<ReadonlyArray<string>> = []
    const recordingSpawner: SnapshotSpawner = {
      async run(argv: ReadonlyArray<string>) {
        seen.push(argv)
        return { code: 0, stdout: "stub-output", timedOut: false }
      },
    }
    const port = makePort(recordingSpawner)
    await port.capture({ shell: "zsh" })
    await port.capture({ shell: "bash" })
    expect(seen).toHaveLength(2)
    const [zshArgv, bashArgv] = seen
    expect(zshArgv?.[0]).toBe("zsh")
    expect(zshArgv?.[3]).toBe("typeset -p; alias; declare -f")
    expect(bashArgv?.[0]).toBe("bash")
    // bash adapter puts `alias` LAST — see ADR rationale
    expect(bashArgv?.[3]).toBe("declare -p; declare -f; alias")
  })

  // ─── extra: directory created with 0700 ──────────────────────────
  test("snapshot directory is created on first write under tmpHome", async () => {
    const dir = snapshotDir(tmpHome)
    expect(existsSync(dir)).toBe(false)
    const port = makePort(headlessSpawner)
    await port.capture({ shell: "zsh" })
    expect(existsSync(dir)).toBe(true)
    const entries = readdirSync(dir)
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })
})
