# RFC — `/doctor` startup self-diagnostic

**Date:** 2026-06-06
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/apps/cli` (a new `/doctor` slash command + a check-registry leaf) consuming
**injected probes** over existing subsystems (auth / terminal / MCP / config / state-DB). No
new core slice — the check-registry is a pure leaf; each check is a `() => CheckResult` fed by
duck-typed probes the CLI surface wires.
**Default posture:** OFF in the sense of additive — `/doctor` is a new, read-only command that
mutates nothing. It is **registered** like `/status` (no env knob needed for a read-only
diagnostic), but can be env-gated for parity if desired (`QUANTA_DOCTOR=0` removes it, default
registered — mirroring `/rewind`/`/memory`, `registry-app.ts:34-44`).

> Scope note: quanta has `/status` (auth/provider/token) and `/knobs`/`/permission`/`/mcp` —
> but **no single "why isn't this working" diagnostic** that runs every subsystem health
> check at once and renders a pass/warn/fail report. `grep -rn "doctor\|selfcheck" src/` → 0
> hits (the only "diagnostic" matches are LLM-stream internals, unrelated). `/doctor` is the
> missing first-thing-to-run command.

---

## 1. 요약 (Summary)

When something is misconfigured — no API key, an MCP server that won't connect, a corrupt
state DB, a non-TTY terminal eating prompts — the user has to hunt across `/status`, `/mcp`,
`/knobs`, and logs to find it. There is **no consolidated diagnostic**.

This RFC adds **`/doctor`**: a read-only startup self-check that runs a **registry of
independent checks** and renders a single pass / warn / fail report with an actionable
"왜 안 되지" remedy per failing check. Checks cover:

- **auth** — is a provider key / OAuth token present and unexpired? (reuses `/status`'s probes)
- **terminal** — is stdout a TTY, is the width sane, is raw-mode available?
- **MCP** — do configured MCP servers connect + list tools?
- **config** — does `runtimeConfig()` validate, and are any knobs set to known-bad combos?
- **state-DB** — are the session store / index / memory DBs readable + non-corrupt?

The design is a **check-registry**: each check is a pure `(probes) => CheckResult`
(`{ id, status: "ok"|"warn"|"fail", detail, remedy? }`) with its subsystem access **injected**
as a duck-typed probe (closed-port DI — no `Date.now`/`process.env`/network in the leaf; the
CLI surface wires real probes). A renderer turns the `CheckResult[]` into the same rounded box
`/status` uses. `/doctor --json` emits machine-readable results for CI / bug reports.

What it is NOT: a *fixer* (read-only — it never mutates config or reconnects; it *reports* and
suggests), a replacement for `/status`/`/mcp` (it *aggregates* them), or a new core slice.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **Claude Code** ships a `/doctor` that checks installation/auth/IDE-integration health and
  prints a pass/fail report — the direct analogue, name included.
- **Codex** has a startup health/`init-verifiers` notion (per the union-audit memory, "MITM
  proxy / advisor / init-verifiers" was flagged as a competitor capability quanta lacks). A
  check-registry is the absorbable shape.
- The honest divergence: quanta already *has* the underlying probes (`/status` for auth,
  `/mcp` for servers, `runtimeConfig()` for config) — `/doctor` is the **aggregator +
  remedy layer** over capabilities that today are scattered. It is high-ROI precisely because
  the hard parts (the subsystem accessors) already exist.

---

## 3. 현재 quanta 상태 (grep-verified, cite file:line)

### 3.1 No consolidated diagnostic exists

`grep -rn "doctor\|selfcheck\|self_check" src/` → only unrelated LLM-stream "diagnostics"
comments (`src/llm/streaming-events.ts:44`, `responses-stream.ts:170`). No `/doctor` command,
no check registry. The slash registry's surface layer (`src/apps/cli/slash/registry-surface.ts`)
lists `context`/`usage`/`cost`/`plan`/`state`/`status`/`login` etc. — but nothing aggregates
health.

### 3.2 The probes `/doctor` needs already exist

- **auth:** `/status` (`src/apps/cli/status-cmd.ts:1-50`) already resolves provider + key env
  state + ChatGPT-OAuth token (`readResolvedToken`, `isExpired`,
  `resolveChatgptTokenCandidates`, `pickProvider`) and "tolerate[s] permission / shape errors
  gracefully (surfaces them in the box so the user knows why)" (`status-cmd.ts:8-10`). The
  doctor's auth check reuses these exact probes.
- **config:** `runtimeConfig()` (`src/shared/runtime-config.ts:129+`) is a validated-and-frozen
  snapshot; a doctor check can assert it loaded without error and inspect known-bad knob combos
  (e.g. `mcpSampling` ON but no handler composed — the field's own doc warns it is "a no-op",
  `runtime-config.ts:160-175`).
- **MCP:** the MCP client (`src/mcp/client.ts`, `isolated-client.ts`) + `/mcp` slash already
  connect + list tools; the doctor's MCP check drives a connect+`listTools` probe per
  configured server.
- **state-DB:** the session store (`src/session/store.ts` `readSavedSession`,
  `loadSessionById` — returns `undefined` + logs on corrupt/shape-mismatch, `store.ts:213+`)
  and memory DBs (`src/memory/vector.ts`, `consolidate/schema.ts`) are readable; the doctor's
  state check opens + validates them.

### 3.3 The render + registration patterns to copy

- **Render:** `/status` uses `renderBox` + `kvLine` + `green`/`yellow`/`red` from `auth-ui`
  (`status-cmd.ts:21-33`) — the doctor report reuses the same rounded-box vocabulary so it
  looks native.
- **Register:** `SlashCommand` is `{ name, describe, run(args, ctx): Promise<number>,
  category? }` (`src/apps/cli/slash-contract.ts:168-188`); `/doctor` is one more entry,
  `category: "other"` (or a new `"diagnostic"`). Gated-registration precedent:
  `registry-app.ts:34-44` (env-gated module-load inclusion).
- **Injected `now`:** `SlashContext.now?: () => number` (`slash-contract.ts:15`) is the
  existing injected clock — the auth-token-expiry check reads it, no `Date.now`.

---

## 4. 설계 (Design — closed-port DI)

### 4.1 `CheckResult` + the check shape

```ts
// src/apps/cli/doctor/types.ts — pure leaf
export type CheckStatus = "ok" | "warn" | "fail"
export interface CheckResult {
  readonly id: string             // "auth" | "terminal" | "mcp" | "config" | "state-db"
  readonly status: CheckStatus
  readonly detail: string         // what was found ("no OPENAI_API_KEY")
  readonly remedy?: string        // the "왜 안 되지" fix ("run /login --chatgpt or set …")
}
export type Check = (probes: DoctorProbes) => Promise<CheckResult>
```

### 4.2 `DoctorProbes` — injected, duck-typed (no ambient access)

Each subsystem accessor is an injected probe; the check leaf imports **nothing** from
`@/auth`/`@/mcp`/`@/session` directly — the CLI surface wires real impls (closed-port DI):

```ts
export interface DoctorProbes {
  readonly now: () => number                                  // injected clock
  readonly auth: () => Promise<{ provider: string; keyPresent: boolean; tokenExpired?: boolean }>
  readonly terminal: () => { isTTY: boolean; columns: number; rawModeAvailable: boolean }
  readonly mcp: () => Promise<ReadonlyArray<{ name: string; connected: boolean; toolCount?: number; error?: string }>>
  readonly config: () => { loaded: boolean; warnings: readonly string[] }   // wraps runtimeConfig()
  readonly stateDb: () => Promise<{ sessionsReadable: boolean; indexValid: boolean; memoryReadable?: boolean; error?: string }>
}
```

The probes themselves are thin adapters built at the surface over the §3.2 accessors. A probe
that throws is caught by its check and rendered as `fail` with the error in `detail` (graceful,
mirroring `/status`'s error tolerance).

### 4.3 The registry (pure, ordered, total)

```ts
// src/apps/cli/doctor/registry.ts
export const DOCTOR_CHECKS: readonly Check[] = [authCheck, terminalCheck, mcpCheck, configCheck, stateDbCheck]
export async function runDoctor(probes: DoctorProbes): Promise<readonly CheckResult[]> {
  // run all, isolated: one check throwing ⇒ its own `fail` result, never aborts the rest
  return Promise.all(DOCTOR_CHECKS.map((c) => c(probes).catch((e) => failResult(c, e))))
}
```

Each check is pure given its probes — deterministic and unit-testable with fake probes. The
list is a frozen ordered registry (same discipline as `ALL_SUBMISSION_OP_KINDS`,
`submission.js:6`): adding a check = one array entry + one `Check` fn.

### 4.4 The renderer + exit code

`renderDoctorReport(results): string` reuses `renderBox`/`kvLine`/`green`/`yellow`/`red`
(`auth-ui`, §3.3): one line per check (`✓ auth   OpenAI BYOK`, `✗ mcp   server "foo" failed:
ECONNREFUSED — check the server command in .mcp.json`), and a trailing summary. The `run()`
returns a **non-zero exit code iff any check `fail`ed** (CI-friendly; `warn` is exit 0). A
`--json` flag emits `CheckResult[]` as JSON for bug reports / CI.

### 4.5 The individual checks (what each asserts + its remedy)

| Check | OK | Warn | Fail (+ remedy) |
|---|---|---|---|
| **auth** | key present / token unexpired | token near expiry | no key & no token ⇒ "run `/login --chatgpt` or set `OPENAI_API_KEY`" |
| **terminal** | TTY + width ≥ min + raw-mode | non-TTY (piped) | raw-mode unavailable ⇒ "interactive prompts won't work; run in a real terminal" |
| **mcp** | all servers connect + list tools | a server slow | a server fails ⇒ "server X: <error>; check its command/args in `.mcp.json`" |
| **config** | `runtimeConfig()` validates, no bad combos | a no-op knob set (e.g. `mcpSampling` w/o handler) | config failed to load ⇒ the validation error |
| **state-db** | sessions + index + memory readable | index stale | corrupt session/index ⇒ "session store unreadable at <path>: <error>" |

The `warn` for "a knob is set but is a no-op" directly leverages the runtime-config docs that
already enumerate these dead-knob conditions (`runtime-config.ts:160-175`).

---

## 5. 통합 (Integration)

- **Knob:** none required (read-only diagnostic, always useful). Optional `QUANTA_DOCTOR=0`
  module-load gate for parity with `/rewind`/`/memory` (`registry-app.ts:34`), default
  registered.
- **Slash:** `/doctor` added to the surface registry (`registry-surface.ts`), `category:
  "other"` (or a new `"diagnostic"` category on the `SlashCommand` union,
  `slash-contract.ts:172-181`). `--json` / `--verbose` flags parsed in `run()`.
- **Probes wiring:** the CLI surface builds `DoctorProbes` from the existing accessors — auth
  from `status-cmd`'s resolvers, terminal from `process.stdout` (read at the surface, injected
  in), MCP from the live client registry, config from `runtimeConfig()`, state-DB from
  `session/store` + `memory`. The check leaf stays pure.
- **Manifest/tool:** none — it is a slash command, not an LLM-facing tool. (A future
  `doctor`-as-tool, letting the agent self-diagnose, is a Phase-3 backlog idea.)
- **fc:** one feature-catalog node `doctor-selfcheck` on the CLI-diagnostic axis.
- **Fence:** the `doctor` leaf (`src/apps/cli/doctor/`) imports only its own `types.ts`; all
  subsystem access is via injected `DoctorProbes`. The surface (which legitimately imports
  `@/auth`/`@/mcp`/`@/session`/`@/shared`) builds the probes — keeping the registry testable
  and slice-clean.

---

## 6. 테스트 계획 (Hellgate + e2e)

`tests/unit/doctor-selfcheck-hellgate.test.ts` (fake `DoctorProbes`, deterministic):

1. **All-OK ⇒ exit 0.** Every probe healthy ⇒ all `ok`, report renders 5 `✓` lines, `run()`
   returns 0.
2. **One fail ⇒ exit non-zero + remedy.** MCP probe reports a failed server ⇒ that check is
   `fail`, the report shows the server name + error + remedy, `run()` returns non-zero; the
   OTHER four checks still ran and rendered (isolation).
3. **Check isolation (a throwing probe can't abort the run).** The auth probe throws ⇒ auth is
   `fail` with the error in `detail`; the remaining checks complete normally (the
   `.catch(failResult)` per-check, §4.3).
4. **Warn vs fail distinction.** A near-expiry token ⇒ `warn` (exit 0); a missing key ⇒ `fail`
   (exit non-zero). Assert the status mapping is exact.
5. **No-op knob warning.** Config probe reports `mcpSampling` ON without a handler ⇒ config is
   `warn` with the dead-knob detail (leverages the runtime-config doc condition).
6. **`--json` shape.** `/doctor --json` emits a parseable `CheckResult[]` with all 5 ids; no
   ANSI color codes in JSON mode.
7. **Determinism.** Same probes ⇒ identical report bytes (injected clock; no `Date.now`); the
   registry order is stable (frozen array).
8. **Read-only.** No check mutates any store/config (assert the fakes recorded zero writes) —
   `/doctor` reports, never fixes.

e2e: run `/doctor` against a real CLI with (a) a valid config → all-OK exit 0, and (b) a
deliberately-broken `.mcp.json` → MCP `fail` + remedy + non-zero exit.

---

## 7. 단계 (Phases)

- **Phase 1 (core):** `CheckResult`/`Check`/`DoctorProbes` types + the registry + `runDoctor`
  + the renderer + the auth/terminal/config checks (the cheapest, all-local probes) + the
  `/doctor` command. Hellgate 1–4,6–8.
- **Phase 2 (subsystem checks):** the MCP connect-probe + state-DB read-probe (the
  I/O-touching checks) + the no-op-knob config warnings (5) + fc node + `--json`/`--verbose`.
- **Phase 3 (optional):** expose `doctor` as a read-only LLM-facing tool so the agent can
  self-diagnose ("I can't reach the MCP server — `/doctor` says it's unreachable") + a
  `doctor --fix` opt-in that *suggests* concrete commands (still never auto-mutates). Backlog.

---

## 8. 리스크 / 대안 (Risks & alternatives)

- **R1 — a probe is slow / blocks startup.** The MCP connect-probe could hang on a dead
  server. *Mitigation:* each probe carries an injected timeout; a timed-out probe yields a
  `warn`/`fail` with "timed out", never blocks `/doctor`. `/doctor` is an explicit user
  command (not auto-run on every startup), so latency is bounded to when the user asks.
- **R2 — false alarms.** A `warn` for a deliberately-set no-op knob could annoy. *Mitigation:*
  `warn` is non-blocking (exit 0) and the detail explains exactly why; the user can ignore it.
  Per `no-heuristics-only-validated`, thresholds (min terminal width, "near expiry") are
  named constants justified by a real failure mode, not invented numbers.
- **R3 — read-only guarantee.** `/doctor` must never mutate. *Mitigation:* every probe is a
  reader; Hellgate 8 asserts zero writes. The remedy strings *suggest* commands but `/doctor`
  never runs them.
- **R4 — leaking secrets in the report.** The auth check reports *presence* + provider + token
  expiry, never the key/token value (mirrors `/status`'s existing redaction posture,
  `status-cmd.ts`). `--json` carries the same redacted shape.
- **Alternative — auto-run diagnostics on every startup.** Rejected: adds latency + noise to
  every launch; users want it *on demand* when something is wrong. (A future opt-in
  `QUANTA_DOCTOR_ON_START=1` could run a fast subset — Phase-3 idea, not default.)
- **Alternative — extend `/status` instead of a new command.** Rejected: `/status` is
  scoped to auth/provider/token and is intentionally narrow; overloading it with MCP/config/DB
  health muddies a clean command. `/doctor` *aggregates* `/status` (reuses its probes) while
  staying a distinct "full health sweep" surface.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/apps/cli/status-cmd.ts:1-50` — `/status` (auth/token probes + graceful-error +
  `renderBox`/`kvLine` render the doctor reuses).
- `src/apps/cli/slash-contract.ts:168-188` — `SlashCommand` shape + `category` union.
- `src/apps/cli/slash-contract.ts:15` — `SlashContext.now` (the injected clock).
- `src/apps/cli/slash/registry-app.ts:34-44` — the env-gated module-load registration pattern.
- `src/apps/cli/slash/registry-surface.ts` — the surface command list `/doctor` joins.
- `src/shared/runtime-config.ts:129-175` — `runtimeConfig()` validate + the dead-knob
  conditions the config check `warn`s on.
- `src/session/store.ts:213+` — `readSavedSession` (corrupt-tolerant reader the state-DB probe
  drives).
- `src/mcp/client.ts` / `isolated-client.ts` — the MCP connect+listTools probe target.

**To add (implementation, NOT in this RFC):**
- `src/apps/cli/doctor/types.ts` — `CheckResult` / `Check` / `DoctorProbes`.
- `src/apps/cli/doctor/registry.ts` — `DOCTOR_CHECKS` + `runDoctor` + the 5 checks.
- `src/apps/cli/doctor/render.ts` — `renderDoctorReport`.
- `src/apps/cli/doctor-cmd.ts` — the `/doctor` `SlashCommand` (parses flags, builds probes,
  runs, renders, returns exit code).
- `src/apps/cli/slash/registry-surface.ts` — register `/doctor`.
- `tools/feature-catalog/…` — `doctor-selfcheck` node.
- `tests/unit/doctor-selfcheck-hellgate.test.ts` — the §6 battery.
