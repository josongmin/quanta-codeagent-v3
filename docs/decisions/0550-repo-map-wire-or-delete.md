# ADR-0550 — `QUANTA_REPO_MAP` is wired (the decision is WIRE), and the env-context plane is recorded as still dead

Status: Accepted (2026-08-24)
Slice: `src/agent/loop/context-assembler.ts` · `src/agent/types/wire-slots-session.ts` · `src/runner/knobs/knobs/repo-map.ts`
Feature: `repo-map-turn1-wire` (feature-catalog §1-agent-loop)
Related: RFC jun-6 §4 (bounded repo-map turn-0 injection) · ADR-0397 (`## Environment` block) · `probeTurnEnv` (deliberately still unwired — see Consequences)

## Context

`QUANTA_REPO_MAP` shipped as a registered runner knob with a schema, preset references, a documented purpose ("turn-0 orientation reduces wasted nav turns on SWE-bench"), a bounded probe (`probeRepoMap`), a scan adapter (`makeRepoMapScan`), a renderer (`renderEnvBlock`) and unit tests.

Everything except the call.

`probeRepoMap` and `probeTurnEnv` had **zero production call sites** — only tests. `TurnContextInput.env` had **no producer**, so `renderEnvBlock(input.env)` always saw `undefined` and the `## Environment` block never rendered at all. Measured through the real loop: with `QUANTA_REPO_MAP=1` the per-turn wire was **byte-identical** to the knob being unset. An operator who set it got nothing and believed they had enabled turn-0 orientation.

This also **disproves a premise recorded in the execution plan**, which listed "env probe 신규 wiring" under work-not-to-do on the grounds that it "already exists in the shipping CLI". It does not.

## Decision

**WIRE.** The wire-or-delete question resolves to wire, because the plumbing is complete and the gap is one missing call. Deleting would remove a documented, measurable bench lever on the grounds that someone forgot a line.

`prepareTurnContext` builds `env: { repoMap }` on **turn 1 only** when both the caps (`config.repoMap`) and the injected port (`config.repoMapScan`) are present. The caps exist precisely because turn-0 orientation is a one-time payment; re-scanning every turn would be the cost without the premise.

`AgentConfig.repoMapScan` is a new slot because the probe is deliberately IO-free — the `rg --files` call lives in the runner's `makeRepoMapScan`, mirroring how `probeTurnEnv` takes a pre-captured `git status`. That keeps `@/agent` free of `runShell` and lets a test hand in a canned tree.

The knob now sets **both halves**. Either alone is a no-op, and only one of them looks like a bug — which is exactly the state it shipped in. The adapter is built once at module scope: it is stateless, and a fresh closure per `apply` made two applies structurally unequal, which a knob-SSOT hellgate correctly caught.

## Consequences

- **Default-OFF is unchanged and asserted**: knob absent ⇒ the per-turn wire is byte-identical and carries no `## Environment` block.
- **Fail-soft**: `probeRepoMap` collapses every failure to `undefined`, and an absent scan port (a host that wires caps but forgets the adapter) yields `undefined` too — the turn never breaks over an orientation nicety.
- **Scope is the repo map only.** `probeTurnEnv` (platform / shell / git status / package manager) stays unwired: it costs a `git status` per session and no knob asks for it. Recorded here rather than smuggled in under a packet that excluded it.
- A first cut of the hellgate asserted on `input.system` and reported the working fix as broken. The env block rides the per-turn `<system-reminder>`, which is a **message**. The suite now captures the whole wire.
