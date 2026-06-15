# RFC-0538 - Executable Evidence Ledger for Evidence-Aware ReAct

- **Status**: Proposed (2026-06-15)
- **Supersedes**: discarded RFC `0537-agentless-oracle-strategy-router.md`
- **Related**: [[0014-bench-repair-rounds]], [[0117-branch-search-minimal-change-bias]], [[0503-knob-governance-and-capability-layer]], [[0533-evidence-packet-builder]], [[0536-bench-remote-and-unified-cli]]
- **Scope**: `src/apps/bench`, `src/runner/batch/eval`, observation artifacts, repair loops, branch-search verifiers
- **Non-goals**: `StrategyRouter`, issue taxonomy router, gold patch leakage, hidden test leakage, prompt-only "think harder" fixes, per-instance hardcoded heuristics

## Page 1 - Problem

`pylint-dev__pylint-8898` exposed a real bench failure class:

```text
right file, wrong abstraction
```

The agent localized to the correct ownership area:

```text
pylint/config/argument.py
```

but selected the wrong semantic model:

```text
csv/shlex/general comma splitting
```

The required behavior was not "split CSV". It was:

```text
split delimiter commas outside regex quantifier braces;
do not split commas inside `{...}` quantifiers.
```

The official SWE-bench grader can detect this, but it is too late to use as
repair feedback because hidden grader output must not be fed back to the agent.
The current bench loop is therefore structurally under-instrumented:

```text
problem_statement -> agent patch -> official grader
```

The missing capability is not a new preset, a stronger issue taxonomy, or a
controller-owned workflow strategy. Those approaches turn into a fixed decision
tree:

```text
classify issue -> select strategy -> execute strategy
```

That is the wrong control center for hard software bugs. Real issues often shift
between invariants, ownership, call graph, API contracts, migration safety,
typing, or runtime behavior as evidence is gathered. A predeclared
`StrategyRouter` will eventually become a pile of special cases.

The reusable capability is:

```text
first-class, public, executable evidence
```

The agent should be able to propose observations, invariants, reproducers,
verifiers, and counterexamples during a normal ReAct loop. The runtime should
validate those artifacts and record their status. Workflows should emerge from
validated evidence, not from a hardcoded issue taxonomy.

## Page 2 - Decision

Add an **Executable Evidence Ledger** to bench runs and make it available to the
agent loop as an evidence-aware observation store.

The base loop stays ReAct:

```text
Thought -> Action -> Observation -> Reflection
```

The change is that observations can become typed, executable artifacts:

```text
Evidence
Verifier
Counterexample
Invariant
```

The LLM may propose these artifacts. The controller does not trust them. The
controller only validates state transitions by execution.

Correct authority split:

```text
LLM:
  proposes claims, invariants, verifier scripts, repair hypotheses, patches

runtime:
  executes commands, validates base behavior, runs candidate verifiers,
  records counterexamples, enforces public-evidence policy

controller:
  owns ledger state transitions, retry labels, report telemetry,
  official grader final-only boundary
```

Incorrect authority split:

```text
controller:
  infers problem taxonomy and selects a named strategy state machine
```

The deterministic part must be the evidence lifecycle, not issue-intent
classification.

```text
proposed -> validated -> registered -> used -> retired
```

No component needs to know that a task is a "parser bug" or "migration bug" to
benefit. It only needs to know that a verifier was public-derived, reproduces on
base, is deterministic, and distinguishes candidate behavior.

## Page 3 - Core Model

The ledger stores evidence as first-class run artifacts. The initial model is
small and intentionally generic.

```ts
export type EvidenceKind =
  | "observation"
  | "hypothesis"
  | "invariant"
  | "reproducer"
  | "verifier"
  | "counterexample";

export type EvidenceStatus =
  | "proposed"
  | "validated"
  | "rejected"
  | "registered"
  | "used"
  | "retired";

export type EvidenceProvenance =
  | "problem_statement"
  | "repo_source"
  | "repo_metadata"
  | "agent_reasoning"
  | "tool_output"
  | "command_output"
  | "public_issue_discussion";

export interface Evidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly status: EvidenceStatus;
  readonly claim: string;
  readonly provenance: readonly EvidenceProvenance[];
  readonly artifacts: readonly EvidenceArtifactRef[];
  readonly createdAt: string;
  readonly rejectedReason?: string;
}

export interface ExecutableVerifier {
  readonly id: string;
  readonly evidenceId: string;
  readonly claim: string;
  readonly command: readonly string[];
  readonly cwdPolicy: "repo-root" | "worktree-root";
  readonly expectedBase: "fail" | "pass" | "unknown";
  readonly expectedCandidate: "pass" | "fail";
  readonly timeoutMs: number;
  readonly provenance: readonly EvidenceProvenance[];
}

export interface VerifierRun {
  readonly verifierId: string;
  readonly phase: "base" | "candidate" | "repair";
  readonly outcome: "passed" | "failed" | "env_error" | "nondeterministic";
  readonly exitCode: number | null;
  readonly stdoutRef?: EvidenceArtifactRef;
  readonly stderrRef?: EvidenceArtifactRef;
  readonly normalizedObservation: string;
}

export interface Counterexample {
  readonly id: string;
  readonly verifierId: string;
  readonly expected: string;
  readonly observed: string;
  readonly artifacts: readonly EvidenceArtifactRef[];
}
```

The minimum runtime port:

```ts
export interface EvidenceLedgerPort {
  propose(evidence: ProposedEvidence): Promise<Evidence>;
  validate(evidenceId: string): Promise<Evidence>;
  registerVerifier(verifier: ExecutableVerifier): Promise<Evidence>;
  runVerifier(verifierId: string, phase: VerifierRun["phase"]): Promise<VerifierRun>;
  recordCounterexample(input: CounterexampleInput): Promise<Counterexample>;
  listUsableVerifiers(args: VerifierQuery): Promise<readonly ExecutableVerifier[]>;
}
```

This is not a normal "tool" in the primitive sense. It is an observation and
artifact authority. The agent can ask to create evidence; the runtime decides
whether the evidence becomes usable.

## Page 4 - Runtime Semantics

Evidence-aware ReAct works without a strategy router:

```text
load instance
  |
  v
agent investigates with ordinary tools
  |
  v
agent proposes evidence or verifier
  |
  v
runtime validates public provenance and base behavior
  |
  +-- invalid -> record rejected evidence; continue normal ReAct
  |
  +-- valid -> register verifier in ledger
                 |
                 v
            candidate patch generation
                 |
                 v
            run registered verifier
                 |
                 +-- fail -> record counterexample; feed public counterexample
                 |          back into repair context
                 |
                 +-- pass -> candidate remains eligible for final official grade
```

Activation is emergent:

```text
there is at least one registered verifier relevant to the candidate patch
```

There is no issue classifier gate.

There is no taxonomy-to-strategy mapping.

There is no fallback strategy selection step.

Fallback is simple: if no verifier validates, the agent continues the existing
flow. The report must say that no executable evidence was available; it must not
pretend an evidence-guided run happened.

The official SWE-bench grader remains final-only:

```text
candidate patch -> public verifier(s) -> official grader
```

Official grader output, hidden tests, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`,
and gold patches are forbidden as agent or repair inputs.

## Page 5 - Applying the Model to `pylint-8898`

The agent does not need to classify the issue as a parser bug. It only needs to
notice that the problem statement implies an executable behavior contract.

Possible invariant:

```text
For comma-separated regex config values, commas inside `{...}` quantifier braces
are part of the regex token, not list delimiters.
```

Possible verifier claim:

```text
`--bad-names-rgx=foo, bar{1,3}` should compile two regex patterns:
`foo` and `bar{1,3}`.
```

Possible counterexample from a wrong patch:

```text
expected first invalid regex token `(foo{1,}`;
observed `(foo{1`, proving the comma inside `{1,}` was split as a delimiter.
```

This rejects the bad abstractions structurally:

| Candidate abstraction | Ledger outcome | Reason |
|---|---:|---|
| `value.split(",")` | verifier fail | delimiter state is absent |
| `csv.reader(...)` | verifier fail | CSV grammar is not regex grammar |
| `shlex.shlex(...)` | verifier fail | shell grammar is not regex grammar |
| brace-aware scanner | verifier pass | delimiter state matches invariant |

This is not a heuristic because the system does not ban `csv` or `shlex` by
name. It runs an executable public behavior contract. Any implementation that
preserves the contract can pass.

The same mechanism generalizes:

```text
ownership invariant -> verifier over call path or exported API
typing invariant    -> verifier over typecheck error or public type surface
migration invariant -> verifier over old+new schema behavior
concurrency invariant -> verifier over deterministic stress/replay artifact
parser invariant    -> verifier over accepted/rejected input language cases
```

These are not predeclared strategies. They are evidence shapes the agent may
propose when the observed problem calls for them.

## Page 6 - Rollout, Guardrails, and Success Criteria

### Phase 0 - report-only ledger

Record evidence proposals and rejections without changing patch selection.

Report fields:

```text
evidence.proposed
evidence.validated
evidence.rejected
verifier.proposed
verifier.base_validated
verifier.rejected_reason
counterexample.recorded
```

### Phase 1 - executable verifier validation

Add verifier execution behind a bench knob:

```text
QUANTA_BENCH_EVIDENCE_LEDGER=report
```

Validation gates:

```text
1. provenance contains only allowed public sources
2. command runs in the base worktree
3. expected base outcome is observed
4. repeated runs are deterministic
5. output is normalized into a short observation
```

### Phase 2 - evidence-guided repair

Enable candidate repair from public counterexamples:

```text
candidate patch -> registered verifier fail -> counterexample -> repair context
candidate patch -> registered verifier pass -> official grader eligible
```

Knob:

```text
QUANTA_BENCH_EVIDENCE_LEDGER=repair
```

Preset:

```text
evidence-aware-v1:
  issue-hint=agentless
  evidence-ledger=repair
  verifier-candidates=2
  repair-rounds=1
  retry-transient=1
```

The preset enables a capability. It does not select a problem-type strategy.

### Phase 3 - branch search scoring

Branch search may use registered verifiers as one scoring signal:

```text
branch candidate -> registered verifier set -> score public behavior pass/fail
```

This should be additive to existing branch-search scoring. It must not introduce
problem taxonomy routing.

### Guardrails

Hidden leakage:

```text
Fail closed if a verifier, repair prompt, or counterexample references gold
patches, test_patch, FAIL_TO_PASS, PASS_TO_PASS, official grader reports, or
hidden grader output.
```

Overfitting:

```text
Require base validation, deterministic repeat, and report-visible provenance.
Prefer behavior claims over implementation-shape claims.
```

Cost blow-up:

```text
Cap verifier candidates, verifier runtime, repair rounds, and official grader
calls. Retry remains for transient infrastructure only.
```

LLM nondeterminism:

```text
Treat every LLM-created artifact as a proposal. Only runtime execution can move
ledger state.
```

Hardcoding drift:

```text
Do not add `PARSER_STRATEGY`, `MIGRATION_STRATEGY`, `ORACLE_STRATEGY`, or
issue-type routing tables. Add new evidence kinds only when the artifact shape
cannot be represented by the existing generic ledger model.
```

### Success criteria

The design is successful when all are true:

```text
1. `pylint-8898` csv/shlex candidates are rejected by public verifier evidence
   before official grading.
2. `pylint-8898` can be repaired using only public counterexamples.
3. report.json records evidence provenance, verifier validation, and
   counterexamples.
4. no hidden SWE-bench fields are visible to agent or repair prompts.
5. instances without validated evidence keep current agentless behavior.
6. no issue taxonomy router is required to activate the mechanism.
```

Architectural claim:

```text
Problem-solving approaches may emerge during ReAct.
Only executable evidence state transitions are deterministic.
```
