# aug-23 — audit burndown: final plan

Source: the aug-22 adversarial audit (4 read-only lenses — SOLID / dead wiring /
security boundary / test vacuity) plus the gate-repair campaign that preceded it.
Everything already fixed landed in `87e81cb14`. **This document covers only what
is still open**, and it is the input to a multi-angle audit before any code moves.

## Ground rules for this burndown

1. **Every item states its EVIDENCE as an executed observation**, not an opinion.
   An item whose evidence cannot be re-run is not ready to implement.
2. **Every item states its RED test first.** TDD: the test that fails today, for
   the reason the item claims, before the fix exists.
3. **No ceiling raises.** Ratchets move down only. A legitimate exception carries
   a per-item justification comment.
4. **No behavior enablement without approval.** Turning on a currently-dead
   feature is a product decision, not a defect fix (see W-X).
5. **Blast-radius first ordering.** Security/correctness before debt burn.

## The convergence problem (read this before sequencing)

During the aug-22 session I repaired violations that concurrent sessions
introduced **five separate times** (3× bare `} catch {`, 1× `@/tool → @/objective`
value import, 1× undeclared knob, 1× raw `quanta.*` literal, 1× inline
`instanceof Error` ternary). Four other sessions commit to `main` continuously.

`gh run list --workflow=ci.yml --limit 200` shows **zero successful runs back to
2026-07-10**; every run fails with *"The job was not started because recent
account payments have failed"*. The merge gate has not executed in six weeks.

**Consequence:** this burndown does not converge while CI is dead. The local
green I produce is a snapshot, not a floor. W0 is therefore a hard prerequisite,
and it is the only item I cannot execute.

---

## W0 — restore the gate (BLOCKER, owner: user)

| Item | Owner | Note |
|---|---|---|
| W0-1 Unblock GitHub Actions billing | **user** | Nothing else in this plan holds without it |
| W0-2 Confirm one green CI run | me | All gates pass locally today, so this should be a no-op confirmation |

---

## W1 — live risk (highest blast radius)

### W1-1 · Process-global sandbox-escalation slot (SOLID HIGH)

- **Evidence.** `src/tool/bash/sandbox-escalation-wire.ts:70` is
  `let installed: BashSandboxEscalationHandler | undefined`. The installer
  (`src/host/runtime/sandbox-escalation-wire.ts:213`) closes over ONE session's
  `PermissionStore`, `onConfirm` and cap, then writes them into that module
  global. The module doc claims "idempotent (the assembler is the single
  caller)"; there are **two** callers (`agent-config-assembler.ts:924`,
  `security-rails-wire.ts:118`), and `src/sdk/embed.ts:170` calls
  `assembleAgentConfig` on **every `run()`**.
- **Failure.** Two concurrent embedded agents are last-writer-wins on one global:
  agent A's sandbox-blocked `bash` routes its approval prompt through agent B's
  `onConfirm` and records the ADR-0046 override into B's `PermissionStore` — the
  store A's admissibility gate never reads. Symmetrically, a `run()` without the
  knob executes `__setBashSandboxEscalationHandler(undefined)` and disarms a
  live sibling mid-flight.
- **Fix.** Add an `escalateSandboxBlock?` seam to `ToolContext`, bind it per-turn
  from dispatch exactly like the sibling rail `writeBudget`
  (`security-rails-wire.ts:60`), retire the module global.
- **RED test.** Two `AgentConfig`s assembled in one process with distinct
  `PermissionStore`s + distinct `onConfirm` spies; drive a sandbox block on A;
  assert A's spy fired and B's did not, and that the override landed in A's
  store. Today this fails (B's spy fires / B's store receives).
- **Risk.** `ToolContext` is a hot file with 39 seams; the build site is
  cross-track. Mitigation: additive optional field, default-absent ⇒ the bash
  tool is byte-identical, plus the existing per-turn binding pattern is copied
  verbatim from `writeBudget`.

### W1-2 · `tests/e2e-pty` is non-hermetic and ungated

- **Evidence.** `tests/e2e-pty/pty-harness.ts:111` passes
  `HOME: process.env.HOME` while its own comment claims an "isolated base".
  `src/shared/quanta-home.ts` resolves `~/.quanta`, which on this machine holds
  `auth/` (credentials), `permission-state.json` and **3,989 real sessions**.
  During a run the CLI emitted `route=claude-sonnet-4-6 … 401 invalid x-api-key`
  — a real outbound provider call from an input-layer test. No workflow runs
  `e2e:pty`; 4 of its 29 tests currently fail.
- **Fix.** Point the harness at a per-test temp root via `QUANTA_CONFIG_DIR`
  (the resolver's documented highest-precedence override), then re-diagnose the
  4 failures against a clean home. Decide CI placement after they are green.
- **RED test.** Harness-level: spawn the CLI under the harness and assert the
  process never reads `~/.quanta` (probe: point `QUANTA_CONFIG_DIR` at a temp
  dir, assert the real home's mtimes are untouched and the temp root is the one
  populated).
- **Risk.** Isolation may *expose* the real cause of the 4 failures rather than
  fix them. That is the point; they are currently masked by developer state.

### W1-3 · Security MED batch A (4 items, each independently reproduced)

| Item | Evidence | Fix direction |
|---|---|---|
| `runShell` uses `bash -lc` | `scrubEnv()` drops the provider key, then `-l` sources `~/.bash_profile` and the child sees `sk-ant-…`; `-c` control sees nothing | Give `runShell` the `disclaimShell` option `LocalSandbox` already has (`--noprofile --norc -c`) |
| Tool output spills BEFORE redaction | `src/tool/registry.ts:169-174` writes the full output to `<cwd>/.quanta/tool-output/*.txt` upstream of `applyRedaction`; `.quanta/` is not in `.gitignore` | Redact before spill; add `.quanta/` to `.gitignore` |
| LSP workspace-edit writes unjailed | `src/lsp/adapters/base/atomic-edit.ts:78-81` writes/renames `fileURLToPath(doc.uri)` with no `resolveJailed`; `rename-apply.ts` jails only the anchor | Jail every edit target, not just the anchor |
| Layer-1 source-class missing on 5 tools | only `read`/`bash` declare `classifySource`; `bash_await`, `pty_read`, `node_repl`, `code_cell`, `container_exec` do not, so whole-file `.env` substitution is structurally unreachable through them | Declare the source class on the 5 tools |

---

## W2 — structural leverage (buys more than it costs)

### W2-1 · Dead composition-seam ratchet

- **Evidence (measured, not estimated).** Of **55** exported
  `set*/install*/register*` seams under `src/`, **10** have zero production
  callers: `installBashBgRegistry`, `registerDatasetFamilyProfile`,
  `setActiveTurnHeader`, `setHostMode`, `setKernelObserverErrorSink`,
  `setKernelStreamAppendErrorSink`, `setKernelTerminalAppendErrorSink`,
  `setPermissionRecorder`, `setThreadPermission`, `setupProHarness`.
- **Why it is the leverage item.** The dominant dead-wiring shape in this repo is
  "slice defines a port, ships a no-op default, wires the *emit* side into the
  hot path, never lands the composition-root injection". Grep sees the emit and
  reports it live. This one ratchet detects that shape structurally and stops it
  recurring — it covers a large fraction of the 27 dead-wiring findings without
  turning any feature on.
- **Fix.** Ratchet pinning the dead-seam list at 10, one-directional, with a
  per-entry reason. Anti-vacuity floor (must observe ≥50 seams) and
  red-on-injection (a new unwired seam fails).
- **RED test.** Add a synthetic exported `setFooSink` with no caller ⇒ ratchet
  fails naming it.

### W2-2 · Revive the ISP role views

- **Evidence.** `CoreToolContext` and `SubagentToolContext` have **0 references**
  outside their own definition; `PlanToolContext` is not used by the only two
  consumers of the seams it names. **89** tool modules declare the full 39-seam
  `ToolContext` while dereferencing only `cwd`/`signal`.
- **Failure.** The views are the only compile-time expression of "which seams may
  a tool in this role touch". With them dead, a read-class tool can start
  dereferencing `ctx.reviewerAgent` — which spawns a review child agent — and
  nothing flags that a read-only tool gained subagent-spawn capability.
- **Fix.** Retype the 89 zero-seam tools to `CoreToolContext` (structural
  subtype, runtime unchanged), then a ratchet pinning "tools declaring bare
  `ToolContext`" at the new count.
- **RED test.** A read-class tool typed `CoreToolContext` that dereferences
  `ctx.reviewerAgent` must fail `tsc`.

---

## W3 — debt burn (measured remainders)

| # | Item | Remaining |
|---|---|---|
| W3-1 | god-FUNCTION allowlist entries | **39** |
| W3-2 | modules 900–999 lines (one edit from the hard 1000 gate) | **27** |
| W3-3 | cognitive complexity over 15 | **378** (worst 65) |
| W3-4 | 20-positional-arg functions with adjacent same-typed slots | 2 (`runRepairPhase`, `buildConfig`) |

All four are already ceilinged, so they cannot grow. Burn order: W3-2 (hard gate
proximity) → W3-1 → W3-4 → W3-3.

## W4 — warning debt

`noNonNullAssertion` 696 · `noConsole` 71 · `noTemplateCurlyInString` 22.
Pinned by `lint:debt`; reduce file-by-file and tighten after each batch.

---

## W-X — NOT in scope without an explicit decision

- **Wiring the 27 dead features** (permission audit sink permanently null, the
  ADR-0222 4-slice metric plane never emitting, `withFullObservability`
  unwired, `staticOwnerProvider` never injected, …). Each is *enabling a feature
  that is currently off*, with real behavior and cost consequences. W2-1 makes
  them visible and stops new ones; turning them on is the user's call, one by one.
- **Rust native sandbox non-conformance**
  (`crates/linux-sandbox-native/src/policy.rs:141` grants `extra_write_paths` the
  profile's access set, so read-only drops write on scratch scopes). Two-line
  fix, but `#[cfg(target_os = "linux")]` — cannot be compile-verified on darwin.
  Needs a Linux box.
- **Test mkdtemp leak root cause.** 302,055 leaked `/private/tmp` entries were
  cleaned (making `ls /tmp` 6.6s → 0.006s and un-breaking a timing test), but the
  tests still do not guarantee cleanup. Needs an `afterAll` discipline ratchet.

---

## Definition of done

1. All gates green: `typecheck:all`, `lint`, `lint:debt`, `fc validate/diff/lint/gates/reachability`, `pm:gate`, ratchet battery.
2. `bun test tests/unit` and `tests/integration` at 0 fail, twice consecutively.
3. Every item above either landed with its RED test, or explicitly listed under W-X with a reason.
4. **One green CI run.** Without W0 this criterion cannot be met and the rest is a local snapshot.
