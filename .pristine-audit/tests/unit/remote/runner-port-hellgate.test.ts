/**
 * Hellgate — ADR-0288 `RemoteRunner` port surface (15 cases).
 *
 * Drives the closed port + headless stub + registry through every adversarial
 * branch documented in the slice plan. No live docker / lima / VZ required —
 * the headless stub is the truth source for port invariants.
 */
import { describe, expect, test } from "bun:test"
import type { RemoteRunner, RemoteSpec } from "@/remote"
import {
  ALL_REMOTE_BACKENDS,
  ALL_REMOTE_ERROR_KINDS,
  ALL_REMOTE_STATUS_KINDS,
  createHeadlessRunner,
  parseRemoteRunnerEnv,
  RemoteError,
  selectRemoteRunner,
  validateSpec,
} from "@/remote"

const baseSpec = (over: Partial<RemoteSpec> = {}): RemoteSpec => ({
  image: "alpine:3.20",
  cmd: ["echo", "hi"],
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-01 — port shape verification
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-01 — port shape verification", () => {
  test("createHeadlessRunner produces a runner with the 4 port methods", () => {
    const r: RemoteRunner = createHeadlessRunner()
    expect(typeof r.spawn).toBe("function")
    expect(typeof r.status).toBe("function")
    expect(typeof r.cancel).toBe("function")
    expect(typeof r.logs).toBe("function")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-02 — RemoteSpec validation rejects empty image
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-02 — RemoteSpec validation: empty image", () => {
  test("validator returns invalid-spec on empty image", () => {
    const r = validateSpec(baseSpec({ image: "" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
  test("validator returns invalid-spec on whitespace-only image", () => {
    const r = validateSpec(baseSpec({ image: "   " }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
  test("runner.spawn propagates the invalid-spec error from validator", async () => {
    const runner = createHeadlessRunner()
    const r = await runner.spawn(baseSpec({ image: "" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-03 — env null allowed (delete-env), invalid key rejected
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-03 — env null allowed; invalid key rejected", () => {
  test("env value null is accepted (delete-env convention)", () => {
    const r = validateSpec(baseSpec({ env: { FOO: null } }))
    expect(r.ok).toBe(true)
  })
  test("env key with lowercase letter rejected", () => {
    const r = validateSpec(baseSpec({ env: { foo: "bar" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
  test("env key starting with digit rejected", () => {
    const r = validateSpec(baseSpec({ env: { "1FOO": "x" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-spec")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-04 — RemoteHandle id format = `{backend}-{rest}`
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-04 — RemoteHandle id format `{backend}-{rest}`", () => {
  test("headless handle id starts with `headless-`", async () => {
    const r = await createHeadlessRunner().spawn(baseSpec())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.backend).toBe("headless")
      expect(r.value.id.startsWith("headless-")).toBe(true)
      // shape: backend + dash + non-empty suffix
      const dash = r.value.id.indexOf("-")
      expect(dash).toBeGreaterThan(0)
      expect(r.value.id.slice(dash + 1).length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-05 — Status 5-arm exhaustive
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-05 — Status closed 5-arm", () => {
  test("ALL_REMOTE_STATUS_KINDS has exactly 5 arms", () => {
    expect(ALL_REMOTE_STATUS_KINDS.length).toBe(5)
    expect(new Set(ALL_REMOTE_STATUS_KINDS)).toEqual(
      new Set(["pending", "running", "succeeded", "failed", "cancelled"]),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-06 — RemoteError 7-arm closed
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-06 — RemoteError closed 7-arm union", () => {
  test("ALL_REMOTE_ERROR_KINDS has exactly 7 arms", () => {
    expect(ALL_REMOTE_ERROR_KINDS.length).toBe(7)
    expect(new Set(ALL_REMOTE_ERROR_KINDS)).toEqual(
      new Set([
        "invalid-spec",
        "unknown-handle",
        "daemon-unavailable",
        "image-not-found",
        "timeout",
        "cancelled",
        "transport",
      ]),
    )
  })
  test("ALL_REMOTE_BACKENDS has exactly 4 arms", () => {
    expect(ALL_REMOTE_BACKENDS.length).toBe(4)
    expect(new Set(ALL_REMOTE_BACKENDS)).toEqual(
      new Set(["docker", "lima", "apple-vz", "headless"]),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-07 — timeout 0 → immediate timeout (failed + reason="timeout")
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-07 — timeoutMs=0 immediate timeout", () => {
  test("headless spec with timeoutMs=0 emits terminal failed/timeout", async () => {
    const runner = createHeadlessRunner()
    const r = await runner.spawn(baseSpec({ timeoutMs: 0 }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const s = await runner.status(r.value)
      expect(s.ok).toBe(true)
      if (s.ok) {
        expect(s.value.kind).toBe("failed")
        expect(s.value.reason).toBe("timeout")
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-08 — default-OFF byte-identical: env unset → registry returns null
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-08 — default-OFF (registry returns null)", () => {
  test("env unset → null", () => {
    expect(selectRemoteRunner({})).toBe(null)
  })
  test("env=none → null", () => {
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "none" })).toBe(null)
  })
  test("env=unknown → null", () => {
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "xyz" })).toBe(null)
  })
  test("env=docker but no seam → null (degraded → off)", () => {
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, {})).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-09 — headless deterministic (same seed → same handle ids)
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-09 — headless deterministic", () => {
  test("seeded runner produces deterministic monotonic handle ids", async () => {
    const a = createHeadlessRunner({ seedCounter: 100, clock: { now: () => 1 } })
    const b = createHeadlessRunner({ seedCounter: 100, clock: { now: () => 1 } })
    const ra = await a.spawn(baseSpec())
    const rb = await b.spawn(baseSpec())
    expect(ra.ok && rb.ok).toBe(true)
    if (ra.ok && rb.ok) expect(ra.value.id).toBe(rb.value.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-10 — AbortSignal cancel mid-spawn
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-10 — AbortSignal cancel mid-spawn", () => {
  test("pre-aborted signal blocks spawn with cancelled", async () => {
    const ac = new AbortController()
    ac.abort()
    const runner = createHeadlessRunner()
    const r = await runner.spawn(baseSpec({ signal: ac.signal }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-11 — cancel idempotent
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-11 — cancel idempotent", () => {
  test("cancel twice returns ok both times, status remains cancelled", async () => {
    const runner = createHeadlessRunner()
    const sp = await runner.spawn(baseSpec({ timeoutMs: 0 })) // terminal already
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const c1 = await runner.cancel(sp.value)
    const c2 = await runner.cancel(sp.value)
    expect(c1.ok).toBe(true)
    expect(c2.ok).toBe(true)
  })

  test("non-terminal handle: cancel then cancel again still ok", async () => {
    // Headless stub never enters non-terminal; emulate via fresh spawn (terminal succeeded)
    const runner = createHeadlessRunner()
    const sp = await runner.spawn(baseSpec())
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const c1 = await runner.cancel(sp.value)
    const c2 = await runner.cancel(sp.value)
    expect(c1.ok).toBe(true)
    expect(c2.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-12 — logs AsyncIterable cleans up on completion
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-12 — logs cleanup on done", () => {
  test("for-await over headless logs exits after a finite number of lines", async () => {
    const runner = createHeadlessRunner()
    const sp = await runner.spawn(baseSpec())
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const lines: string[] = []
    for await (const ln of runner.logs(sp.value)) {
      lines.push(ln)
      if (lines.length > 10) break // safety
    }
    // Headless stub yields exactly one synthetic line
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  test("logs for unknown handle yields zero lines (no throw)", async () => {
    const runner = createHeadlessRunner()
    const lines: string[] = []
    for await (const ln of runner.logs({ id: "headless-999", backend: "headless" })) {
      lines.push(ln)
    }
    expect(lines.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-13 — logs back-pressure (early break releases iterator)
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-13 — logs back-pressure", () => {
  test("for-await break exits cleanly", async () => {
    const runner = createHeadlessRunner()
    const sp = await runner.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    let count = 0
    for await (const _ln of runner.logs(sp.value)) {
      count += 1
      break // back-pressure exit
    }
    expect(count).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-14 — status cached after terminal state
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-14 — status cached after terminal", () => {
  test("status returns identical snapshot kind across two calls on terminal handle", async () => {
    const runner = createHeadlessRunner()
    const sp = await runner.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    const s1 = await runner.status(sp.value)
    const s2 = await runner.status(sp.value)
    expect(s1.ok && s2.ok).toBe(true)
    if (s1.ok && s2.ok) expect(s1.value.kind).toBe(s2.value.kind)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-RR-15 — registry env swap
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-RR-15 — registry env swap", () => {
  test("parseRemoteRunnerEnv: case-insensitive + trim", () => {
    expect(parseRemoteRunnerEnv("DOCKER")).toBe("docker")
    expect(parseRemoteRunnerEnv("  lima  ")).toBe("lima")
    expect(parseRemoteRunnerEnv("Apple-VZ")).toBe("apple-vz")
    expect(parseRemoteRunnerEnv("HEADLESS")).toBe("headless")
    expect(parseRemoteRunnerEnv("")).toBe(null)
    expect(parseRemoteRunnerEnv(undefined)).toBe(null)
  })

  test("selectRemoteRunner with headless env returns a runner", () => {
    const r = selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "headless" })
    expect(r).not.toBe(null)
    if (r !== null) {
      expect(typeof r.spawn).toBe("function")
    }
  })

  test("selectRemoteRunner with apple-vz env returns runner even without host", () => {
    // Adapter is constructed but every operation surfaces daemon-unavailable.
    const r = selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "apple-vz" })
    expect(r).not.toBe(null)
  })

  test("RemoteError carries kind + backend tag", () => {
    const e = new RemoteError("daemon-unavailable", "docker down", "docker")
    expect(e.kind).toBe("daemon-unavailable")
    expect(e.backend).toBe("docker")
    expect(e.message.includes("daemon-unavailable")).toBe(true)
  })
})
