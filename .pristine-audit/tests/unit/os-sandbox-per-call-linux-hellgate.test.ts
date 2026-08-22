import { describe, expect, test } from "bun:test"
import { defaultPerCallSandbox } from "@/runtime/os-sandbox"

/**
 * Hellgate battery for the per-call OS sandbox Linux backend wiring
 * (ADR-0295 follow-up — frontier tool-impl audit fix).
 *
 * BUG (RED-on-injection target): `defaultPerCallSandbox` previously returned
 * `{supported:false, reason:"linux-not-implemented-per-call"}` on Linux
 * UNCONDITIONALLY — even when `bwrap` / `landlock-cli` are installed, the
 * mode="read" bash path fail-closed with `sandbox_unavailable` and the Linux
 * sandbox was inert. The fix detects the backend synchronously (via the
 * injected `whichSync`) at construction and surfaces `supported:true` +
 * a real wrapped argv when a backend is present.
 *
 * All cases inject a fake `platform` + `whichSync` so the suite is hermetic
 * and runs from darwin.
 */

const whichBwrapOnly = (b: string): string | null => (b === "bwrap" ? "/usr/bin/bwrap" : null)
const whichLandlockCliOnly = (b: string): string | null =>
  b === "landlock-cli" ? "/usr/local/bin/landlock-cli" : null
const whichBoth = (b: string): string | null => {
  if (b === "bwrap") return "/usr/bin/bwrap"
  if (b === "landlock-cli") return "/usr/local/bin/landlock-cli"
  return null
}
const whichNone = (_b: string): string | null => null

describe("per-call sandbox — Linux backend wiring", () => {
  test("HELL-PCLX-1: linux + bwrap installed → supported:true (was linux-not-implemented-per-call)", () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichBwrapOnly,
    })
    expect(port.availability()).toEqual({ supported: true })
  })

  test("HELL-PCLX-2: linux + bwrap installed → wrap() prefixes `bwrap ... --`", async () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichBwrapOnly,
    })
    const w = await port.wrap(["bash", "-lc", "echo hi"], "/ws")
    expect(w.sandboxApplied).toBe(true)
    expect(w.argv[0]).toBe("bwrap")
    const sepIdx = w.argv.indexOf("--")
    expect(sepIdx).toBeGreaterThan(0)
    expect(w.argv.slice(sepIdx + 1)).toEqual(["bash", "-lc", "echo hi"])
  })

  test("HELL-PCLX-3: linux + only landlock-cli → supported:true, wrap prefixes landlock-cli", async () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichLandlockCliOnly,
    })
    expect(port.availability()).toEqual({ supported: true })
    const w = await port.wrap(["bash", "-lc", ":"], "/ws")
    expect(w.sandboxApplied).toBe(true)
    expect(w.argv[0]).toBe("landlock-cli")
    // the network-deferred sentinel must be filtered before spawn (never a real flag)
    expect(w.argv.includes("--network-deferred")).toBe(false)
  })

  test("HELL-PCLX-4: linux + both backends → bubblewrap wins (stronger fence)", async () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichBoth,
    })
    const w = await port.wrap(["x"], "/ws")
    expect(w.argv[0]).toBe("bwrap")
  })

  test("HELL-PCLX-5: linux + NO backend → supported:false fail-closed (linux-bwrap-missing)", () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichNone,
    })
    const avail = port.availability()
    expect(avail.supported).toBe(false)
    if (!avail.supported) {
      expect(avail.reason.startsWith("linux-bwrap-missing")).toBe(true)
    }
  })

  test("HELL-PCLX-6: linux landlock-cli read-only → network-deny surfaces honest degradeReason", async () => {
    const port = defaultPerCallSandbox("read-only", {
      platform: "linux",
      whichSync: whichLandlockCliOnly,
    })
    const w = await port.wrap(["echo", "hi"], "/ws")
    // read-only implies network deny; landlock-cli cannot enforce it → honest degrade.
    expect(w.sandboxApplied).toBe(true)
    expect(w.degradeReason).toBe("landlock-network-policy-not-enforced")
  })

  // Non-regression: the fix only ADDS the linux branch. darwin / win32 paths
  // must be byte-identical to the pre-fix behaviour (no `whichSync` consulted).
  test("HELL-PCLX-7: non-linux availability unchanged (darwin/win32 byte-identical)", () => {
    const darwinOk = defaultPerCallSandbox("read-only", {
      platform: "darwin",
      sandboxExecPath: "/usr/bin/sandbox-exec",
      whichSync: whichBwrapOnly,
    })
    expect(darwinOk.availability()).toEqual({ supported: true })

    const darwinMissing = defaultPerCallSandbox("read-only", {
      platform: "darwin",
      sandboxExecPath: null,
      whichSync: whichBwrapOnly,
    })
    expect(darwinMissing.availability()).toEqual({
      supported: false,
      reason: "sandbox-exec-missing",
    })

    const win = defaultPerCallSandbox("read-only", {
      platform: "win32",
      whichSync: whichBwrapOnly,
    })
    expect(win.availability()).toEqual({
      supported: false,
      reason: "unsupported-platform:win32",
    })
  })
})
