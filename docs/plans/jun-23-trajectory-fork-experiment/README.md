# Jun 23 — Trajectory Fork-Experiment (counterfactual troubleshooting)

Status: **RFC** — foundational seam LANDED + proven; per-branch replay isolation
invariant LANDED + pinned (§4.1); ergonomics/fan-out driver (§6/§7) pending decision.

Related:

- [jun-22 oracle proof clean v4](../jun-22-oracle-proof-clean-v4/README.md)
- [jun-22 repro oracle campaign](../jun-22-repro-oracle-campaign/PLAN.md)
- ADR-0192 (replay LLM), ADR-0226/0284 (fork-session), ADR-0537 (bench checkpoint/resume)

---

## 1. Problem

When a SWE-bench run (or any agent run) goes wrong, the question is almost always
**"what at turn N caused this, and what would have fixed it?"** — e.g. *"if the
model had the correct localization at turn 5, would it have resolved?"*, *"is the
misleading issue-suggested-fix note at turn 3 the anchor that kills it?"*.

Today the only way to answer is to re-run the whole instance against a live LLM
(tokens + minutes + EC2), changing one thing in code each time. That is too
expensive to iterate, so we **guess** instead of **measure** — directly against
the project's standing rule (no n=1 loop changes; measure first).

The capability we want, reusable going forward:

> **Replay a trajectory deterministically up to turn N, then at turn N hand the
> LLM DIFFERENT information, continue LIVE from there, and run K such branches in
> parallel to compare outcomes** — for ~zero tokens on the replayed prefix.

This is **counterfactual / time-travel debugging** for the agent loop.

## 2. Prior-art audit — what already exists (do NOT reinvent)

A systematic sweep (`src/agent/fork-session/`, `src/llm/replay/`, `src/session/`,
`src/apps/bench/`) found that **3 of the 4 building blocks already exist**:

| Capability | Status | Evidence |
|---|---|---|
| Deterministic prefix replay → live divergence | **EXISTS** | `src/llm/replay/replay-llm.ts` `onMiss=passthrough` / `record-and-passthrough` (ADR-0192); bench-wired in `src/apps/bench/trajectory.ts` (`QUANTA_BENCH_REPLAY_TRAJECTORY`) |
| Per-turn context as a mutable, replay-stable object | **EXISTS** | `src/agent/prompt.ts:120` `TurnContextInput` (carries `baseMessages`, `contextChangeEvents`, `hookPromptInjects`, `repoRules`, `env`, …) |
| K-way parallel fan-out with bounded concurrency | **EXISTS** | `src/apps/bench/sampler.ts:69` `sampleBestOfN` (worker pool + scoring) |
| **Mutate the per-turn context at a chosen turn** | **WAS THE GAP** | now `AgentConfig.turnContextMutator` — see §3 |

Session-level `/fork` + `/rewind` (`src/session/rewind.ts`) also exist but are
**CLI-REPL / ConversationCheckpointStore-bound — they do NOT reach a bench run**,
which is cassette-based. So the bench path needs the cassette+seam route, not
`forkSession`. (Recorded here so we don't try to bend `/fork` into bench again.)

## 3. The one genuine gap — the turn-context mutation seam (LANDED)

The only missing primitive: a hook to vary **exactly what the LLM sees at a
chosen turn**, applied at the single per-turn assembly chokepoint.

- **API** — `src/agent/types.ts` `AgentConfig.turnContextMutator?(turn, input) => input`
  - `turn` = 1-based loop index (`turn-loop.ts` iterates `for (turn=1..maxTurns)`).
  - Pure rewriter of the fully-assembled `TurnContextInput`.
  - **DEFAULT-OFF**: absent ⇒ input reaches `buildTurnContext` untouched ⇒
    byte-identical prompt.
- **Wiring** — `src/agent/loop/context-assembler.ts:285` (`prepareTurnContext`):
  assemble `turnInput`, apply the mutator iff present, then `buildTurnContext`.
  ONE chokepoint; the compaction/probe `buildTurnContext` callers are untouched.
- **Proof** — `tests/integration/turn-context-mutator-fork-e2e.test.ts`, through
  the **real `runAgent` loop** (`ScriptedLLM.seenMessages`):
  1. fires once per turn with the correct 1-based index (`[1,2]`);
  2. a sentinel injected ONLY at turn 2 appears in turn 2's SENT prompt and is
     absent from turn 1 (observed effect, not "was called");
  3. with NO mutator the sentinel never appears AND turn 1 is byte-identical to
     the mutated run (default-OFF + surgical scoping);
  4. red-on-injection: the targeted turn's bytes genuinely move.
  3/3 pass; adjacent assembly-path e2e (reminder/onPrompt/loop-decomp) 15/15 — no
  regression.

## 4. Core mechanism — why the rest is nearly free

The key insight that keeps this SOTA-minimal: **the mutator drives the fork; the
existing replay machinery handles divergence with no new replay code.**

```text
cassette (recorded trajectory)         turnContextMutator(turn, input)
        │                                        │
   turn 1..N-1: prompt == recording  ──►  replay HIT  (≈0 tokens)
   turn N:      mutator rewrites input ──► request-hash MISS ──► LIVE
   turn N+1..:  prompt now diverged    ──► MISS ──► LIVE (continues live)
```

Because replay matches by **request hash** and `onMiss=passthrough` falls through
to the real LLM, changing the turn-N prompt makes the cassette miss *exactly at N*
and go live from there — **fork-at-N + live tail**. No cassette truncation needed
for the mutator path (truncation stays an optional convenience for mutator-less
re-sampling, e.g. temperature variance).

Caveat: this assumes the ONLY LLM calls during the turn window are the per-turn
agent calls. Memory distillation runs *after* the loop (post-session) and
language detection is pure, so neither shifts cassette alignment. But a custom
plugin-activation callback that itself calls the LLM mid-turn WOULD consume
cassette entries and offset the fork point — out of scope for the standard bench
path, noted so it isn't a silent surprise.

### 4.1 Per-branch replay isolation (CORRECTION — reviewer jun-23)

The naive "K branches replay the same pristine cassette" is **NOT free with a
shared port**. The replay store is stateful: `match` marks each cassette index
`used` (`src/llm/replay/jsonl-store.ts:111,168`), and bench builds ONE replay
port for the whole run (`src/apps/bench/index.ts` `resolveLLM`) reused across all
Best-of-N attempts. So branch 1 *consumes* the prefix and branch 2+ MISS from
turn 1.

The fix is structural and cheap: **each branch builds its OWN port** —
`replayTrajectoryPort({ path })` already constructs a fresh `jsonlReplayStore`
(fresh `used`) per call, so calling it once per branch gives each an independent
full-prefix replay over the same cassette file. (`store.reset()` clearing `used`
is the equivalent in-place alternative.) The Phase-2 fan-out therefore does
`sampleBestOfN` with a **fresh replay port per arm**, never the shared one.

This invariant is pinned by
`tests/integration/fork-branch-replay-isolation-hellgate.test.ts`: shared port ⇒
branch 2 misses (sentinel for the bug); fresh-port-per-branch ⇒ both replay the
prefix identically; mutated turn-N ⇒ live divergence.

**Net new code beyond the landed seam: small — a fresh-port-per-branch fan-out
driver (§6/§7) + an ergonomics layer to select mutations without editing the
loop. The replay/concurrency engines are reused, NOT rewritten.**

## 5. Positioning — a frontier debugging capability for coding-agent benchmarks

This is **not a world-first concept**: LangGraph (time-travel + fork from a
checkpoint with *modified state*) and LangSmith (server-side time travel) already
ship checkpoint-based replay/fork with state edits. The honest framing is
narrower and still defensible:

> Unlike checkpoint rewind/fork systems, this path mutates the **exact
> turn-level LLM input** (the assembled prompt the model sees) and **reuses
> recorded prefix interactions** to keep branch cost near zero until divergence —
> inside the agent loop, against an LLM cassette.

| System | Trajectory debugging affordance | Gap vs this in coding-agent bench workflows |
|---|---|---|
| Claude Code | checkpoints / rewind (interactive, live re-run) | no cheap deterministic replay-prefix; no *turn-level LLM-input* counterfactual |
| Codex CLI | session resume | resume, not per-turn input mutation or prefix replay |
| LangGraph / LangSmith | time-travel + fork from checkpoint with modified state | state-level edits, not the agent's per-turn *prompt seam*; not LLM-cassette low-cost prefix replay |
| **This RFC** | per-turn LLM-input mutation + recorded-prefix replay + K-branch fan-out, ≈0 tokens on prefix | — |

(Cursor's checkpoint/restore was considered but is **omitted here — no clean
official-doc grounding this pass**; do not cite it as a comparison without a
verifiable source.)

The differentiator is **input-level counterfactuals at an arbitrary turn**, not
just "restart from a checkpoint". That is the lever that answers *"what
information at turn N changes the outcome"* — the question our campaign keeps
hitting (localization gap, anchoring trap, evidence quality). It turns the
bench-troubleshooting loop from *guess → expensive live run* into
*hypothesis → cheap replayed branch → measured diff*.

Grounding: Claude Code checkpoints/rewind; Codex CLI resume; LangGraph
time-travel/fork; LangSmith server time travel.

## 6. Ergonomics layer — options (DECISION NEEDED)

The seam requires code to set `turnContextMutator`. To "keep using it going
forward" we need a way to **select a mutation without hand-editing the loop**.
Three postures, cheapest-first:

1. **Named-experiment registry + env** *(recommended)* — a
   `fork-experiments.ts` map of `name → mutator`, selected by
   `QUANTA_FORK_EXPERIMENT=<name>[,<name>...]`; multiple names ⇒ `sampleBestOfN`
   fan-out, one branch per name, outcomes diffed. Each new investigation adds one
   small function. Reuses seam + sampler + replay; no new CLI surface.
2. **Seam + doc recipe only** — no driver; each investigation is a ~15-line
   script that sets `turnContextMutator` and calls `runAgent`/the bench driver.
   Zero over-build; but hand-wired every time.
3. **Dedicated `bench fork` CLI** — `bench fork --cassette t.jsonl --at N
   --branches a,b,c --instance X`. Most ergonomic, most new surface
   (arg-parsing, help, validation) → highest over-build risk.

**Recommendation: (1).** It is the smallest layer that makes the capability
*repeatable* (the user's stated goal) without inventing a CLI surface. (2) is the
fallback if we want zero standing code. (3) is deferred until usage proves the
registry is too clumsy.

## 7. Phasing, gates, tests

- **Phase 0 — seam (DONE).** `turnContextMutator` + e2e hellgate. Default-OFF,
  byte-identical, regression-clean. ✅
- **Phase 1 — registry driver (pending §6 decision).** `fork-experiments.ts` +
  env selection wired into the bench config builder; gate `QUANTA_FORK_EXPERIMENT`
  (unset ⇒ inert). Hellgate: an experiment name flips a measurable prompt byte at
  turn N through the bench driver; unknown name = hard error (no silent no-op).
- **Phase 2 — K-branch diff (small, but NOT "free").** `sampleBestOfN`
  arm-per-name; emit a per-branch outcome table (resolved? / patch bytes / repro
  oracle). Reuses the existing sampler — **but each arm MUST build its own replay
  port** (§4.1); the current bench wiring shares one port and would break replay
  for branch 2+. Hard-gate the replay mode: with branches, `onMiss=throw` fails
  exactly at the intended fork point (good — surfaces an unintended divergence),
  and `record-and-passthrough` would contaminate the shared cassette with
  divergent tails unless each branch gets its own copy/path. Default to
  `passthrough` (no write-back) per branch.
- **Optional — `truncateCassette(path, n)`.** ~30 LOC; only for mutator-less
  re-sampling. Not on the critical path.

**Test posture (every phase):** default-OFF byte-identical control + red-on-
injection + wiring-proof (the experiment actually reaches the SENT prompt), per
the project's strong-test culture. No answer-key content in any mutator (mutators
inject *hypotheses/evidence framing*, never gold-patch/FAIL_TO_PASS/file-path
matches — same blindness contract as the evidence packet).

## 8. Non-goals / risks

- **Not** a replacement for live measurement of a *final* config — it is a
  *troubleshooting* tool to form hypotheses cheaply; confirmation still runs live.
- Post-divergence cassette tail (turns > N) becomes dead weight under
  `passthrough` — harmless, but note it so nobody reads "cassette has 40 turns"
  as "40 turns replayed".
- Mutators are ad-hoc by nature (different per bug). The registry keeps them in
  one auditable place so they can be reviewed for answer-key leakage.
- **Remote/pool fan-out is a NON-GOAL for now.** `buildForwardedBenchEnv`
  (`src/apps/bench/remote/box-session.ts`) explicitly THROWS when
  `QUANTA_BENCH_REPLAY_TRAJECTORY` is set — a local cassette path cannot be
  blindly forwarded to a box. So "parallel branches" here means **local**
  `sampleBestOfN` workers. Remote replay needs explicit cassette-upload wiring
  and is out of scope until proven needed.
