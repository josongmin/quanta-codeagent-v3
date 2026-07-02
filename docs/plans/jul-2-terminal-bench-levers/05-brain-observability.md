# RFC: Terminal-brain observability — prompt + verdict + trajectory logging

**Date:** 2026-07-02 · **Status:** proposed · **Lever #0 (prerequisite)** — every other lever's box measurement is
faith-based without it.
**Target:** the audit gap surfaced 2026-07-02 — we could NOT confirm on the box whether env-posture's
`R-ENV-OWNED` actually reached the model, and verify-gate v1's rubber-stamp only showed up via reward correlation,
not the gate's own trace. The brain is a black box on the box.

## 1. Problem

The brain (`src/apps/terminal/brain-mode.ts`) writes a report JSON (`--report-out`) + stderr to
`QUANTA_TB_BRAIN_LOG_DIR`, but records **neither its assembled system prompt** (so "did env-posture apply?" is
unanswerable on the box — brain-mode.test.ts proves it in-process only) **nor the gate/verdict decision path**
(so verify-gate's behavior is invisible except by reward back-inference). Concretely, during the jul-02 audit:
- env-posture box effect: **unverifiable** (no prompt log).
- verify-gate: had to be caught by `verified-pass` vs reward mismatch, not by the gate's own trace.
- turn-budget: only inferrable from `metadata.turns` (worked, but by luck of that field existing).

Without this, A/B numbers are trusted on faith and RCAs cost hours of indirect inference (this whole jul-02 session).

## 2. Industry scan (absorb)

- **Codex:** structured rollout logging — every turn's prompt/response/tool-calls persisted (`rollout_details`),
  replayable. *Absorb:* persist the assembled system prompt + per-turn decisions as structured records.
- **Terminus 2 (TB SOTA):** asciinema + tmux capture — full terminal trajectory for post-hoc review. *Absorb:*
  keep the tool-call trajectory (we already capture it in `CapturingStream` — just persist it).
- **OpenTelemetry / quanta's own `otel-trace-sink`** (`tools/otel-trace-sink`, jun-28): run-labeled spans.
  *Absorb + REUSE:* emit brain spans to the existing sink; **but** jun-28-otel found the sink lacks run-id
  attribution — fix that here so multi-box streams are separable (jun-28 memory).
- **Agentless / SWE report.json:** structured per-run artifact the harness consumes. *Absorb:* the brain already
  has `writeReport` — extend the report, don't add a parallel channel.

**Avoid:** logging secrets (oauth token, API keys) — redact; logging the full prompt to STDOUT (reserved for
protocol frames) — stderr/report only; unbounded logs filling disk (the jul-02 ENOSPC lesson) — cap + opt-in.

## 3. Design — extend the report + an opt-in prompt/verdict trace

Behind `QUANTA_TB_BRAIN_TRACE` (default-OFF ⇒ byte-identical; when ON, write to `QUANTA_TB_BRAIN_LOG_DIR`):
1. **Assembled system prompt** → `<logdir>/<task>.system-prompt.txt` (once, at session start). Answers "did
   env-posture apply?" directly (grep `R-ENV-OWNED` / `R-ENV`). REDACT any credential-shaped token first.
2. **Verdict/decision record** → fold into the report JSON (reuse `writeReport`): `envPosture` in effect,
   `maxTurns` resolved, `verification` stamp + WHY (which classifier branch), whether the gate follow-up fired.
   The report already rides `AgentContext.metadata` (adapter `_apply_report_to_context`) → it lands in
   `result.json` with no adapter change.
3. **Tool-call trajectory** → `<logdir>/<task>.trajectory.jsonl` (the `CapturingStream` events, already in memory;
   just serialize). Bounded (cap N events / bytes). Enables post-hoc "what did it actually run" without re-runs.
4. **(optional) OTEL spans** → reuse `otel-trace-sink` WITH run-id/task-id labels (close the jun-28 attribution
   gap) so a multi-box campaign is separable in one stream.

Pure-core-friendly: the testable core (`runTerminalBrain`) takes an injected `trace` sink (like `writeReport`);
`main()` binds the real fs writer. No `process.*` in the core.

## 4. Adversarial audit (≥3 rounds)
- **R1 — secret leak.** The system prompt / env / trajectory must NOT persist oauth tokens, `*_API_KEY`, or the
  `~/.quanta/auth` contents. Redact by key-name pattern before write; unit-test that a seeded fake key is absent
  from the trace output. (This is why it's opt-in + redacted, not always-on.)
- **R2 — default-OFF byte-identical.** `QUANTA_TB_BRAIN_TRACE` unset ⇒ no files, no report fields added, no extra
  work. Report-equality test unset vs off.
- **R3 — disk blowup (jul-02 ENOSPC).** Cap trajectory bytes/events; system-prompt written once; no per-turn file
  spam. Log a visible truncation marker instead of unbounded growth.

## 5. Hellgate plan
- **P0 RED:** assert today the brain emits no system-prompt/verdict trace (baseline).
- **P1** inject a `trace` sink into `runTerminalBrain`; write system-prompt + trajectory + fold verdict into the
  report, behind `QUANTA_TB_BRAIN_TRACE`. Unit-test redaction (R1) + default-OFF equality (R2) + cap (R3).
- **P2** register `QUANTA_TB_BRAIN_TRACE` in `config/knob-inventory/*`.
- **P3** (optional) run-id-labeled OTEL spans reusing `otel-trace-sink`.
- **P4** box smoke: one run with trace ON → confirm `R-ENV-OWNED` present in the logged prompt when
  `QUANTA_TB_ENV_OWNED=1` (the check we COULDN'T do jul-02).

## 6. Value
- Turns every future box A/B from faith-based to **verifiable** (did the lever's prompt/verdict actually apply?).
- Collapses RCA time (jul-02's multi-hour indirect inference → a grep on the logged prompt/verdict).
- Prereq for trusting best-of-N (04) + verify-gate v2 (03) measurements. **Land this FIRST.**
- Pure observability: NO behavior change (default-OFF), NO f2p claim — it makes the OTHER levers measurable.
