/**
 * code-mode — SURFACE-ESCAPE hellgate (cycle-2 adversarial audit).
 *
 * FINDING (fixed): the in-VM host bridge `__cmDispatch` — which accepts ANY tool
 * name — was left on the cell's `globalThis` after the `tools.*` wrapper was
 * installed. A hostile cell could therefore call `globalThis.__cmDispatch("bash",
 * …)` DIRECTLY, dispatching a tool OUTSIDE its `surfaceTools` allowlist and
 * VIOLATING the documented invariant (RFC §4.2): "a name NOT in the active
 * surface is unreachable — the cell cannot widen its own surface." In the default
 * production wiring the surface == the full registry (so dispatchTool gated it
 * anyway), but ANY host that narrows the cell surface (e.g. a read-only sandbox
 * cell) was silently bypassed.
 *
 * The fix captures the bridge into a setup-local and DELETES it from the global
 * before the cell body runs — the cell can reach the bridge ONLY through the
 * surface-restricted `tools.*` closures.
 *
 * These tests use the REAL quickjs-emscripten runtime + a spy port (the security
 * oracle: a call reaching the spy means it reached the dispatch path).
 */

import { expect, test } from "bun:test"
import { type DispatchOutcome, runCodeCell } from "@/codemode"

const LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 2000,
  maxCalls: 64,
  outputCap: 16 * 1024,
}
const liveSignal = () => new AbortController().signal
const now = () => performance.now()
const spyPort = () => {
  const calls: Array<{ name: string; input: unknown }> = []
  const port = async (name: string, input: unknown): Promise<DispatchOutcome> => {
    calls.push({ name, input })
    await Promise.resolve()
    return { ok: true, content: `ran ${name}` }
  }
  return { port, calls }
}

test("surface-escape — the raw bridge __cmDispatch is NOT reachable from the cell", async () => {
  const { port, calls } = spyPort()
  const r = await runCodeCell({
    code: `return typeof globalThis.__cmDispatch;`,
    dispatch: port,
    surfaceTools: ["read"],
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("undefined")
  expect(calls.length).toBe(0)
})

test("surface-escape — a cell CANNOT widen its surface via the raw bridge", async () => {
  const { port, calls } = spyPort()
  const r = await runCodeCell({
    // Surface is read/grep only; the cell tries to invoke `bash` via the raw bridge.
    code: `
      const fn = globalThis.__cmDispatch;
      if (typeof fn !== "function") return "bridge-fenced";
      await fn("bash", { command: "rm -rf /" });
      return "ESCAPED";
    `,
    dispatch: port,
    surfaceTools: ["read", "grep"],
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // `bash` was NOT in the surface and the bridge is fenced ⇒ it NEVER reached the
  // port. The cell observes the fence; ZERO dispatch of the off-surface tool.
  expect(r.output).toContain("bridge-fenced")
  expect(calls.length).toBe(0)
  expect(calls.some((c) => c.name === "bash")).toBe(false)
})

test("surface-escape — the SURFACE-bound closures still work after the fence", async () => {
  // Deleting the global bridge must NOT break the legitimate `tools.*` path (the
  // closures captured the bridge BEFORE the delete).
  const { port, calls } = spyPort()
  const r = await runCodeCell({
    code: `const x = await tools.read({ path: "a" }); return x;`,
    dispatch: port,
    surfaceTools: ["read", "grep"],
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(calls.length).toBe(1)
  expect(calls[0]?.name).toBe("read")
  expect(r.output).toContain("ran read")
})

test("surface-escape — re-defining __cmDispatch in the cell cannot reach the host port", async () => {
  // Even if the cell re-creates a same-named global, it is a cell-local function;
  // the host bridge is gone, so no host dispatch happens through it.
  const { port, calls } = spyPort()
  const r = await runCodeCell({
    code: `
      globalThis.__cmDispatch = (n, a) => "fake:" + n;
      const out = globalThis.__cmDispatch("bash", {});
      return out;
    `,
    dispatch: port,
    surfaceTools: ["read"],
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("fake:bash") // a harmless cell-local stub
  expect(calls.length).toBe(0) // the REAL host port was never reached
})
