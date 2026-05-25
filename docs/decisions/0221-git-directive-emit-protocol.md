# ADR-0221: Git `::git-*` 5-directive emit protocol — phase-guarded behavioral layer

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related ADRs**: ADR-0025 (git first-class tools — read-only surface this
  protocol sits adjacent to), ADR-0102 (turn-diff emitter — sibling
  observability seam), ADR-0111 (git CTK skill bundle — mutating-git call
  sites where a host wires `emit(...)`), ADR-0125 (turn-diff wiring), and
  most importantly ADR-0220 (`src/agent/git-directives/` — the wire/serdes
  layer this slice complements with a phase-guarded behavioral layer).
- **References**: `src/git/directive-emit/**`,
  `tests/unit/git-directive-emit-hellgate.test.ts`
- **ADR-number drift note**: the task brief requested 0222, but
  `0221-*.md` was the next-free slot at write time (0220 is sibling
  `git-directives` wire layer). Per the project's user-deference
  renumber policy (memory: `adr-collision-policy-2026-05-25`), we use the
  next-free slot.

## Research grounding

Per Codex's `::git-*` emission discipline (final_answer phase only):

```
::git-create-branch <name>     — emitted ONLY on successful branch creation
::git-stage <files>            — emitted ONLY after `git add` succeeds
::git-commit <sha>             — emitted ONLY after `git commit` succeeds
::git-push <ref>               — emitted ONLY after `git push` succeeds
::git-create-pr {isDraft, url} — emitted ONLY after `gh pr create` succeeds
```

The Codex invariant is two-fold: (1) the mutation MUST have succeeded, and
(2) emission MUST happen in the `final_answer` phase — never in commentary
(side-channel stream) or intermediate (in-loop tool interleave). Emitting in
commentary/intermediate is a HARD bug because:

- a tailing UI would re-sync to a branch/PR that the loop may still roll back;
- protocol noise would leak into the model's scratchpad;
- pipe consumers would see directive lines ahead of the user-visible reply.

ADR-0220 lands the **wire/serdes layer** at `src/agent/git-directives/` —
the 5-kind directive union, canonical alpha-sorted JSON, parser, stderr
emitter. What ADR-0220 does NOT model is the **phase invariant**: its
`emit(directive)` accepts a directive in any phase. A caller has to remember
to check the phase themselves before calling.

ADR-0221 closes that loophole. The phase guard moves into the port: callers
MUST pass an `EmitContext { phase }`, and `commentary` / `intermediate`
emit attempts are rejected with a typed `wrong-phase` error before the sink
is touched. This matches the Codex behavioral protocol exactly.

## Context

Three forces:

1. **Behavioral protocol, not just wire format**. ADR-0220 owns "what bytes
   go on the wire". ADR-0221 owns "when may bytes go on the wire". These
   are independent concerns — a host can adopt the wire layer without the
   behavioral guard (e.g. a test fixture), but production call sites SHOULD
   route through the phase-guarded emitter.

2. **No-throw public surface**. The codebase boundary policy forbids thrown
   errors crossing public surfaces (see `memory: no-heuristics-only-validated`
   for the broader strict-discipline pattern). `emit` returns
   `Result<void, EmitError>` with two typed kinds: `wrong-phase` and
   `invalid-directive`. Callers handle both branches explicitly.

3. **Default-OFF byte-identical**. Existing call sites do not import this
   slice. `noopEmitter` is the default — `emit()` returns `ok(undefined)`
   and never touches any sink. A host opts in by injecting `defaultEmitter`
   (defaults to `process.stdout`).

## Decision

A new leaf-level slice at `src/git/directive-emit/`:

| File | Purpose |
|---|---|
| `types.ts` | 5-kind discriminated `GitDirective`, `EmitPhase`, `EmitError`, `GIT_DIRECTIVE_KINDS` |
| `port.ts` | `DirectiveEmitterPort.emit(d, ctx): Result<void, EmitError>` |
| `phase-guard.ts` | `checkPhase(phase)` — HARD reject commentary + intermediate |
| `validate.ts` | `validateDirective(d)` — minimal structural sanity (non-empty strings, boolean types) |
| `serializer.ts` | `serialize(d): string` — canonical alpha-sorted JSON |
| `parser.ts` | `parse(line): GitDirective \| null` — never throws |
| `emitter.ts` | `noopEmitter` (default-OFF) + `defaultEmitter(sink?)` (production) |
| `index.ts` | barrel re-export |

### Directive shape (distinct from ADR-0220's wire shape)

```ts
type GitDirective =
  | { readonly kind: "create-branch"; readonly name: string }
  | { readonly kind: "stage"; readonly files: readonly string[] }
  | { readonly kind: "commit"; readonly sha: string; readonly message: string }
  | { readonly kind: "push"; readonly ref: string; readonly force: boolean }
  | { readonly kind: "create-pr"; readonly url: string; readonly isDraft: boolean }
```

Differences from ADR-0220's shape:

| Kind | ADR-0220 (wire/serdes) | ADR-0221 (phase-guarded behavior) |
|---|---|---|
| `stage` | `paths: readonly string[]` | `files: readonly string[]` |
| `push` | `remote: string; branch: string` | `ref: string; force: boolean` |

These reflect different consumer needs: ADR-0220's `paths` matches the UI
"file list" rendering; ADR-0221's `files` matches the tool-side `git add`
arg vector. ADR-0220's `remote/branch` matches the UI "destination" label;
ADR-0221's `ref/force` matches the tool-side `git push <ref> [--force]`
invocation. Both shapes are correct for their consumer; they are NOT
interchangeable.

### Emit contract

```ts
interface EmitContext { readonly phase: EmitPhase }
type EmitPhase = "final-answer" | "commentary" | "intermediate"

interface DirectiveEmitterPort {
  emit(d: GitDirective, ctx: EmitContext): Result<void, EmitError>
}
```

`defaultEmitter(sink?)`:
1. `checkPhase(ctx.phase)` — wrong-phase → `err({ kind: "wrong-phase", phase })`.
2. `validateDirective(d)` — invalid shape → `err({ kind: "invalid-directive", reason })`.
3. `sink.write(serialize(d) + "\n")` — wraps any throw in a typed error.

The phase guard runs FIRST so a wrong-phase + invalid directive surfaces
the phase error (HELL-DE-15).

### Default-OFF wire

- `noopEmitter.emit()` always returns `ok(undefined)`, never touches any
  sink. Verified by HELL-DE-01 and HELL-DE-18.
- The barrel is exported but not referenced from `src/git/index.ts` or
  `src/apps/cli/index.ts`. Call-site wiring (one `emit(...)` per success
  path inside `git_commit` / `git_branch_switch` / `gh pr create` tools) is
  intentionally deferred to a follow-up slice — landing the port first
  keeps this slice purely additive.

## Hellgate (18 cases)

`tests/unit/git-directive-emit-hellgate.test.ts` pins:

- **HELL-DE-01** — `noopEmitter.emit` returns `ok` for every kind × phase combo.
- **HELL-DE-02** — `commentary` phase rejected with typed `wrong-phase`, sink untouched.
- **HELL-DE-03** — `intermediate` phase rejected with typed `wrong-phase`, sink untouched.
- **HELL-DE-04** — each of the 5 kinds emits exactly one line in `final-answer`.
- **HELL-DE-05** — `serialize → parse` round-trip for all 5 kinds.
- **HELL-DE-06** — canonical alpha-sorted JSON keys (snapshot per kind).
- **HELL-DE-07** — `parse` returns `null` for non-prefix lines (no throw).
- **HELL-DE-08** — `parse` returns `null` for malformed JSON body.
- **HELL-DE-09** — `parse` returns `null` for unknown kind.
- **HELL-DE-10** — multi-emit preserves FIFO order at the sink.
- **HELL-DE-11** — `create-pr.isDraft` true/false both round-trip; non-boolean rejected.
- **HELL-DE-12** — `commit.sha` empty rejected; non-empty accepted (no further format check).
- **HELL-DE-13** — `create-branch.name` empty rejected; emitter returns typed error and never writes.
- **HELL-DE-14** — commit message with embedded `\n` survives line framing (JSON escape).
- **HELL-DE-15** — phase guard runs BEFORE shape validation (wrong-phase + bad shape → `wrong-phase`).
- **HELL-DE-16** — `push.force` true/false both round-trip; non-boolean rejected.
- **HELL-DE-17** — parsed `stage.files` is frozen (mutation throws).
- **HELL-DE-18** — OFF parity: `noopEmitter` is sink-free by construction; cannot leak.

## Default-OFF byte-identical

- Zero call sites import `@/git/directive-emit` at this slice. The barrel
  is exported but not referenced from `src/git/index.ts` or `src/apps/`.
- `noopEmitter` is sink-free — even instantiated and called 100 times in
  any phase, it produces zero side effects (HELL-DE-01, HELL-DE-18).

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Reuse ADR-0220's `emit(d)` and add phase parameter there** | Mutates the user-authored slice's public surface; collision policy says we add a sibling, not edit user code. The two slices are complementary: 0220 = wire, 0221 = behavior. |
| **Pass phase implicitly via AsyncLocalStorage** | Hidden control flow; tests + caller-side reasoning suffer. Explicit `EmitContext` makes the phase obligation visible at every call site (lint catches missing arg). |
| **Throw on wrong-phase instead of typed Result** | Violates the no-throw boundary policy. A misbehaving caller emitting in commentary would crash the agent loop instead of being logged + dropped. |
| **Make `commentary` also valid (only block `intermediate`)** | Codex protocol is `final_answer` only. Allowing commentary leaks directives ahead of the confirmed final reply — exactly the bug the protocol exists to prevent. |
| **Single shared `GitDirective` shape with ADR-0220** | Forces one of the two slices to use the wrong shape for its consumer. The two consumers have legitimately different views (UI: paths/remote+branch; tool: files/ref+force). |
| **Default sink = stderr (match ADR-0220)** | The codex behavioral protocol streams `::git-*` lines in the same channel as the user-visible final answer (UI greps `^::git-` from stdout). Hosts that want stderr framing pass `process.stderr` explicitly. |

## Consequences

- **Default-OFF byte-identical**: zero existing call sites change. The
  slice is purely additive — `noopEmitter` is the default and is sink-free.
- **Phase invariant enforced**: `commentary` and `intermediate` emits are
  HARD-rejected with a typed error before any sink write. Verified by
  HELL-DE-02, HELL-DE-03, HELL-DE-15.
- **No-throw surface**: `emit` returns `Result<void, EmitError>`; `parse`
  returns `GitDirective | null`. No public function throws.
- **Slice isolation**: `src/git/directive-emit/` imports only `@/shared`
  (`Result`, `ok`, `err`). It does NOT touch `@/tool`, `@/llm`, `@/mcp`,
  `@/permission`, `@/agent`. Future caller-side wiring (1 line per success
  path in `src/tool/git/commit.ts`, `src/tool/git/branch-switch.ts`, future
  `gh-pr-create.ts`) lives in the tool slices, not here.
- **Sibling, not replacement, of ADR-0220**: hosts can choose either layer.
  The two are independently testable (different hellgates) and independently
  wireable (different ports). A follow-up slice MAY unify the two by
  introducing a shape-translator at the call site, but that is out of scope
  for this slice.
- **Follow-up**: wire `git_commit` / `git_branch_switch` / (future)
  `git_create_pr` tool handlers to `emit(...)` on success with `phase:
  "final-answer"` passed by the agent-loop boundary. That wire is one line
  per success path; the port lands first so the wire stays trivial.
