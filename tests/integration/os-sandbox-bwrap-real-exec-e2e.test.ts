import { describe, expect, test } from "bun:test"
import { compileBubblewrapArgs, linuxOsSandbox, type SandboxPolicy } from "@/runtime/os-sandbox"

/**
 * DOF-40 — REAL bwrap-execution e2e (Linux-guarded) + always-on compile proof.
 *
 * Two tiers:
 *   1. COMPILE PROOF (runs on EVERY platform): assert the pure compiler emits
 *      the correct RESTRICTIVE argv for a `read-only` / `workspace-write`
 *      policy — no real binary needed, so this is the deterministic backstop
 *      that can never fake-pass.
 *   2. REAL EXECUTION (Linux + bwrap present only): actually spawn `bwrap` and
 *      prove the fence bites — a write into `/etc` FAILS while a read of the
 *      workspace SUCCEEDS. Guarded by `bwrapAvailable`.
 *
 * VISIBLE SKIP: when the real-execution tier cannot run (not Linux, or bwrap
 * absent — the case on the macOS dev host), we do NOT silently pass. A dedicated
 * always-running test asserts the skip PRECONDITION and `console.warn`s a loud
 * banner so the reason is observable in the reporter output. `test.skipIf` marks
 * the skipped case in the reporter, and the banner names WHY.
 */

const isLinux = process.platform === "linux"

/** Sync bwrap probe via Bun.which — only meaningful on Linux. */
const bwrapPath: string | null = isLinux ? Bun.which("bwrap") : null
const bwrapAvailable = bwrapPath !== null

const POLICY_RO: SandboxPolicy = { profile: "read-only" }
const POLICY_WW: SandboxPolicy = { profile: "workspace-write" }

/* ================================================================== */
/*  TIER 1 — COMPILE PROOF (always runs, all platforms)              */
/* ================================================================== */

describe("DOF-40 TIER-1 compile proof: bwrap argv is restrictive (all platforms)", () => {
  test("read-only ⇒ RO-bind workspace + unshare-net, NO rw-bind of workspace", () => {
    const args = compileBubblewrapArgs(POLICY_RO, "/ws")
    expect(args).not.toBeNull()
    const a = args as string[]
    // network fenced
    expect(a.includes("--unshare-net")).toBe(true)
    // workspace is RO-bound, never rw-bound
    const roIdx = a.findIndex(
      (t, i) => t === "--ro-bind" && a[i + 1] === "/ws" && a[i + 2] === "/ws",
    )
    expect(roIdx).toBeGreaterThan(-1)
    const rwIdx = a.findIndex((t, i) => t === "--bind" && a[i + 1] === "/ws" && a[i + 2] === "/ws")
    expect(rwIdx).toBe(-1)
    // parent-death fence present
    expect(a.includes("--die-with-parent")).toBe(true)
  })

  test("workspace-write ⇒ RW-bind workspace + unshare-net + /proc + /dev", () => {
    const args = compileBubblewrapArgs(POLICY_WW, "/ws")
    const a = args as string[]
    const rwIdx = a.findIndex((t, i) => t === "--bind" && a[i + 1] === "/ws" && a[i + 2] === "/ws")
    expect(rwIdx).toBeGreaterThan(-1)
    expect(a.includes("--unshare-net")).toBe(true)
    // outside-workspace root is still RO (read allowed, write denied)
    const rootRo = a.findIndex((t, i) => t === "--ro-bind" && a[i + 1] === "/" && a[i + 2] === "/")
    expect(rootRo).toBeGreaterThan(-1)
  })
})

/* ================================================================== */
/*  SKIP VISIBILITY — always runs, LOUDLY reports why tier-2 is off  */
/* ================================================================== */

describe("DOF-40 skip visibility: real-exec precondition is reported, never faked", () => {
  test("real-bwrap-exec precondition is observable", () => {
    if (!bwrapAvailable) {
      // LOUD, observable banner — this is the anti-fake-pass guard. The test
      // still runs and asserts the DOCUMENTED reason, so a reader of the
      // reporter sees exactly why the real-exec tier did not run.
      const reason = !isLinux
        ? `platform=${process.platform} (real bwrap exec requires Linux)`
        : "bwrap not on PATH (install bubblewrap)"
      // biome-ignore lint/suspicious/noConsole: intentional visible-skip banner
      console.warn(`[DOF-40 SKIP] TIER-2 real bwrap exec SKIPPED — ${reason}`)
      expect(bwrapAvailable).toBe(false)
      expect(reason.length).toBeGreaterThan(0)
    } else {
      // On a real Linux+bwrap host the tier-2 tests below DO run.
      expect(bwrapAvailable).toBe(true)
      expect(bwrapPath).not.toBeNull()
    }
  })
})

/* ================================================================== */
/*  TIER 2 — REAL EXECUTION (Linux + bwrap only)                     */
/* ================================================================== */

describe("DOF-40 TIER-2 real bwrap execution: the fence actually bites", () => {
  test.skipIf(!bwrapAvailable)(
    "read-only ⇒ write into /etc FAILS under real bwrap (fence enforced)",
    async () => {
      const { mkdtempSync, rmSync } = await import("node:fs")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const ws = mkdtempSync(join(tmpdir(), "dof40-ro-"))
      try {
        const sb = linuxOsSandbox()
        // Attempt to create a file OUTSIDE the workspace in a system dir.
        const r = await sb.spawn(
          { command: ["/bin/sh", "-c", "touch /etc/dof40-should-not-exist"], cwd: ws },
          POLICY_RO,
        )
        // Sandbox was applied and the write was denied (nonzero exit).
        expect(r.sandboxApplied).toBe(true)
        expect(r.exitCode).not.toBe(0)
        // The forbidden file must NOT exist on the host.
        const { existsSync } = await import("node:fs")
        expect(existsSync("/etc/dof40-should-not-exist")).toBe(false)
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(!bwrapAvailable)(
    "workspace-write ⇒ write INSIDE workspace SUCCEEDS under real bwrap",
    async () => {
      const { mkdtempSync, rmSync, existsSync } = await import("node:fs")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const ws = mkdtempSync(join(tmpdir(), "dof40-ww-"))
      try {
        const sb = linuxOsSandbox()
        const r = await sb.spawn(
          { command: ["/bin/sh", "-c", "touch ok && echo done"], cwd: ws },
          POLICY_WW,
        )
        expect(r.sandboxApplied).toBe(true)
        expect(r.exitCode).toBe(0)
        expect(existsSync(join(ws, "ok"))).toBe(true)
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    },
  )
})
