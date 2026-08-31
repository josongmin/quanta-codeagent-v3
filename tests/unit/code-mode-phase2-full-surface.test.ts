/**
 * code-mode (RFC jun-6-code-mode, Phase 2) — FULL TOOL SURFACE binding hellgate.
 *
 * Phase 1 bound only `tools.read/grep/write`. Phase 2 binds the agent's FULL
 * registered set (`registry.toolNames()`), surfaced via `RunCodeCellOptions.
 * surfaceTools`. The SECURITY invariant is UNCHANGED — every bound `tools.<name>`
 * STILL routes through the SAME injected dispatch port (in production = the real
 * `dispatchTool`). This proves on the EXPANDED surface:
 *   - every name in the surface is bound + reachable as `tools.<name>`;
 *   - a name NOT in the surface is `undefined` (the cell cannot widen itself);
 *   - a mutating tool (`bash`/`write`) reached from a cell hits the SAME port
 *     (no second dispatch path — re-gating is the port's job);
 *   - marshalling: a malformed in-cell arg → typed failure not a crash;
 *   - the per-cell call cap + output cap still apply ACROSS the full surface;
 *   - default (absent surfaceTools) is the byte-identical Phase-1 3-tool surface.
 */

import { expect, test } from "bun:test"
import {
  CODE_MODE_DEFAULTS,
  type DispatchOutcome,
  isCellToolIdentifier,
  PHASE1_CELL_TOOLS,
  runCodeCell,
} from "@/codemode"

const LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  // This suite verifies surface binding, not deadline behavior.  Use the
  // production cell deadline so VM compilation under a loaded CI worker does
  // not turn a correct binding assertion into a scheduler-sensitive timeout.
  timeoutMs: CODE_MODE_DEFAULTS.timeoutMs,
  maxCalls: 64,
  outputCap: 16 * 1024,
}
const liveSignal = () => new AbortController().signal
const now = () => performance.now()

/** Spy port: records every (name,input), returns a scripted outcome. The
 *  security oracle — a call here means it went through the injected port. */
const spyPort = (outcome: (name: string, input: unknown) => DispatchOutcome) => {
  const calls: Array<{ name: string; input: unknown }> = []
  const port = async (name: string, input: unknown): Promise<DispatchOutcome> => {
    calls.push({ name, input })
    await Promise.resolve()
    return outcome(name, input)
  }
  return { port, calls }
}

// A representative FULL surface — read-only + mutating + exec + a snake_case
// gh name (RFC §4.2 identifier mapping) the cell must reach as `tools.gh_pr_view`.
const FULL_SURFACE = ["read", "grep", "write", "edit", "bash", "glob", "gh_pr_view"]

// ───────────────────────── FULL SURFACE BINDING ─────────────────────────────

test("full surface — EVERY registered tool name is bound as tools.<name>", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return ${JSON.stringify(FULL_SURFACE)}.map((n) => typeof tools[n]).join(",");`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // Each bound name is a function inside the cell. (The cell returns a string ⇒
  // JSON-stringified ⇒ wrapped in quotes; assert on the content.)
  expect(r.output).toContain(FULL_SURFACE.map(() => "function").join(","))
  expect(r.status).toBe("ok")
})

test("full surface — a snake_case name is dot-reachable (gh_pr_view → tools.gh_pr_view)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "PR#1" }))
  const r = await runCodeCell({
    code: `const x = await tools.gh_pr_view({ number: 1 }); return x;`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(calls.length).toBe(1)
  expect(calls[0]?.name).toBe("gh_pr_view")
  expect(calls[0]?.input).toEqual({ number: 1 })
  expect(r.output).toContain("PR#1")
})

test("full surface — a tool NOT in the surface is undefined (cell cannot widen)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    // `git_commit` is not in FULL_SURFACE → undefined; the cell cannot reach it.
    code: `return typeof tools.git_commit;`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("undefined")
  expect(calls.length).toBe(0)
})

test("full surface — a MUTATING tool (bash) routes through the SAME port", async () => {
  const { port, calls } = spyPort((name) => ({ ok: true, content: `ran ${name}` }))
  const r = await runCodeCell({
    code: `const out = await tools.bash({ command: "ls" }); return out;`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // bash went through the port — the cell has NO second dispatch path (in
  // production the port IS the real dispatchTool, which gates bash exactly like
  // a direct call: HARD_DENY / plan-mode / permission all fire there).
  expect(calls.length).toBe(1)
  expect(calls[0]?.name).toBe("bash")
  expect(r.output).toContain("ran bash")
})

test("full surface — HARD_DENY-able bash content is blocked exactly as direct", async () => {
  // The port denies (in production: the admissibility gate / HARD_DENY fires for
  // `rm -rf /`). The cell can try/catch but cannot make it succeed.
  const { port, calls } = spyPort(() => ({ ok: false, content: "HARD_DENY: destructive" }))
  const r = await runCodeCell({
    code: `
      let blocked = false;
      try { await tools.bash({ command: "rm -rf /" }); }
      catch (e) { blocked = (e && e.name === "ToolDenied"); }
      return blocked;
    `,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(calls.length).toBe(1)
  expect(calls[0]?.name).toBe("bash")
  // Denied → thrown typed ToolDenied into the cell; ZERO success.
  expect(r.output).toContain("true")
})

test("full surface — Promise.all over multiple mutating tools gates EVERY call", async () => {
  const { port, calls } = spyPort((name, input) => ({
    ok: true,
    content: `${name}:${(input as { path?: string }).path ?? ""}`,
  }))
  const r = await runCodeCell({
    code: `
      const xs = await Promise.all([
        tools.write({ path: "a", content: "1" }),
        tools.edit({ path: "b", oldString: "x", newString: "y" }),
        tools.bash({ command: "echo hi" }),
      ]);
      return xs.length;
    `,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // ALL THREE concurrent mutating calls went through the port — no race skips it.
  expect(calls.map((c) => c.name).sort()).toEqual(["bash", "edit", "write"])
  expect(r.output).toContain("3")
  expect(r.status).toBe("ok")
})

// ───────────────────────────── MARSHALLING ──────────────────────────────────

test("marshalling — a structured arg dumps NORMALLY across the boundary", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "ok" }))
  await runCodeCell({
    code: `await tools.write({ path: "p", content: "c", nested: { a: [1, 2], b: true } }); return 1;`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(calls[0]?.input).toEqual({ path: "p", content: "c", nested: { a: [1, 2], b: true } })
})

test("marshalling — a malformed in-cell arg is a TYPED failure, not a host crash", async () => {
  // The port (in production = dispatchTool) safeParses the input and returns a
  // no-throw ok:false for a malformed arg. The cell catches it; the host never
  // crashes. Here the spy simulates the typed failure for a bad shape.
  const { port, calls } = spyPort((_n, input) => {
    const ok = typeof (input as { path?: unknown }).path === "string"
    return ok ? { ok: true, content: "ok" } : { ok: false, content: "invalid_input: path required" }
  })
  let threw = false
  let output = ""
  try {
    const r = await runCodeCell({
      // path is a NUMBER, not a string — the tool schema would reject it.
      code: `
        let msg = "";
        try { await tools.write({ path: 123, content: "c" }); }
        catch (e) { msg = e.name + ":" + e.message; }
        return msg;
      `,
      dispatch: port,
      surfaceTools: FULL_SURFACE,
      limits: LIMITS,
      signal: liveSignal(),
      now,
    })
    output = r.output
  } catch {
    threw = true
  }
  // No host crash; the cell got a TYPED ToolDenied carrying the validation reason.
  expect(threw).toBe(false)
  expect(calls.length).toBe(1)
  expect(output).toContain("ToolDenied")
  expect(output).toContain("invalid_input")
})

// ───────────────────────── CAPS ACROSS THE SURFACE ──────────────────────────

test("call cap — the per-cell cap applies ACROSS the full surface (mixed tools)", async () => {
  // maxCalls=2: the cell issues 4 DIFFERENT-tool calls; only the first 2 reach
  // the port, the rest are refused at the binding (cap is a hard ceiling over the
  // whole surface, not per tool name).
  const { port, calls } = spyPort(() => ({ ok: true, content: "C" }))
  const r = await runCodeCell({
    code: `
      let denied = 0;
      const ops = [
        () => tools.read({ path: "a" }),
        () => tools.grep({ pattern: "x", path: "b" }),
        () => tools.write({ path: "c", content: "1" }),
        () => tools.bash({ command: "ls" }),
      ];
      for (const op of ops) { try { await op(); } catch (e) { denied++; } }
      return denied;
    `,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: { ...LIMITS, maxCalls: 2 },
    signal: liveSignal(),
    now,
  })
  expect(calls.length).toBeLessThanOrEqual(2)
  expect(["ok", "cap", "error", "timeout"]).toContain(r.status)
})

test("output cap — an over-cap return is truncated regardless of surface", async () => {
  const { port } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return "y".repeat(4000);`,
    dispatch: port,
    surfaceTools: FULL_SURFACE,
    limits: { ...LIMITS, outputCap: 128 },
    signal: liveSignal(),
    now,
  })
  expect(r.truncated).toBe(true)
  expect(r.output.length).toBeLessThanOrEqual(128)
})

// ───────────────── DEFAULT (absent surface) = PHASE-1 BYTE-IDENTICAL ─────────

test("default — absent surfaceTools binds EXACTLY the Phase-1 3-tool surface", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return [typeof tools.read, typeof tools.grep, typeof tools.write, typeof tools.bash].join(",");`,
    dispatch: port,
    // NO surfaceTools → falls back to PHASE1_CELL_TOOLS.
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  // read/grep/write bound; bash (Phase-2-only here) is NOT bound.
  expect(r.output).toContain("function,function,function,undefined")
  expect(calls.length).toBe(0)
  expect(PHASE1_CELL_TOOLS).toEqual(["read", "grep", "write"])
})

test("identifier predicate — snake_case names qualify, dashed names do not", () => {
  expect(isCellToolIdentifier("gh_pr_view")).toBe(true)
  expect(isCellToolIdentifier("read")).toBe(true)
  expect(isCellToolIdentifier("$weird")).toBe(true)
  expect(isCellToolIdentifier("has-dash")).toBe(false)
  expect(isCellToolIdentifier("1starts_digit")).toBe(false)
})

test("empty surface — no tools are bound (the cell can reach nothing)", async () => {
  const { port, calls } = spyPort(() => ({ ok: true, content: "" }))
  const r = await runCodeCell({
    code: `return typeof tools.read;`,
    dispatch: port,
    surfaceTools: [],
    limits: LIMITS,
    signal: liveSignal(),
    now,
  })
  expect(r.output).toContain("undefined")
  expect(calls.length).toBe(0)
})
