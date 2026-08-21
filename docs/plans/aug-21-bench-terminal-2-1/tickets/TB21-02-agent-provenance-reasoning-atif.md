# TB21-02 — agent provenance, reasoning effort, and ATIF

**Priority:** P0
**Size:** L
**Depends on:** TB21-01
**Parallelizable:** no
**Live benchmark cost:** one successful and one failing live trajectory

## Goal

Make Quanta a submission-shaped Harbor agent: versioned, reasoning-effort honest,
and capable of producing an auditable ATIF trajectory for successful trials.

## Current defects

- `QuantaAgent.version()` returns `None`.
- The adapter was verified against an old `AgentContext` and puts the brain report
  only in free-form `metadata`.
- Terminal brain trajectories are Quanta-specific compact JSON, not proven ATIF.
- Harbor `--ak reasoning_effort=...` is not a proven owner of
  `QUANTA_REASONING_EFFORT` in the brain subprocess.
- The official 2.1 submission rail rejects rewarded trials without an auditable
  Hub trajectory path.

## Required changes

### Version and source identity

1. Add one runtime-injected `QUANTA_TB_AGENT_VERSION` contract.
2. The run command derives it from the exact Quanta SHA and package version.
3. A dirty development run uses an explicit non-promotable suffix; it may never
   present itself as the clean SHA.
4. `QuantaAgent.version()` returns the injected value and fails a promotable run
   when it is absent.

### Reasoning effort

1. Capture Harbor's pinned custom-agent kwargs/agent-kwargs contract.
2. Accept the official `reasoning_effort` argument.
3. Normalize it through Quanta's existing reasoning-effort vocabulary.
4. Pass exactly one value into `QUANTA_REASONING_EFFORT` for the brain.
5. Record the resolved value in agent info, report provenance, and ATIF metadata.
6. Unknown effort values fail before model invocation; no silent defaulting.

### ATIF trajectory

1. Use Harbor's official ATIF types/writer from the pinned dependency where
   available. Do not maintain a speculative mirror of an external schema.
2. Convert the live ordered brain transcript/tool events to ATIF without:
   - hidden verifier content;
   - credential/env values;
   - unbounded tool stdout;
   - synthetic reasoning text not emitted by the model.
3. Preserve tool name, arguments after secret redaction, result/exit state,
   timestamps/order, token/cost usage, model, effort, and termination status.
4. Populate the exact current `AgentContext` trajectory surface so Harbor creates
   a Hub `trajectory_path`.
5. Keep Quanta's compact verification/self-test receipts in metadata; ATIF is not
   a replacement for those typed outcomes.

## RED rails

- `version() is None` must fail.
- Missing/inconsistent injected SHA must fail promotion.
- `reasoning_effort=max` must reach the Quanta LLM composition root exactly once.
- Invalid effort must fail before `_spawn_brain`.
- A successful fake trial without ATIF must fail the promotability check.
- A failing/timeout trial must still produce a bounded terminal receipt.
- Secret sentinels in env/tool args/output must not appear in serialized ATIF.
- Event order must survive the brain -> adapter -> ATIF conversion.

## Expected owner files

- `adapters/terminal-bench/quanta_agent.py`
- `adapters/terminal-bench/tests/test_quanta_agent_run.py`
- new ATIF adapter/tests under `adapters/terminal-bench/`
- `src/apps/terminal/brain-mode.ts` and focused tests only where the report lacks
  an authoritative event needed by ATIF
- the suite identity/injection contract introduced by TB21-00A; TB21-03 wires
  those values from the final typed run manifest

Do not make the adapter parse log text when the brain can emit a typed field.

## Proof rails

```sh
python3 -m pytest -q adapters/terminal-bench/tests
bun test src/apps/terminal/brain-mode.test.ts
bun run typecheck
bun run lint
git diff --check
```

Box proof must inspect a real `result.json` and Harbor job metadata for:

- non-null agent version;
- correct provider/model and reasoning effort;
- token/cost fields;
- a successful trial trajectory path;
- parseable ATIF;
- no secret sentinel.

## Definition of done

- Harbor identifies Quanta with an exact non-null version.
- Requested reasoning effort is the effort sent to the provider and reported.
- A rewarded live trial has an auditable ATIF path.
- Timeout/crash remains a recorded zero-reward trial, not a missing trial.
- No hidden verifier or secret content is introduced into prompt or trajectory.

## Stop rule

If Harbor cannot create a trajectory path from the external-agent contract, stop
and resolve that authority boundary. Do not fabricate a `trajectory_path` string
or upload a custom log under an ATIF label.
