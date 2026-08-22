# TB21-06 — contracts transferred out of the retired TB2.0 documents

**Ticket:** [TB21-06](./tickets/TB21-06-retire-2-0-and-refresh-smoke.md)
**Retirement manifest:** [TB21-00](./TB21-00-retirement-manifest.md) rows DR-1, DR-2, SC-1, SC-3
**Status:** ACTIVE AUTHORITY. This document is the home of every still-live contract
that previously lived in a retired TB2.0 document.

The retirement manifest binds a stop rule: *"If an old file still owns a live lever
contract, migrate that contract and prove its new consumer before deletion."* Four
contracts were in that position — each is enforced at runtime by a test that would
otherwise assert against a deleted authority. They are restated here **verbatim in
substance**, and the enforcing tests now cite this file.

Git history remains the archive for everything else in the retired documents. The
sources are named per contract so the original bytes stay recoverable.

---

## TC-1 — Ownership boundary: no Terminal-Bench naming outside the entry points

*Transferred from `docs/rfc/jun-29-rfc-terminal-bench-integration.md` §5.3 (and its §3
absolute invariant #1).*
**Enforced by:** `src/tool/terminal-surface.test.ts` — the
`describe("ownership boundary — no Terminal-Bench naming leaks outside src/apps/")` block.

> Everything that enters the core or the CLI for Terminal-Bench's sake must be
> justifiable as a **general capability for driving a terminal**. If it cannot be, it
> lives only inside the benchmark adapter under `src/apps/` (or the repo-root
> `adapters/terminal-bench/`). **No code in the core knows "this is Terminal-Bench."**

The boundary, drawn as the RFC drew it:

```
┌─ entry points (src/apps/) · ONLY above this line may know "Terminal-Bench" ──────┐
│  product CLI          SWE-bench (apps/bench)        ★ Harbor BaseAgent shim      │
│  (repl/cli.ts)        buildDefaultTools()           = the ONLY TB-aware code     │
└────┬────────────────────────┬────────────────────────────┬──────────────────────┘
─ ─ ─│─ ─ ─ ownership fence ─ │─ ─ ─ (everything below is generic) ─│─ ─ ─ ─ ─ ─ ─ ─
     │ surface=cli            │ surface=bench                      │ surface=terminal
     ▼                        ▼                                    ▼ (BASE not inherited)
┌─ SURFACE selection (manifest SSOT · affordance → toolset, never an "is it a bench?" branch)
│  bench/cli → buildDefaultTools() (BASE)          terminal → buildTerminalTools()
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               ▼
┌─ core loop (unchanged) turn-loop → same-turn-engine: LLM → tool → observe ──────┐
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               ▼
┌─ TOOLS ─ repo: lsp/grep/edit/apply_patch  ·  terminal: pty_* (+ container_exec)
│           bash = host-bound (runShell) → FORBIDDEN on the terminal surface (S3)
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               ▼ (terminal only; S3 container-bound)
┌─ TmuxExec seam ─ local: host tmux | container: docker exec ─────────────────────┐
└──────────────────────────────────────────────────────────────────────────────────┘
grading: Harbor (container + tests/test.sh → reward) — outside us, and authoritative
```

The mechanical form the test asserts: no file under `src/` **outside `src/apps/`** may
contain `TerminalBench`, `terminal-bench`, `Harbor`, or `BaseAgent` (case-insensitive),
across every scanned file type, not only TypeScript.

### TC-1a — the surface spec (S1–S4) and the brain spec (B3/B4)

The `S*` / `B*` labels used throughout `src/tool/**` and `src/apps/terminal/**` comments
and test names originate here. They are stated once, and each is pinned by a named test:

| id | invariant | pinned by |
|---|---|---|
| **S1** | `terminal` is a first-class `ToolSurface`, not folded into `bench`. | `src/tool/terminal-surface.test.ts` |
| **S2** | The terminal registry is **BASE-free** — no repo-edit/host-exec tool is inherited. `buildTerminalTools` with no ports yields an EMPTY set (fail-safe), never a BASE fallback. | `src/tool/terminal-surface.test.ts` |
| **S3** | Exec-capable terminal tools are **container-bound** (`docker exec` / orchestrator env-exec). Host `bash` is never registered on this surface. | `src/tool/terminal-surface.test.ts`, `tests/unit/container-exec-harddeny-hellgate.test.ts` |
| **S4** | Adding the terminal surface is **byte-identical** for every existing surface's default registry. | `src/tool/terminal-surface.test.ts` |
| **B3** | The brain-mode entry point runs the agent loop over a JSON-line duplex to the hands process, obtaining tools + guide via `terminalSurfaceOverDuplex`. | `src/apps/terminal/brain-mode.test.ts` |
| **B4** | The terminal ToolSurface composition root assembles only from injected ports — no orchestrator/Harbor/Docker specific leaks into it. | `src/apps/terminal/terminal-surface.test.ts` |

Architecture the spec describes (unchanged by 2.1; only the Harbor pin moved):

```
quanta-TS (brain) ── ContainerExec port ──┬─ impl-A dockerExecTmux (standalone/local dev, docker exec)
  terminal surface:                       └─ impl-B IPC bridge     (adapter: ↔ Python shim → env.exec)
   • container_exec (one-shot, non-TUI)         │
   • pty_* (interactive tmux, TUI)              │  JSON / stdio
   • (host bash forbidden)                      ▼
                                          Python BaseAgent shim (adapters/terminal-bench/ — the ONLY
                                          benchmark-aware code): holds the env, launches the quanta-TS
                                          subprocess, routes commands to env.exec, returns tokens +
                                          trajectory in the agent context
                                                │
                                          the harness (container + tests/test.sh → reward)
```

Companion hard invariants from the same RFC §3, still binding:

1. **No bench-specific wiring.** (Above.)
2. **default-OFF / byte-identical.** With the terminal surface unselected, behaviour is
   unchanged (SWE / CLI identical).
3. **No answer-key, no prompt sniffing.** The surface is never derived by matching the
   prompt text — brittle and gaming-adjacent.
4. **The preset system is not touched.** knob/preset stays SWE-bench scaffolding and is
   orthogonal to the terminal surface.

## TC-2 — The Harbor custom-agent selector shape

*Transferred from `docs/rfc/jun-29-rfc-terminal-bench-integration.md` §3/§5.1, cited by
`adapters/terminal-bench/pyproject.toml`.*
**Enforced by:** `adapters/terminal-bench/tests/test_harbor_pin.py` and
`src/apps/bench/terminal/harbor-command.test.ts`.

A custom agent is selected as **`module.path:ClassName`**. On the pinned Harbor
**0.21.0** this is the value of `--agent`:

```
harbor run --agent quanta_agent:QuantaAgent …
```

⚠️ The 0.16-era spelling `--agent-import-path` **no longer exists** and is retired. The
one authority for the argv is `src/apps/bench/terminal/harbor-command.ts`; no shell
script may assemble a Harbor command.

## TC-3 — Why a terminal-operator capability guide exists (and its red line)

*Transferred from `docs/rfc/jun-29-rfc-terminal-bench-integration.md` §4.5.*
**Enforced by:** `src/tool/terminal-capability-guide.ts` and the brain-mode hellgate that
asserts the full guide body reaches the model.

A terminal operator needs capability-level system guidance — drive a tmux pane, send
keystrokes, read the screen, recover from PATH/install errors. That guidance applies
**whenever the terminal surface is selected**, product or benchmark alike, which is what
makes it a general capability rather than benchmark wiring.

> **The line: bound to the capability (terminal-operator) it is allowed; bound to
> "Terminal-Bench" it is forbidden.**

The guide therefore steers *how to operate*, never *what the answer is*: probe before
assuming, treat the exit code as the completion signal, install on demand, prefer
structured exec over keystroke typing.

Version note: the original rationale quoted a failure-share statistic from the
Terminal-Bench **2.0** paper. That number is 2.0 evidence and is **not** restated as a
current claim — the rationale stands on the failure mode, not on a retired measurement.

## TC-4 — `SurfaceProfile`: surface-adaptive prompt composition

*Transferred from `docs/plans/jul-2-terminal-bench-levers/00-MASTER-PLAN.md` §X.*
**Enforced by:** `src/agent/surface-profile.test.ts` and
`src/apps/terminal/surface-profile-brain.test.ts`; implemented by
`src/agent/surface-profile.ts`.

Three cleanly separated layers (the shape Codex / Claude / Terminus all use):

| layer | who sets it | when | cacheable |
|---|---|---|---|
| **L1 base** ("how to work") | fixed in code | build | ✅ prefix cache |
| **L-surface** (capability posture: terminal-owner / repo-frozen / ci-bot) | **the ENTRY POINT declares it** | once, at launch | ✅ per-surface prefix |
| **task turn** (the problem) | the `instruction.md` / user query | per turn | n/a |

- **Surface is a deployment fact, not query-derived.** "Am I the Harbor terminal adapter?
  a CLI repl? a CI bot?" is known from *which entry point launched*, never inferred from
  the question. Inferring it would add a task-classification failure mode and break
  prompt caching.
- **Not core-hardcoded either.** The bad form is `if (terminal) {…}` inside the
  assembler. The correct form: the core exposes a **surface-profile registry**; each
  entry point selects/declares its own profile, and the core only composes.
- **Per-problem adaptation already lives in the task turn** (the full `instruction.md`).
  Swinging the system prompt per problem is unnecessary and anti-pattern.

Definition: a `SurfaceProfile` is `{ envPosture, operatorGuide, rulePack }` — a declared
module, not a branch. The terminal profile is owned-env + terminal-operator guide +
task-runner rules, and `brain-mode.ts` declares it at launch. Environment posture
(`QUANTA_TB_ENV_OWNED`) is folded INTO this one seam rather than existing as a second
ad-hoc `owned` injection.

**PROMPT-TEXT-ONLY by construction:** a `SurfaceProfile` carries only strings and a
rule-pack selector. It never references `SandboxPolicy` / `SandboxMode` / any
runtime-enforcement type, so a runtime-posture leak is a compile error rather than a
review catch.

---

## TC-6 — the RETAINED terminal-brain lever knobs

*Transferred from `docs/plans/jul-2-terminal-bench-levers/**` and
`docs/plans/jul-3-tb-lever-audit-fixes/**` (both deleted).*
**Enforced by:** `src/config/knob-inventory/extra.ts` (the value authority),
`src/apps/bench/terminal/config.ts` (`TERMINAL_PROFILE_KNOBS` — the selector authority),
and the per-knob tests named below.

Those plans were the **2.0 lever campaign**: their measurements, target lists and
competitor comparisons are retired evidence. The knobs they produced are **not** retired
(retirement manifest SR-12, reuse manifest RU-7a) — they are brain-behaviour levers that
2.1 *measures*. Their behavioural contract therefore lives here, so no code comment
points at a deleted plan.

| knob | contract (default-OFF ⇒ byte-identical unless noted) | resolver / test |
|---|---|---|
| `QUANTA_TB_ENV_OWNED` | Rebuilds the brain SYSTEM prompt with the **owned** environment posture — install/configure/build freely, a working environment IS the deliverable. Drops the frozen R-ENV install prohibition, adds R-ENV-OWNED / R-INSTALL-THRASH. **PROMPT-TEXT-ONLY**: swaps rendered rule text, touches no `SandboxPolicy` / os-sandbox / host enforcement. Delivered through the TC-4 `SurfaceProfile` seam, not an inline injection. | `src/agent/prompt-rules/**`, `tests/unit/agent/prompt-env-posture.test.ts`, `tests/unit/agent/prompt-rules/owned-rules.test.ts` |
| `QUANTA_TB_VERIFY_GATE` | Verify-before-finalize. The harness inspects the recorded trajectory for an end-to-end exercise of the deliverable; if none is found it injects **exactly one** bounded follow-up turn, then stamps an honest verification trichotomy (verified-pass / unverifiable / verified-fail). No-leak: never reads a hidden verifier or test. | `src/agent/converge/**`, `src/apps/terminal/brain-mode.ts` |
| `QUANTA_TB_OUTPUT_CONTRACT` | Sub-lever of the verify gate: the same single bounded nudge ALSO fires when an exercised deliverable ran to a **dirty exit**, not only when it was never exercised. Separate knob so its effect is measurable in isolation. | `src/agent/converge/**` |
| `QUANTA_TB_SELF_TEST` | Appends the self-test discipline to the instruction turn: build an executable self-test **from the task spec** covering the input range and edges, iterate the deliverable to green. A coverage discipline, not a re-check nag. No-leak: built from the spec only, never from provided test/verifier/answer files. | `src/tool/terminal-capability-guide.ts` (`SELF_TEST_DISCIPLINE`) |
| `QUANTA_TB_ORACLE_LOOP` | The **harness-enforced** repair loop: after the main run, if the agent's own self-test ran red, feed its own failing output back as a follow-up and let the agent re-edit and re-run — bounded to K rounds (`1`/`on` ⇒ K=2; hard-capped). Reads only the agent's own taint-clean receipt. | `resolveOracleLoopRounds` in `src/apps/terminal/brain-mode.ts` |
| `QUANTA_TB_WRITE_TOOL` | Mints `container_write_file` over the SAME `ContainerExec` bridge instance (one duplex, one id space) for exact-byte file authoring. | `src/apps/terminal/index.ts` |
| `QUANTA_TB_STREAM_CAP` | Caps streamed tool output on the terminal surface. | `src/apps/terminal/brain-mode.ts` |
| `QUANTA_TB_TRAJECTORY` | **Default-ON**, uniquely: a compact ordered cassette of the run (every tool call paired with its result, plus assistant text). Exists because a regression once could not be root-caused for lack of a record of what the agent did. `0`/`false`/`off` suppresses the field entirely. | `resolveTrajectoryOn` in `src/apps/terminal/brain-mode.ts` |

Two rules survive with them:

- **Values come from the profile, never the ambient shell.** The 2.0 drivers `export`ed
  these into the environment, which let a stale `export QUANTA_TB_VERIFY_GATE=1` silently
  join a "baseline" arm. In 2.1 the profile table decides every value (including the OFF
  ones, which are recorded rather than omitted) and delivers them as explicit `--ae`.
- **`QUANTA_TB_BEST_OF_N` is NOT in this table.** It was the ninth knob of that campaign
  and is retired (SR-6): trials belong to Harbor's `-k`.

## TC-5 (data) — the retired 2.0 smoke set

*Transferred from `tools/tb-smoke/run-tb-smoke.sh` + `tools/tb-smoke/smoke-set.md`.*
**Now lives at:** `src/apps/bench/terminal/retired-tb-2-0-smoke.ts`.

The 2.0 smoke driver hard-coded a GUARD / LEVER_REGRESSION / TARGETS task list. The list
is preserved **as retired evidence only**, so the canary hellgate can keep proving the
2.1 selection does not reuse it. It is not a target set: every label in it was justified
by 2.0-era competitor pass-rates against a different dataset revision.

**The 2.1 smoke authority is the revision-bound canary manifest**
(`src/apps/bench/terminal/canary.ts` + `terminal-bench-2-1-canary.json`), entered through:

```sh
bun run bench:tb:canary                      # print the ref-bound selection
bun run bench:tb -- run --tasks canary …     # run it through the ONE CLI
```

A measured 2.1 smoke set may be generated later from real 2.1 receipts, after the first
89-task `k=1` run, recording source run ids, dataset ref, selection rule and update date.
Until then no task is called a guard or winnable.
