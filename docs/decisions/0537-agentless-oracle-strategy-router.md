# RFC-0537 - Strategy router + issue-derived behavioral oracle for SWE-bench

- **Status**: Proposed (2026-06-15)
- **Related**: [[0014-bench-repair-rounds]], [[0117-branch-search-minimal-change-bias]], [[0503-knob-governance-and-capability-layer]], [[0536-bench-remote-and-unified-cli]]
- **Scope**: `src/apps/bench`, `src/runner/batch/eval`, bench knobs/presets, SWE-bench analysis
- **Non-goals**: gold patch leakage, hidden test leakage, prompt-only "think harder" fixes, per-instance hardcoded heuristics

## Page 1 - Problem

`pylint-dev__pylint-8898` exposed a class of failure that current presets cannot
solve structurally:

```text
right file, wrong abstraction
```

The agent repeatedly localizes to the correct ownership area:

```text
pylint/config/argument.py
```

but chooses the wrong algorithmic abstraction:

```text
csv/shlex/general comma splitting
```

The required invariant is not "split comma-separated values" in general. It is:

```text
split only on delimiter commas that are outside regex quantifier braces
```

Example:

```text
foo, bar{1,3}
```

Expected tokens:

```text
foo
bar{1,3}
```

Wrong tokens:

```text
foo
bar{1
3}
```

This is not primarily a localization failure. LSP, repo map, issue hints, and
subagents can help find a place to edit, but they do not prove that the chosen
algorithm preserves the domain invariant. The current bench pipeline allows a
plausible wrong patch to reach the official grader:

```text
problem_statement -> agent patch -> official grader
```

That makes the official grader the first real semantic oracle. For SWE-bench,
that is too late for repair because hidden grading output must not be fed back
into the agent.

The missing capability is not another ordinary tool. It is a controller-owned
problem-solving strategy:

```text
issue text -> executable public oracle -> candidate generation -> oracle
verification -> repair with counterexample -> final official grade
```

## Page 2 - Taxonomy: tools, strategies, policies, presets

The architecture must keep four concepts separate.

### Primitive tools

Primitive tools are action capabilities the LLM can choose during a turn:

```text
read
grep
edit
bash
lsp
test_runner
```

They have local effects and observable outputs. The LLM can usually decide when
to call them because the controller records the actual result:

```text
exit code
stdout/stderr
file diff
tool error
```

### Evidence/oracle tools

Evidence tools generate or execute artifacts that can be checked:

```text
repro_oracle.generate
repro_oracle.validate_on_base
patch.verify_with_oracle
```

The LLM may generate oracle candidates, but the controller must validate them.
An oracle candidate is only a proposal until it reproduces on the base repo.

### Strategies

Strategies are not one-off tools. They are workflow state machines that define
which artifacts are requested, which tools run, and which gate decides the next
phase:

```text
TDD
CEGIS-style repair
issue-derived behavioral oracle repair
branch candidate selection
post-patch repair loop
```

Strategies must be controller-owned. The LLM can receive the current strategy
phase and produce the requested artifact, but it must not own phase transition
or final labels.

### Policies

Policies are hard constraints:

```text
hidden gold patch is forbidden as agent input
test_patch is forbidden as agent input
FAIL_TO_PASS/PASS_TO_PASS are forbidden as repair feedback
official grader result is final-only
retry is for transient infra, not wrong patches
```

### Presets

Presets are named bundles of knobs, strategy enablement, and budgets:

```text
agentless-v1
everything-v1
agentless-oracle-v1
```

A preset must not hide workflow semantics. It should only select a declared
strategy and its budget.

## Page 3 - Decision

Add a first-class `StrategyRouter` for bench runs and a first strategy:

```text
issue-derived-oracle-repair
```

This is a CEGIS-style generate/validate/repair loop adapted for SWE-bench:

```text
1. classify the issue with LLM assistance
2. generate public oracle candidates
3. validate oracle candidates on the unpatched base repo
4. activate the strategy only if at least one oracle reproduces
5. generate one or more candidate patches
6. verify each candidate with the validated oracle
7. repair failed candidates with public counterexamples only
8. send only oracle-passing candidates to the official SWE-bench grader
```

Important distinction:

```text
LLM-assisted classification is soft.
Strategy activation is hard.
```

The LLM may propose:

```json
{
  "problemType": "parser_delimiter_semantics",
  "observableBehavior": true,
  "candidateStrategies": ["issue-derived-oracle-repair"],
  "oracleSketch": "exercise CLI/config regex splitting"
}
```

The controller must not trust that proposal. The strategy activates only when a
candidate oracle passes deterministic gates:

```text
base repo executes oracle
oracle reports Issue reproduced on base
oracle does not pass on no-op patch
oracle is deterministic across repeated runs
oracle uses only public issue evidence
```

If no valid oracle exists, the router falls back to the existing agentless flow.

The goal is not to make the LLM always choose the right strategy. The goal is to
let the LLM propose strategy-relevant artifacts while the controller keeps
authority over evidence and transitions.

## Page 4 - Architecture

### Core interfaces

```ts
export interface StrategyRouter {
  select(args: StrategySelectArgs): Promise<StrategyPlan>
}

export interface StrategyPlan {
  readonly strategyId: StrategyId
  readonly activation: "active" | "fallback"
  readonly evidence: readonly StrategyEvidence[]
  readonly reason: string
}

export interface Strategy {
  readonly id: StrategyId
  readonly forbiddenInputs: readonly HiddenInputKind[]
  readonly probes: readonly StrategyProbe[]
  readonly run: (args: StrategyRunArgs) => Promise<StrategyRunResult>
}

export interface ReproOracleCandidate {
  readonly id: string
  readonly script: string
  readonly source: "llm-generated"
  readonly publicEvidenceUsed: readonly PublicEvidenceKind[]
}

export interface ReproOracleValidation {
  readonly candidateId: string
  readonly valid: boolean
  readonly baseOutcome: "reproduced" | "resolved" | "other" | "env_error"
  readonly repeatedOutcomes: readonly string[]
  readonly reason: string
}
```

### Data authority

Public evidence may include:

```text
problem_statement
public issue discussion, if the dataset contract allows it
repo source files
package metadata
documented CLI/API behavior in the repo
```

Forbidden evidence:

```text
gold patch
test_patch
FAIL_TO_PASS
PASS_TO_PASS
official grader report
official hidden test output
```

For leaderboard-clean SWE-bench, the safest initial contract is:

```text
problem_statement + repo source only
```

`hints_text` should be a separate evaluation mode:

```text
public-discussion-enhanced
```

It may be useful, but it must be surfaced in the report because it changes the
measurement contract.

### Runtime flow

```text
load instance
  |
  v
strategy router
  |
  +-- no valid oracle -> existing agentless run
  |
  +-- valid oracle -> oracle-guided run
                         |
                         v
                    candidate patch generation
                         |
                         v
                    oracle verification
                         |
                         +-- fail -> repair with counterexample
                         |
                         +-- pass -> official grader final-only
```

### Controller-owned decisions

The controller, not the LLM, owns:

```text
strategy activation
phase transition
oracle validity
patch validity
official grader call eligibility
retry budget
final failure label
report telemetry
```

The LLM owns only proposal generation:

```text
issue classification proposal
oracle candidate script
patch candidate
repair candidate
failure explanation draft
```

## Page 5 - Applying the strategy to `pylint-8898`

The issue is a parser/tokenizer semantic bug:

```text
input language: comma-separated regex list
domain invariant: comma inside regex quantifier braces is not a list delimiter
failure mode: right file, wrong algorithm
```

The LLM can propose an oracle. The controller validates it by running against
the base repo.

Example oracle behavior:

```text
Issue reproduced:
  current parser splits `(foo{1,}, foo{1,3}})` into a first regex token
  equivalent to `(foo{1`, proving the comma inside `{1,}` was treated as a
  delimiter.

Issue resolved:
  parser preserves `(foo{1,}` as the first regex token and also splits
  `foo, bar{1,3}` into `foo` and `bar{1,3}`.

Other issues:
  import/setup failure, wrong API surface, unrelated exception, nondeterminism.
```

Why this is not a heuristic:

```text
The system does not ban csv or shlex by name.
The system executes an invariant derived from the issue behavior.
csv/shlex patches fail because their behavior is wrong.
brace-aware scanner patches pass because their behavior is right.
```

Expected effect on known wrong patches:

| Candidate patch | Oracle result | Reason |
|---|---:|---|
| `value.split(",")` | fail | splits quantifier comma |
| `csv.reader(...)` | fail | CSV grammar is not regex grammar |
| `shlex.shlex(...)` | fail | shell lexer is not regex grammar |
| brace-aware scanner | pass | delimiter state matches invariant |

This turns `pylint-8898` from "sample until a model happens to pick the right
abstraction" into "generate candidates and deterministically reject candidates
that violate the public behavior contract."

## Page 6 - Rollout plan and risks

### Phase 0 - report-only analysis

Add strategy classification to failure analysis without changing patch-gen:

```text
right_file_wrong_abstraction
oracle_missing
localization_failure
empty_patch
infra_generation_error
```

Output goes to `report.json` and `quanta-bench explain`.

### Phase 1 - oracle generation and validation

Add `repro_oracle.generate` and `repro_oracle.validate_on_base` behind a bench
knob:

```text
QUANTA_BENCH_ORACLE=generate
```

No patch selection changes yet. The output is telemetry:

```text
oracle.generated
oracle.validated
oracle.reproduced_on_base
oracle.deterministic
oracle.rejected_reason
```

### Phase 2 - oracle-gated repair

Use validated oracle results to drive repair:

```text
candidate patch -> oracle fail -> counterexample to repair round
candidate patch -> oracle pass -> final official grader
```

The counterexample must be public-derived and short:

```text
expected first token `(foo{1,}`, got `(foo{1`
```

No official grader output may be fed back.

### Phase 3 - branch search integration

Add an oracle verifier kind to branch search:

```text
defaultVerifierKinds: ["repro"]
```

Then add a versioned preset:

```text
agentless-oracle-v1:
  issue-hint=agentless
  issue-hint-expected-actual=1
  repro-oracle=generate-validate
  branch-search=3
  branch-search-verifier=repro
  repair-rounds=1
  retry-transient=1
```

`retry-transient` should stay low because wrong patches are no longer treated as
transient.

### Risks

Oracle overfitting:

```text
Mitigation: require base reproduce, deterministic repeat, and source-only patch
validation. Track oracle mode in report telemetry.
```

Oracle false negatives:

```text
Mitigation: fallback to existing agentless flow when no oracle validates.
```

Hidden leakage:

```text
Mitigation: type the allowed evidence sources and fail closed if forbidden
fields are requested by the oracle generator or repair loop.
```

Cost blow-up:

```text
Mitigation: cap oracle candidates, cap repair rounds, and run official grader
only after oracle pass when oracle mode is active.
```

LLM nondeterminism:

```text
Mitigation: treat every LLM artifact as a proposal. Only execution gates move
strategy state.
```

### Success criteria

The feature is successful when all of these are true:

```text
1. `pylint-8898` csv/shlex candidates are rejected before official grading.
2. report labels distinguish wrong-patch semantic failure from harness errors.
3. no hidden SWE-bench fields are visible to agent/repair prompts.
4. no-oracle instances fall back to current `agentless-v1` behavior.
5. branch-search can score candidates by public-derived repro outcome.
```

The core architectural claim:

```text
Strategy selection may be LLM-assisted, but strategy activation must be
evidence-gated.
```

