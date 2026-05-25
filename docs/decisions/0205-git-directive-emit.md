# ADR-0205: Git directive emit protocol (`::git-*`)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0025 (git first-class tools — read-only surface this
  slice extends with a sibling out-of-band signaling channel), ADR-0102
  (turn-diff emitter — adjacent git observability seam), ADR-0110 (git
  observability wiring — composite + opt-in pattern this slice mirrors)
- **References**: `src/agent/git-directives/**`,
  `tests/unit/agent/git-directives-hellgate.test.ts`

## Research grounding

Per `docs/analysis/경쟁사리뷰/`: Codex emits compact one-line `::git-*`
directives on a stderr-side channel after successful mutating git operations
(`::git-create-branch`, `::git-stage`, `::git-commit`, `::git-push`,
`::git-create-pr`). A UI process (TUI/desktop) tails the channel and re-syncs
the branch/PR view without re-shelling `git status`/`gh pr view`. The
directive is emitted ONLY on a confirmed successful mutation — commentary,
intermediate plan steps, and dry-runs never emit.

quanta has the underlying git tools (`src/tool/git/{commit,branch-switch,
upstream}.ts` + 12 more) but no out-of-band UI sync channel. Adding the
directives in-band (LLM response) would pollute the assistant text; piggy-
backing on the agent event stream would entangle the protocol with the
existing event-typing track. The conservative move is a dedicated emit port
behind a default-OFF wire: today the port is no-op; tomorrow a CLI / TUI host
plugs in a stderr-line emitter.

## Context

Three constraints shape the slice:

1. **Default-OFF byte-identical**: existing `git_commit`/`git_branch_switch`
   tool signatures must not change. The current `bash`-resident mutating git
   posture (ADR-0025 §대안) cannot regress. Callers that do not opt in must
   observe zero behaviour delta.
2. **Stderr-only**: stdout is reserved for LLM response streaming in
   headless mode. Any out-of-band signal MUST go to stderr to avoid
   contaminating the model's reply or downstream pipe consumers.
3. **Closed-port DI**: the emitter is injected so tests drive every
   serialization/parse case without touching the file descriptor. The
   built-in `defaultStdoutEmitter` writes to `process.stderr` (the name
   reflects "process-stdout-channel emitter" historically; the actual stream
   is stderr — see HELL-GD-11).

## Decision

Add a leaf-level slice at `src/agent/git-directives/`:

| File | Purpose |
|---|---|
| `port.ts` | `GitDirectiveEmitter { emit(d: GitDirective): void }` |
| `types.ts` | 5-kind discriminated `GitDirective` union |
| `serializer.ts` | `serialize(d): string` — canonical one-line JSON |
| `parser.ts` | `parse(line): Result<GitDirective, ParseError>` |
| `default-stdout-emitter.ts` | `process.stderr.write` adapter |
| `no-op-emitter.ts` | default; emit = no-op |
| `index.ts` | barrel re-export |

### Directive shape

```ts
type GitDirective =
  | { kind: "create-branch"; name: string }
  | { kind: "stage"; paths: readonly string[] }
  | { kind: "commit"; sha: string; message: string }
  | { kind: "push"; remote: string; branch: string }
  | { kind: "create-pr"; url: string; isDraft: boolean }
```

### Wire format

One line per directive:

```
::git-<kind>{<canonical-json>}
```

- Line MUST start with `::git-` (parser anchor — anything else is rejected
  with no throw, returns `null`).
- `<kind>` is the discriminant value as written above (kebab-case).
- `<canonical-json>` is `JSON.stringify` of the directive payload (every
  field EXCEPT `kind`) with keys in alphabetical order — locked by
  HELL-GD-07 so the parser, snapshot tests, and UI regex all agree.
- String escape uses `JSON.stringify` (handles `"`, `\`, `\n`, control
  chars). HELL-GD-14 pins that a commit message with a newline does not
  break line framing.

### Parse error shape

```ts
type ParseError =
  | { kind: "not-a-directive" }       // prefix mismatch
  | { kind: "malformed-directive" }   // JSON parse error
  | { kind: "unknown-kind"; kind: string }
  | { kind: "shape-mismatch"; reason: string }
```

`parse` returns `Result<GitDirective, ParseError>` (the shared
`Result<T,E>`). It NEVER throws — UI tail loops should keep running across
corrupt frames.

### Default-OFF wire

- Existing call sites do not import this slice. The barrel is unreferenced
  by `src/agent/index.ts` for now — a follow-up slice wires `git_commit` →
  `emit({kind:"commit", ...})` once the cherry-pick lands.
- `defaultStdoutEmitter` and `noopEmitter` are both exported so a host can
  choose; default selection is the caller's responsibility (matches the
  voice-input registry pattern from ADR-0202).

## Hellgate (15 cases)

`tests/unit/agent/git-directives-hellgate.test.ts` pins:

- **HELL-GD-01** — no-op emitter is silent for all 5 kinds (byte-identical
  default).
- **HELL-GD-02..06** — each kind round-trips serialize → parse to a
  structurally equal value (5 cases, one per kind).
- **HELL-GD-07** — JSON keys are alphabetically sorted (snapshot of all
  5 kinds).
- **HELL-GD-08** — `parse("hello world")` returns `Err("not-a-directive")`,
  no throw.
- **HELL-GD-09** — `parse("::git-commit{not json}")` returns
  `Err("malformed-directive")`, no throw.
- **HELL-GD-10** — `parse("::git-unknown{}")` returns `Err("unknown-kind")`.
- **HELL-GD-11** — `defaultStdoutEmitter` writes to `process.stderr` (NOT
  stdout) — verified by replacing both streams' `.write`.
- **HELL-GD-12** — `parse("::git-create-pr{\"isDraft\":\"yes\",...}")`
  returns `Err("shape-mismatch")` (isDraft must be boolean).
- **HELL-GD-13** — `stage` paths array is frozen on parse (mutation
  rejected).
- **HELL-GD-14** — commit message with `\n` survives serialize → parse
  unchanged (newline escaped to `\\n` in wire form).
- **HELL-GD-15** — emitter receives directives in FIFO order across 5
  rapid calls.

## Default-OFF byte-identical

- No caller wires this in the current commit. The barrel is exported but
  not referenced from `src/agent/index.ts` / `src/apps/cli/index.ts`.
- Verified by HELL-GD-01 — instantiating the no-op emitter and calling
  `emit` 5 times produces zero stderr/stdout writes.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Emit on the existing AgentEvent stream** | Couples the directive protocol to the event-typing track which is mid-flight on another slice; risks racing event-shape changes. A standalone port stays isolated. |
| **Emit in-band in the LLM response text** | Pollutes the assistant reply; in pipe mode the directive lines would leak to user-visible output and confuse downstream tooling that consumes stdout. |
| **Mutate existing git tool signatures to emit** | Breaks the ADR-0025 invariant that mutating git stays in `bash` with HARD_DENY/HITL gates; also forces a tool-surface change on every git tool. Wire is one line at the caller, not a tool signature change. |
| **Single `::git{kind:...}` envelope** | Loses the kebab-case kind discriminator in the prefix (UI grep / log-tailing harder); a per-kind prefix lets a `tail -F | grep ::git-commit` pipeline work without JSON parsing. |
| **Non-canonical JSON (insertion order)** | Snapshot tests and UI regex break across V8 version bumps. Canonical alpha-sorted keys are 3 LOC and 100% stable. |

## Consequences

- **Default-OFF byte-identical**: existing git tools, agent loop, CLI all
  unchanged. Verified by HELL-GD-01.
- **Closed-port**: every emitter and parser path is injected — tests use
  fakes; production wires the stderr emitter at the bootstrap layer.
- **Stderr discipline**: HELL-GD-11 locks the channel choice — a regression
  to stdout breaks pipe consumers and is caught at unit-test time.
- **Slice isolation**: `src/agent/git-directives/` imports only `@/shared`
  (`Result`, `ok`, `err`). It does NOT touch `@/tool`, `@/llm`, `@/mcp`,
  `@/permission`. Future caller-side wiring lives in the tool slices, not
  here.
- **Follow-up**: wire `git_commit`/`git_branch_switch`/(future)
  `git_create_pr` to `emit(...)` on success. That cherry-pick is intentionally
  out of scope for this slice — the port lands first so the wire is a one-
  liner per call site.
