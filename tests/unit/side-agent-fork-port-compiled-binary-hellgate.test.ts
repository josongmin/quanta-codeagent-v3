/**
 * HELLGATE — the side-agent process-fork port must not lie in a COMPILED binary.
 *
 * Same defect class as `tests/unit/permission/shell-parser-compiled-binary-hellgate.test.ts`
 * and the two sites already fixed before it: a module that resolves a runtime
 * path from its OWN install location resolves something real from source and
 * something absent inside `bun build --compile`.
 *
 * MEASURED on `src/host/runtime/side-agent-fork-port.ts` before this test:
 *
 *   FROM SOURCE:  workerPath=/…/src/side-agent/worker-entry.mjs   exists=true
 *   COMPILED:     workerPath=/side-agent/worker-entry.mjs         exists=false
 *
 * — the relative walk `new URL("../../side-agent/worker-entry.mjs", import.meta.url)`
 * runs off `/$bunfs/root/` and escapes to the FILESYSTEM ROOT.
 *
 * But the escaped path is only the visible half. Embedding the worker with
 * `with { type: "file" }` makes the path exist (`/$bunfs/root/worker-entry-*.mjs`,
 * exists=true) and the fork is STILL broken, far worse than before — measured:
 *
 *   - `child_process.fork` launches `process.execPath`, which in a compiled
 *     binary is THE APP ITSELF, and the single-file binary IGNORES argv[1] as a
 *     module. So the "worker" child is a second copy of the whole application.
 *     A probe that forked once produced 328 recursive processes — a FORK BOMB.
 *   - the embedded path is process-PRIVATE: an external `bun /$bunfs/root/…`
 *     answers `Module not found`, and `ls` answers `No such file or directory`.
 *     So no `execPath` override can rescue it either.
 *
 * Embedding is therefore NECESSARY (it stops the escape to `/`) but NOT
 * SUFFICIENT (it cannot make the fork work). The honest contract is that the
 * port REFUSES, loudly and typed, instead of fork-bombing.
 *
 * THE CWD TRAP. `import.meta.url`-derived paths and `createRequire` both fall
 * back to the cwd inside a compiled binary, so a probe run from the repo root
 * passes even when the artifact is broken. The compiled probe below runs from a
 * cwd OUTSIDE the repo for exactly that reason.
 *
 * The probe entry must live INSIDE the repo: bun resolves bare specifiers
 * (`@/…`) against the nearest `node_modules`, so a scratch-dir entry cannot be
 * compiled at all.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runtimeConfigFromEnv } from "@/shared/runtime-config"

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

/**
 * The probe body, shared by the COMPILED run and the FROM-SOURCE control so the
 * two are the same measurement under two runtimes — the only difference that
 * may show up is the one this hellgate is about.
 *
 * RE-EXEC GUARD (load-bearing): inside a compiled binary `fork()` re-execs the
 * BINARY, so the child is this very probe. Without an early bail the probe
 * fork-bombs the machine — that is not a hypothetical, it is what the original
 * measurement did. A forked child is identifiable by its IPC channel, so it
 * announces what it actually is and exits. When the port behaves correctly no
 * child is ever spawned and this branch is dead code.
 */
const PROBE = [
  `import { existsSync } from "node:fs"`,
  `import { nodeProcessForkPort, sideAgentWorkerModulePath } from "@/host/runtime/side-agent-fork-port"`,
  ``,
  `if (typeof process.send === "function") {`,
  `  process.send({ kind: "probe-child-is-the-app-not-the-worker" })`,
  `  process.exit(0)`,
  `}`,
  ``,
  `const workerPath = sideAgentWorkerModulePath()`,
  `const out: Record<string, unknown> = { workerPath, exists: existsSync(workerPath) }`,
  `try {`,
  `  const handle = nodeProcessForkPort.fork({ modulePath: workerPath })`,
  `  out.forkRefused = false`,
  `  out.forkOutcome = await new Promise<string>((res) => {`,
  `    const t = setTimeout(() => res("timeout"), 5000)`,
  `    handle.onMessage((m) => { clearTimeout(t); res(String(m.kind)) })`,
  `    handle.onExit(() => { clearTimeout(t); res("exit") })`,
  `  })`,
  `  handle.kill()`,
  `} catch (e) {`,
  `  out.forkRefused = true`,
  `  out.forkErrorName = (e as Error).name`,
  `  out.forkErrorMessage = (e as Error).message`,
  `}`,
  `console.log(JSON.stringify(out))`,
].join("\n")

const runProbe = (cmd: readonly string[], cwd: string): Record<string, unknown> => {
  const run = Bun.spawnSync({ cmd: [...cmd], cwd })
  const stdout = new TextDecoder().decode(run.stdout).trim()
  const stderr = new TextDecoder().decode(run.stderr).trim()
  const last = stdout.split("\n").at(-1) ?? "{}"
  try {
    return JSON.parse(last) as Record<string, unknown>
  } catch {
    throw new Error(
      `probe produced no JSON (exit ${run.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
}

describe("side-agent fork port survives compilation", () => {
  test(
    "a COMPILED binary run OUTSIDE the repo resolves a REAL worker path and REFUSES to fork",
    () => {
      const entry = join(REPO_ROOT, `__side-agent-fork-probe-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "side-agent-fork-probe-"))
      const bin = join(out, "probe")
      try {
        writeFileSync(entry, PROBE, "utf8")
        const build = Bun.spawnSync({
          cmd: ["bun", "build", "--compile", entry, "--outfile", bin],
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(build.exitCode).toBe(0)

        // cwd OUTSIDE the repo — see THE CWD TRAP above.
        const result = runProbe([bin], out)

        // 1. The path no longer escapes to the filesystem root. `/side-agent/…`
        //    with exists=false was the original measurement.
        expect(result.exists).toBe(true)
        expect(String(result.workerPath).startsWith("/side-agent/")).toBe(false)

        // 2. The port REFUSES rather than re-execing the app as a "worker".
        //    `forkOutcome: "probe-child-is-the-app-not-the-worker"` is the exact
        //    shape of the defect: a child was spawned and it was the binary.
        expect(result.forkRefused).toBe(true)
        expect(result.forkErrorName).toBe("SideAgentForkUnsupportedError")
        // The failure must NAME the limitation, not just fail.
        expect(String(result.forkErrorMessage)).toMatch(/compile/i)
      } finally {
        rmSync(entry, { force: true })
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )

  test(
    "PAIRED CONTROL — from SOURCE the same probe still really forks the worker",
    () => {
      // The guard must fire ONLY in a compiled binary. If this control ever goes
      // red, the "fix" broke the working path instead of describing it, which is
      // the regression a one-sided compiled assertion cannot see.
      const entry = join(REPO_ROOT, `__side-agent-fork-src-probe-${process.pid}.ts`)
      try {
        writeFileSync(entry, PROBE, "utf8")
        const result = runProbe(["bun", "run", entry], REPO_ROOT)
        expect(result.exists).toBe(true)
        expect(result.forkRefused).toBe(false)
        // A real forked `worker-entry.mjs` beacons `ready` over IPC.
        expect(result.forkOutcome).toBe("ready")
      } finally {
        rmSync(entry, { force: true })
      }
    },
    { timeout: 120_000 },
  )

  test("the gate stays default-OFF — nothing constructs this port unless opted in", () => {
    // This lane is gated. A fix that changed behaviour with the gate OFF would
    // be a regression nobody asked for, so pin the default explicitly.
    expect(runtimeConfigFromEnv({}).sideAgentProcess).toBe(false)
    expect(runtimeConfigFromEnv({ QUANTA_SIDE_AGENT_PROCESS: "1" }).sideAgentProcess).toBe(true)
  })
})
