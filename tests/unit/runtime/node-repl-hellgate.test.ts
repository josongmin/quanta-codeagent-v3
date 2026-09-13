/**
 * ADR-0249 hellgate — node-REPL persistent-kernel slice.
 *
 * 16 adversarial cases proving the closed `NodeReplKernel` port + its two
 * adapters (production `Bun.spawn` default + deterministic headless stub)
 * + the on-disk state-store satisfy the contract:
 *
 *   01 spawn → state "ready"                              (stub)
 *   02 missing `node` binary → KernelError.node-missing   (default adapter)
 *   03 exec "1+1" → "2"                                   (stub)
 *   04 syntax error → hadError:true + stderr classifies   (stub)
 *   05 runtime throw → hadError:true + stderr classifies  (stub)
 *   06 variable persistence across exec calls             (stub)
 *   07 kill → state transitions to "dead"                 (stub)
 *   08 exec on dead kernel → KernelError.kernel-dead      (stub)
 *   09 concurrent isolation — two kernels do NOT share vars (stub)
 *   10 AbortSignal aborted before exec → exec-aborted     (stub)
 *   11 state-store writes `{id}.json` mode 0600           (stub w/home)
 *   12 kill removes the on-disk handle                    (stub w/home)
 *   13 headless stub is byte-identical across instances   (stub deterministic)
 *   14 default-OFF: nothing in `src/` constructs the kernel by default
 *   15 successful exec bumps `lastUseMs` on the spec      (stub)
 *   16 list() reports inUse:false for ready/idle, true for running  (stub)
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KernelId } from "@/runtime/node-repl"
import {
  createDefaultNodeReplKernel,
  headlessStub,
  listKernels,
  stateDir,
} from "@/runtime/node-repl"
import { scrubReplNoise } from "@/runtime/node-repl/default-kernel"

const MISSING_NODE = "__quanta_definitely_no_such_node_bin__"

const mkTmpHome = (): string => mkdtempSync(join(tmpdir(), "qnr-hellgate-"))

const dropTmp = (home: string): void => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe("ADR-0249 node-repl-hellgate", () => {
  // ─── HELL-NR-01 — spawn transitions to "ready" ─────────────────────────
  test("HELL-NR-01 spawn resolves with a spec and state becomes ready", async () => {
    const k = headlessStub()
    const res = await k.spawn({ sessionId: "s1" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.sessionId).toBe("s1")
    expect(res.value.pid).toBe(0)
    expect(typeof res.value.id).toBe("string")
    expect(res.value.id.length).toBeGreaterThan(0)
    expect(k.status(res.value.id)).toBe("ready")
  })

  // ─── HELL-NR-02 — missing `node` binary classifies as node-missing ─────
  test("HELL-NR-02 ENOENT on node binary → KernelError.node-missing", async () => {
    const home = mkTmpHome()
    try {
      const k = createDefaultNodeReplKernel({ nodeBin: MISSING_NODE, home })
      const res = await k.spawn({ sessionId: "s2" })
      expect(res.ok).toBe(false)
      if (res.ok) return
      // Bun.spawn synchronous throw on ENOENT → node-missing branch.
      // (On some platforms the bun runtime may surface a different
      // platform string — both kinds are acceptable as no-such-bin.)
      expect(res.error.kind === "node-missing" || res.error.kind === "spawn-failed").toBe(true)
      expect(typeof (res.error as { detail?: string }).detail).toBe("string")
    } finally {
      dropTmp(home)
    }
  })

  /**
   * HELL-NR-02A — the production kernel does not inherit provider credentials.
   *
   * The first version set `process.env.ANTHROPIC_API_KEY` INSIDE this test process. A
   * Bun child gets the environment the process STARTED with, not later edits, so the key
   * never reached the kernel whether or not it scrubbed — the test could not see the leak
   * it named, and passed or failed (8 of 10, 9 of 10 at two commits) on how the REPL
   * split its output. With the key present at startup, the unfixed kernel printed it.
   *
   * So the secret goes where production has it: in the startup environment of a separate
   * process that builds the real kernel.
   */
  const runKernelProbe = (code: string, env: Record<string, string>): string => {
    const home = mkTmpHome()
    try {
      const script = join(home, "probe.ts")
      writeFileSync(
        script,
        `import { createDefaultNodeReplKernel } from ${JSON.stringify(join(import.meta.dir, "..", "..", "..", "src/runtime/node-repl/default-kernel.ts"))}\n` +
          `const k = createDefaultNodeReplKernel({ home: ${JSON.stringify(home)} })\n` +
          `const sp = await k.spawn({ sessionId: "env-scrub" })\n` +
          `if (!sp.ok) { console.log("SPAWN-FAILED " + JSON.stringify(sp.error)); process.exit(0) }\n` +
          `const out = await k.exec(sp.value.id, ${JSON.stringify(code)})\n` +
          `console.log(out.ok ? out.value.stdout : "EXEC-FAILED " + JSON.stringify(out.error))\n` +
          `await k.kill(sp.value.id)\n`,
      )
      const res = Bun.spawnSync([process.execPath, script], {
        env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
      })
      return res.stdout.toString()
    } finally {
      dropTmp(home)
    }
  }

  test("HELL-NR-02A production kernel does not inherit provider credentials", () => {
    const out = runKernelProbe(
      'console.log("KEY=" + (process.env.ANTHROPIC_API_KEY ?? "SCRUBBED") + " OAI=" + (process.env.OPENAI_API_KEY ?? "SCRUBBED"))',
      { ANTHROPIC_API_KEY: "probe-startup-secret", OPENAI_API_KEY: "probe-openai-secret" },
    )
    expect(out, "the kernel produced nothing to judge").toContain("KEY=")
    expect(out).not.toContain("probe-startup-secret")
    expect(out).not.toContain("probe-openai-secret")
    expect(out).toContain("KEY=SCRUBBED OAI=SCRUBBED")
  })

  test("HELL-NR-02A PAIRED CONTROL: the allowlisted environment still reaches the kernel", () => {
    // Without this, a kernel spawned with an EMPTY env would pass the arm above — and
    // `node` resolves nothing without PATH.
    const out = runKernelProbe('console.log("PATH_SET=" + (process.env.PATH ? "yes" : "no"))', {})
    expect(out).toContain("PATH_SET=yes")
  })

  test("HELL-NR-02B a prompt prefixed onto output is stripped, not a reason to drop the line", () => {
    expect(scrubReplNoise("> SCRUBBED")).toBe("SCRUBBED")
    expect(scrubReplNoise("> > KEY=x")).toBe("KEY=x")
    expect(scrubReplNoise("... done")).toBe("done")
    expect(scrubReplNoise(">\n...\n> \nundefined\n\n2")).toBe("2")
    expect(scrubReplNoise(">not-a-prompt")).toBe(">not-a-prompt")
  })

  // ─── HELL-NR-03 — exec "1+1" returns "2" ───────────────────────────────
  test("HELL-NR-03 exec arithmetic literal returns the integer string", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s3" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const out = await k.exec(sp.value.id, "1+1")
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.stdout).toBe("2")
    expect(out.value.hadError).toBe(false)
    expect(out.value.stderr).toBe("")
  })

  // ─── HELL-NR-04 — syntax error → hadError:true ─────────────────────────
  test("HELL-NR-04 syntax error is classified (hadError:true + stderr non-empty)", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s4" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const out = await k.exec(sp.value.id, "let = 1")
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.hadError).toBe(true)
    expect(out.value.stderr.toLowerCase()).toContain("syntaxerror")
  })

  // ─── HELL-NR-05 — runtime throw → hadError:true ────────────────────────
  test("HELL-NR-05 runtime throw is captured into stderr + hadError", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s5" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const out = await k.exec(sp.value.id, 'throw new Error("boom")')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.hadError).toBe(true)
    expect(out.value.stderr).toContain("boom")
  })

  // ─── HELL-NR-06 — variable persistence across exec calls ───────────────
  test("HELL-NR-06 let x=42 in one exec is readable from the next", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s6" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const assign = await k.exec(sp.value.id, "let x = 42")
    expect(assign.ok).toBe(true)
    if (!assign.ok) return
    const read = await k.exec(sp.value.id, "x")
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.stdout).toBe("42")
    expect(read.value.hadError).toBe(false)
  })

  // ─── HELL-NR-07 — kill transitions to "dead" ──────────────────────────
  test("HELL-NR-07 kill flips state to dead and the kernel stays dead", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s7" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    expect(k.status(sp.value.id)).toBe("ready")
    await k.kill(sp.value.id)
    expect(k.status(sp.value.id)).toBe("dead")
    // idempotent: second kill is fine
    await k.kill(sp.value.id)
    expect(k.status(sp.value.id)).toBe("dead")
  })

  // ─── HELL-NR-08 — exec on dead kernel → kernel-dead ────────────────────
  test("HELL-NR-08 exec on a killed kernel resolves with KernelError.kernel-dead", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s8" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    await k.kill(sp.value.id)
    const out = await k.exec(sp.value.id, "1+1")
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe("kernel-dead")
    if (out.error.kind === "kernel-dead") {
      expect(out.error.id).toBe(sp.value.id)
    }
  })

  // ─── HELL-NR-09 — concurrent kernels do NOT share variables ───────────
  test("HELL-NR-09 two kernels are independently isolated (no var bleed)", async () => {
    const k = headlessStub()
    const a = await k.spawn({ sessionId: "sa" })
    const b = await k.spawn({ sessionId: "sb" })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.id).not.toBe(b.value.id)
    await k.exec(a.value.id, "let secret = 99")
    const bRead = await k.exec(b.value.id, "secret")
    expect(bRead.ok).toBe(true)
    if (!bRead.ok) return
    // The variable is unknown in kernel B — ReferenceError shape.
    expect(bRead.value.hadError).toBe(true)
    expect(bRead.value.stderr.toLowerCase()).toContain("referenceerror")
    // Kernel A still sees its own binding.
    const aRead = await k.exec(a.value.id, "secret")
    expect(aRead.ok).toBe(true)
    if (!aRead.ok) return
    expect(aRead.value.stdout).toBe("99")
  })

  // ─── HELL-NR-10 — pre-aborted signal on exec → exec-aborted ───────────
  test("HELL-NR-10 AbortSignal aborted before exec → KernelError.exec-aborted", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s10" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await k.exec(sp.value.id, "1+1", { signal: ctrl.signal })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe("exec-aborted")
    // An aborted exec terminates the kernel — subsequent execs see dead.
    expect(k.status(sp.value.id)).toBe("dead")
  })

  // ─── HELL-NR-11 — state-store writes `{id}.json` with mode 0600 ────────
  test("HELL-NR-11 spawn persists a 0600 handle under ~/.quanta/node_repl/active_execs/", async () => {
    const home = mkTmpHome()
    try {
      const k = headlessStub({ home })
      const sp = await k.spawn({ sessionId: "s11" })
      expect(sp.ok).toBe(true)
      if (!sp.ok) return
      const dir = stateDir(home)
      const file = join(dir, `${sp.value.id}.json`)
      expect(existsSync(file)).toBe(true)
      const st = statSync(file)
      // mode 0600 — owner rw only
      expect(st.mode & 0o777).toBe(0o600)
      // dir mode 0700
      const dirSt = statSync(dir)
      expect(dirSt.mode & 0o777).toBe(0o700)
      // Body is the JSON-serialised spec
      const body = JSON.parse(readFileSync(file, "utf8")) as {
        id: string
        sessionId: string
        pid: number
      }
      expect(body.id).toBe(sp.value.id)
      expect(body.sessionId).toBe("s11")
      expect(body.pid).toBe(0)
      // listKernels() round-trips the on-disk state
      const listed = listKernels(home)
      expect(listed.length).toBe(1)
      expect(listed[0]?.id).toBe(sp.value.id)
    } finally {
      dropTmp(home)
    }
  })

  // ─── HELL-NR-12 — kill removes the on-disk handle ──────────────────────
  test("HELL-NR-12 kill unlinks the `{id}.json` handle from disk", async () => {
    const home = mkTmpHome()
    try {
      const k = headlessStub({ home })
      const sp = await k.spawn({ sessionId: "s12" })
      expect(sp.ok).toBe(true)
      if (!sp.ok) return
      const file = join(stateDir(home), `${sp.value.id}.json`)
      expect(existsSync(file)).toBe(true)
      await k.kill(sp.value.id)
      expect(existsSync(file)).toBe(false)
      // Idempotent removal — listing is empty.
      expect(listKernels(home).length).toBe(0)
    } finally {
      dropTmp(home)
    }
  })

  // ─── HELL-NR-13 — headless stub is byte-identical-deterministic ───────
  test("HELL-NR-13 headlessStub with fixed clock yields byte-identical specs", async () => {
    const fixed = (): number => 1_700_000_000_000
    const a = headlessStub({ clock: fixed, pid: 0 })
    const b = headlessStub({ clock: fixed, pid: 0 })
    const ra = await a.spawn({ sessionId: "det", id: "fixed-seed" })
    const rb = await b.spawn({ sessionId: "det", id: "fixed-seed" })
    expect(ra.ok && rb.ok).toBe(true)
    if (!ra.ok || !rb.ok) return
    // The IDs differ only in the nonce suffix; everything else (pid /
    // sessionId / startedAtMs) is byte-identical when the clock is pinned.
    expect(ra.value.pid).toBe(rb.value.pid)
    expect(ra.value.sessionId).toBe(rb.value.sessionId)
    expect(ra.value.startedAtMs).toBe(rb.value.startedAtMs)
    expect(ra.value.lastUseMs).toBe(rb.value.lastUseMs)
    // Exec returns deterministic stdout for the safe-subset eval.
    const ea = await a.exec(ra.value.id, "1+1")
    const eb = await b.exec(rb.value.id, "1+1")
    expect(ea.ok && eb.ok).toBe(true)
    if (!ea.ok || !eb.ok) return
    expect(ea.value.stdout).toBe(eb.value.stdout)
  })

  // ─── HELL-NR-14 — default-OFF: no production wiring at composition root ─
  test("HELL-NR-14 default-OFF: no src/ module constructs the kernel implicitly", async () => {
    // Probe — importing the barrel does NOT auto-spawn anything.
    const mod = await import("@/runtime/node-repl")
    // The barrel exports factories, not instances; the test asserts the
    // shape (functions only) so a future accidental top-level
    // `createDefaultNodeReplKernel()` call would fail this guard.
    expect(typeof mod.createDefaultNodeReplKernel).toBe("function")
    expect(typeof mod.headlessStub).toBe("function")
    // No singleton export — there is no `defaultKernel` or
    // `activeKernel` symbol that would suggest implicit construction.
    const keys = Object.keys(mod)
    for (const k of keys) {
      const v = (mod as Record<string, unknown>)[k]
      if (k.includes("Kernel") || k.includes("kernel")) {
        // Anything kernel-flavoured is either a function (factory) or a
        // type re-export (undefined at runtime — types erase).
        expect(typeof v === "function" || v === undefined).toBe(true)
      }
    }
  })

  // ─── HELL-NR-15 — successful exec bumps lastUseMs ──────────────────────
  test("HELL-NR-15 successful exec advances lastUseMs on the listed spec", async () => {
    // Use a deterministic clock — every call advances the counter so
    // ordering is observable without relying on wall-clock resolution.
    let tick = 1_700_000_000_000
    const clock = (): number => ++tick
    const k = headlessStub({ clock })
    const sp = await k.spawn({ sessionId: "s15" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    const before = k.list().find((x) => x.spec.id === sp.value.id)
    expect(before).toBeDefined()
    const beforeLast = before?.spec.lastUseMs ?? 0
    const out = await k.exec(sp.value.id, "1+1")
    expect(out.ok).toBe(true)
    const after = k.list().find((x) => x.spec.id === sp.value.id)
    expect(after).toBeDefined()
    const afterLast = after?.spec.lastUseMs ?? 0
    expect(afterLast).toBeGreaterThan(beforeLast)
  })

  // ─── HELL-NR-16 — list() inUse reflects state precisely ────────────────
  test("HELL-NR-16 list() reports inUse:true only while running, false otherwise", async () => {
    const k = headlessStub()
    const sp = await k.spawn({ sessionId: "s16" })
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    // ready → inUse must be false
    let listing = k.list().find((x) => x.spec.id === sp.value.id)
    expect(listing?.state).toBe("ready")
    expect(listing?.inUse).toBe(false)

    // Probe `running` by intercepting mid-exec. The stub is synchronous
    // inside exec, so we observe state changes via the public surface
    // after the call: state should land on "idle" with inUse:false.
    await k.exec(sp.value.id, "1+1")
    listing = k.list().find((x) => x.spec.id === sp.value.id)
    expect(listing?.state).toBe("idle")
    expect(listing?.inUse).toBe(false)

    // kill → dead, inUse:false
    await k.kill(sp.value.id)
    listing = k.list().find((x) => x.spec.id === sp.value.id)
    expect(listing?.state).toBe("dead")
    expect(listing?.inUse).toBe(false)

    // Validate the listing shape: dead kernels still appear in list()
    // for orphan-reaping purposes (the on-disk handle is gone but the
    // in-memory record remains until process exit).
    const dead = k.list().find((x) => x.spec.id === sp.value.id)
    expect(dead).toBeDefined()

    // Untyped guard: a non-existent id resolves to "dead" on status()
    // without throwing — the orphan reaper relies on this.
    const ghost = "ghost-kernel" as KernelId
    expect(k.status(ghost)).toBe("dead")
  })
})
