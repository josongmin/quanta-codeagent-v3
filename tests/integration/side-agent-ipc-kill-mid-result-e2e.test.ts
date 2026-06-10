/**
 * H11 HELLGATE e2e (REAL OS layer) — a side-agent CHILD is SIGKILLed mid-result
 * over the genuine fork+IPC boundary. The supervisor's read loop MUST handle a
 * child that dies while writing its `finding` result WITHOUT an uncaught
 * throw / hang / zombie read — degrading to a typed crash (respawn → eventual
 * `crashed-permanently`) and a SHAPE-CLEAN findings log.
 *
 * ── Why this is novel vs the siblings ─────────────────────────────────────────
 * `side-agent-process-os-fork-e2e.test.ts` exercises only HARD-exit respawn
 * (`process.exit(1)` BEFORE writing anything). It never covers a child that
 * begins emitting its result and is killed MID-WRITE, so the parent's IPC read
 * loop is forced to cope with an INCOMPLETE / MALFORMED result payload. This
 * file seals exactly that adversarial corner.
 *
 * ── The real wire fact (measured, not assumed) ────────────────────────────────
 * Node's `serialization:"advanced"` IPC channel is WHOLE-FRAME-OR-NOTHING: a
 * SIGKILL mid-`process.send` does NOT deliver a byte-truncated frame to the
 * parent's `'message'` handler — the parent gets the prior complete frames, then
 * `'exit'`(SIGKILL). So the truncation that matters is a SEMANTIC one: the child
 * sends a COMPLETE frame whose `finding` PAYLOAD is half-built (summary absent,
 * or a non-string slot left from a partially-serialized object) and is then
 * SIGKILLed before it could finish/repair it. The parent must not throw on that
 * junk, and must not leak ill-typed data into its `summary: string` log.
 *
 * ── RED-ON-INJECTION (the teeth) ──────────────────────────────────────────────
 * The guard under test lives in `src/side-agent/process.ts handleChildMessage`:
 * it DROPS a `finding` whose `summary` is not a non-empty string. Delete that
 * guard and `assert: a partial finding never reaches the log` FAILS (the junk
 * `{summary: undefined}` / `{summary: <object>}` leaks through). The SIGKILL is
 * still observed as a crash via `onExit`.
 *
 * HERMETIC: real `nodeProcessForkPort` forks inline-script worker `.mjs` files
 * written to a temp dir; no API keys, no committed fixtures, no timing asserts —
 * the child writes its (partial) finding, FLUSHES, then SIGKILLs ITSELF, so the
 * parent races nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeProcessForkPort } from "../../src/host/runtime/side-agent-fork-port"
import {
  createProcessSideAgentDaemonRegistry,
  createSupervisedProcessDaemon,
  type SideAgentSpec,
} from "../../src/side-agent"

/** Real one-shot scheduler (node timers) — mirrors the OS-fork e2e. */
const realScheduler = {
  schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** Poll until `pred()` or timeout. */
const waitFor = async (pred: () => boolean, timeoutMs = 6000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

/**
 * Inline-script worker body. On `charter`, `process.send(BODY)` (a deliberately
 * half-built finding), then — once the IPC write is FLUSHED — SIGKILL itself, so
 * the parent receives the complete junk frame, then the crash. The `?? "{}"`
 * default lets the "no message at all, just die mid-flush" variant be expressed
 * by passing an empty body that sends nothing.
 *
 * `flushThenKill` uses the `process.send` write-callback so the SIGKILL happens
 * only AFTER the frame is committed to the channel (no parent-side race).
 */
const WORKER_TEMPLATE = (sendExpr: string): string => `
const send = (m, cb) => { if (typeof process.send === "function") process.send(m, cb); else cb && cb() }
const flushThenKill = (m) => {
  send(m, () => process.kill(process.pid, "SIGKILL"))
}
process.on("message", (msg) => {
  if (msg && msg.kind === "charter") {
    ${sendExpr}
  }
  if (msg && msg.kind === "shutdown") process.exit(0)
})
send({ kind: "ready" })
`

let DIR: string
/** Map of variant name → forkable module path. */
const workers: Record<string, string> = {}

const writeWorker = (name: string, sendExpr: string): string => {
  const path = join(DIR, `${name}.mjs`)
  writeFileSync(path, WORKER_TEMPLATE(sendExpr))
  workers[name] = path
  return path
}

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "quanta-sa-ipc-kill-"))
  // A finding frame missing `summary` entirely (killed before the field was set).
  writeWorker("missing-summary", `flushThenKill({ kind: "finding" })`)
  // A finding frame whose `summary` is a NON-STRING slot (a half-serialized
  // object left in place when the child died mid-build).
  writeWorker(
    "object-summary",
    `flushThenKill({ kind: "finding", summary: { partial: true } })`,
  )
  // A finding frame with an EMPTY-STRING summary (degenerate truncation to "").
  writeWorker("empty-summary", `flushThenKill({ kind: "finding", summary: "" })`)
  // SIGKILL with NO finding written at all (pure mid-result death — sends
  // nothing, just dies). Sanity that the bare kill path is a clean crash too.
  writeWorker("silent-kill", `process.kill(process.pid, "SIGKILL")`)
  // CONTROL: a WELL-FORMED finding then SIGKILL — proves the guard does NOT eat
  // valid findings (no over-correction) even when the child dies right after.
  writeWorker(
    "valid-then-kill",
    `flushThenKill({ kind: "finding", summary: "real finding", detail: "d" })`,
  )
})

afterAll(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true })
})

/** Run one supervised daemon over a fork of `module`, collecting findings +
 *  watching for an uncaught throw escaping into this process. */
const runSupervised = async (
  module: string,
  opts: { maxRestarts?: number } = {},
): Promise<{
  findings: { summary: string; detail?: string }[]
  status: () => string
  restarts: () => number
}> => {
  const findings: { summary: string; detail?: string }[] = []
  const d = createSupervisedProcessDaemon({
    task: "scan for the lockfile",
    maxTurnsPerWake: 1,
    fork: nodeProcessForkPort,
    forkSpec: { modulePath: module },
    now: () => Date.now(),
    scheduler: realScheduler,
    onFinding: (f) => void findings.push(f),
    baseBackoffMs: 15,
    backoffCapMs: 40,
    maxRestarts: opts.maxRestarts ?? 1,
  })
  d.start()
  // The child dies on its first charter ⇒ supervisor backs off + respawns up to
  // maxRestarts, then settles `crashed-permanently`.
  await waitFor(() => d.status() === "crashed-permanently")
  return { findings, status: () => d.status(), restarts: () => d.restarts() }
}

describe("H11 — side-agent child SIGKILLed mid-result: parent read loop stays graceful", () => {
  test("a child killed mid-write WITHOUT writing a finding ⇒ clean crash, no throw/hang", async () => {
    const r = await runSupervised(workers["silent-kill"] as string)
    // No finding (it never produced one), and the SIGKILL is a CRASH that the
    // supervisor handled to terminal — not an uncaught throw nor a hang (the
    // waitFor returned because status reached crashed-permanently).
    expect(r.findings).toHaveLength(0)
    expect(r.status()).toBe("crashed-permanently")
    expect(r.restarts()).toBe(1)
  })

  test("a finding frame MISSING summary (killed mid-build) ⇒ dropped, not forwarded as junk", async () => {
    const r = await runSupervised(workers["missing-summary"] as string)
    // RED-ON-INJECTION: with the guard removed, this leaks a `{summary: undefined}`
    // finding into the log. The guard drops it ⇒ zero findings.
    expect(r.findings).toHaveLength(0)
    expect(r.status()).toBe("crashed-permanently")
  })

  test("a finding frame with a NON-STRING (object) summary ⇒ dropped, log stays shape-clean", async () => {
    const r = await runSupervised(workers["object-summary"] as string)
    // The half-serialized object summary must NOT corrupt the `summary: string`
    // log. No finding survives; no uncaught throw.
    expect(r.findings).toHaveLength(0)
    // Defensive: even if a future regression let it through, it must never be a
    // non-string summary in the typed log.
    for (const f of r.findings) expect(typeof f.summary).toBe("string")
    expect(r.status()).toBe("crashed-permanently")
  })

  test("a finding frame with an EMPTY-STRING summary ⇒ dropped (degenerate truncation)", async () => {
    const r = await runSupervised(workers["empty-summary"] as string)
    expect(r.findings).toHaveLength(0)
    expect(r.status()).toBe("crashed-permanently")
  })

  test("CONTROL — a WELL-FORMED finding then SIGKILL ⇒ the valid finding IS kept (no over-correction)", async () => {
    const r = await runSupervised(workers["valid-then-kill"] as string)
    // The guard must let a genuine finding through even though the child died
    // right after writing it — exactly-once delivery of the real finding.
    expect(r.findings.length).toBeGreaterThanOrEqual(1)
    expect(r.findings[0]).toEqual({ summary: "real finding", detail: "d" })
    // And the death is still observed as a crash (not silently swallowed).
    expect(r.status()).toBe("crashed-permanently")
  })
})

describe("H11 — same corner through the PROCESS REGISTRY (host-facing surface)", () => {
  const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
    task: "audit dependencies",
    trigger: { kind: "interval", everyMs: 60_000 },
    maxWakes: 1,
    maxTurnsPerWake: 1,
    ...over,
  })

  test("registry forks a child that emits a half-built finding then SIGKILLs ⇒ findings() never carries junk", async () => {
    const reg = createProcessSideAgentDaemonRegistry({
      fork: nodeProcessForkPort,
      scheduler: realScheduler,
      now: () => Date.now(),
      workerModulePath: workers["object-summary"] as string,
      maxRestarts: 1,
      baseBackoffMs: 15,
      backoffCapMs: 40,
    })
    const id = reg.spawn(spec())
    // Settle: the child crashes on every wake ⇒ the daemon ends up `failed`.
    await waitFor(() => reg.list()[0]?.status === "failed")
    expect(reg.list()[0]?.status).toBe("failed")
    expect(reg.list()[0]?.id).toBe(id)
    // The host-facing findings log carries NO malformed finding — every retained
    // finding has a non-empty string summary (the type the snapshot/tools expect).
    for (const f of reg.findings()) {
      expect(typeof f.summary).toBe("string")
      expect(f.summary.length).toBeGreaterThan(0)
    }
    // For THIS adversarial child specifically, that means zero findings survived.
    expect(reg.findings()).toHaveLength(0)
  })

  test("a VALID finding still crosses the registry IPC boundary even if the child dies right after", async () => {
    const reg = createProcessSideAgentDaemonRegistry({
      fork: nodeProcessForkPort,
      scheduler: realScheduler,
      now: () => Date.now(),
      workerModulePath: workers["valid-then-kill"] as string,
      maxRestarts: 1,
      baseBackoffMs: 15,
      backoffCapMs: 40,
    })
    const id = reg.spawn(spec())
    const got = await waitFor(() => reg.findings().length > 0)
    expect(got).toBe(true)
    const f = reg.findings()[0]
    expect(f?.daemonId).toBe(id)
    expect(f?.summary).toBe("real finding")
  })
})
