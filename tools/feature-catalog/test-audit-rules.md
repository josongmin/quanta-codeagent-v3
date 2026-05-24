# Test admissibility rules

`bun fc test-audit` audits every `tests/**/*.test.{ts,js}` file against the 12
admissibility rules below. Seven rules (R1, R2, R3, R5, R8, R9, R10) have
objective static signals and are **enforced** by the tool. The remaining five
(R4, R6, R7, R11, R12) require semantic judgement and are **advisory only** —
listed here so reviewers know the bar and so the tool's silence on them isn't
misread as a pass.

The hard constraint behind the tool is **NO HEURISTICS**: every enforced rule
is grounded in an objective regex / structural signal. Escape hatches must be
explicit (e.g. `// source-grep allowed` comment, `tests/_arch/` path), never a
fuzzy name match.

## Enforcement matrix

| Rule | Status      | Signal |
| ---- | ----------- | ------ |
| R1   | enforced    | duplicate stem `foo.test.ts` + `foo.test.js` under `tests/` |
| R2   | enforced    | any `*.test.js` under `tests/` |
| R3   | enforced    | no `from "@/..."` and no `from "../../src/..."` import |
| R4   | semantic    | (human review — observable behavior vs internals) |
| R5   | enforced    | reads `src/**` via `readFileSync` / `import.meta.glob` outside `tests/architecture/_arch/` without `// source-grep allowed` opt-in |
| R6   | semantic    | (human review — title matches assertions) |
| R7   | semantic    | (human review — idempotency = exact count assertions) |
| R8   | enforced    | test title contains `cleanup\|teardown\|afterEach\|finalize\|dispose` but body lacks any of: `*Cleanup.toHaveBeenCalled`, `.toHaveBeenCalledTimes(N)`, `disposed.toBe(true)`, `closed.toBe(true)`, `aborted.toBe(true)` |
| R9   | enforced    | test title contains `cancel\|abort\|interrupt` but body lacks any of: `.aborted.toBe(true)`, `rejects.toThrow`, `AbortError`, `addEventListener("abort")`, `expect(...abort...).toHaveBeenCalled` |
| R10  | enforced    | test title contains `env\|environment\|isolation\|isolated` but body lacks any of: `mockEnv()`, `process.env.X = undefined`, `Object.defineProperty(process.env...)`, `toThrow` over env access |
| R11  | semantic    | (human review — mutation-testing intuition) |
| R12  | semantic    | (human review — refactor robustness) |

## The 12 rules — verbatim spec

1. **Runs exactly once in intended suite.** A test that runs twice (e.g. via
   parallel discovery of both `.test.ts` and an emitted `.test.js`) means
   double the false-positive and false-negative surface.
2. **Authored as `.test.ts` (not emitted `.test.js`).** Authored TypeScript
   only under `tests/`; build artifacts live in `dist/`.
3. **Calls actual unit under test.** A test that only exercises fixtures or
   pure stdlib is, by definition, not testing real code.
4. **Asserts observable behavior or explicit public contract.** Tests that
   reach into private state lock the implementation and rot under refactor.
5. **Does not grep source code unless testing source-transform/lint rule.**
   Reading source is allowed for AST-level checks (architecture tests, lint
   rules) but otherwise indicates the test is asserting on text rather than
   behavior.
6. **Title does not claim more than assertions prove.** A test titled "rejects
   malformed input" must actually assert rejection, not merely accept-on-good.
7. **Idempotency tests assert exact side-effect counts.** "Runs once" demands
   `toHaveBeenCalledTimes(1)`, not just `toHaveBeenCalled`.
8. **Cleanup tests assert actual cleanup/finalization hooks.** A test titled
   "cleans up on exit" without `expect(cleanup).toHaveBeenCalled` is vacuous.
9. **Cancellation tests assert upstream cancellation/return/abort behavior.**
   Cancel-titled tests must show the cancellation propagated — `.aborted`,
   `rejects.toThrow(AbortError)`, or an abort listener invocation.
10. **Environment isolation tests fail on forbidden env access.** A test that
    only compares stdout doesn't prove the env was actually sealed; it must
    set the env to `undefined` (or use a throwing proxy) and verify access
    fails.
11. **Would fail against at least one realistic broken implementation.** If a
    test passes when the unit-under-test is replaced with `return null`, it's
    not testing anything.
12. **Would survive a behavior-preserving refactor.** A test that breaks on
    every rename or inline-extract is asserting on form, not function.

## Escape hatches

- **R5 source-grep opt-in.** Add the comment `// source-grep allowed` near
  the top of any test that genuinely needs to read source files (e.g. a lint
  rule under test). Architecture tests under `tests/architecture/` or
  `tests/unit/_arch/` are auto-exempt.
- **R3 import-of-src exemption.** Tests under `tests/unit/_arch/`,
  `tests/architecture/`, `tests/**/_harness/`, or `tests/unit/_parity/` are
  auto-exempt — they audit filesystem layout, not behavior.

## Usage

```sh
bun fc test-audit                       # advisory — exit 0 regardless
bun fc test-audit --strict              # exit 1 on any enforced violation
bun fc test-audit --max-per-rule 25     # widen per-rule violation listing
```

## Maintenance

When adding a new rule (or strengthening an existing one), follow the same
"objective signal first" discipline:

- Define the signal as a regex or structural check on the test text.
- Add it as a `checkRN…` function in `test-audit.ts` returning
  `Violation[]`.
- Register it in `runAllRules` and update the table above.
- If the rule needs an escape hatch, make it an **explicit** opt-in comment
  or a **fixed** path prefix — never a fuzzy match.
