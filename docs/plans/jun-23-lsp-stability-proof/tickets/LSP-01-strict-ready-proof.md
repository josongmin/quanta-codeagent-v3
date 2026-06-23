# LSP-01 - strict ready proof

## Goal

Raise strict-LSP admission from `binary launchable` to `task-relevant workspace
verified ready`.

## Problem

`verifyStrictPresetLspGrounding(...)` currently proves:

- a strict preset requires LSP;
- a task-relevant language was selected;
- the corresponding server binary is launchable.

That is necessary but insufficient. A launchable server can still fail to reach
ready state in the actual sandbox/workspace.

## Deliverable

Add a deterministic ready probe that reuses the same backend truth as the warm
pool.

Requirements:

- select the task-relevant file/language deterministically;
- use the real backend path, not a shadow fake;
- prove `ready` using the same readiness semantics already used by the warm
  backend (`ensureFileReady(...)` class of logic);
- fail closed for strict presets when ready proof does not succeed.

`binary on PATH` remains a cheap preflight, but it is not sufficient authority.

## Design constraints

- background prewarm is not admission proof;
- do not invent a second readiness heuristic that diverges from the pool's
  backend truth;
- strict ready proof must run in the same sandbox/env as the actual solve.

## Acceptance

- strict preset with missing binary fails closed;
- strict preset with launchable-but-not-ready workspace fails closed with a
  distinct ready-proof outcome;
- strict preset with ready workspace proceeds;
- unit/integration tests cover all three.
