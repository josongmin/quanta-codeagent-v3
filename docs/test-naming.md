# Test naming convention

How to read a test filename in `tests/`. Keeping these suffixes disciplined makes the audit trail in [docs/analysis/code-agent-loop/quanta-comparison.md](analysis/code-agent-loop/quanta-comparison.md) machine-greppable — every "quanta wins X" claim is the name of one or more `*-hellgate` files.

## Suffix taxonomy

| suffix | location | scope | what it proves | example |
|---|---|---|---|---|
| `*-hellgate.test.ts` | `tests/unit/` | one **contract clause** of one slice — pure, fast, deterministic | a specific deny-steer / closeout / admissibility branch fires the right typed signal | `tests/unit/admissibility-hellgate.test.ts` |
| `*-hell-e2e.test.ts` | `tests/integration/` | a contract clause **across the assembled loop** — hits `runAgent` end-to-end with replay/stub LLM | the slice's claim still holds when wired through dispatch, recovery, capture, hooks | `tests/integration/hard-deny-mid-multitool-hell-e2e.test.ts` |
| `*-e2e.test.ts` | `tests/integration/` | broad scenario, **not** tied to a single contract clause | a user-visible scenario works (e.g. plan mode, cursor gap surface) | `tests/integration/agent-memory-e2e.test.ts` |
| `*.test.ts` (no suffix) | `tests/unit/` or `tests/integration/` | ordinary unit / integration coverage | function-level correctness, regression pins | `tests/unit/hooks.test.ts` |
| `tests/contract/` | (whole directory) | real Docker / real LSP / real network — environment-gated | the **substrate** behaves as quanta assumes | gated by `REQUIRE_CONTRACT` |
| `tests/smoke/` | (whole directory) | recorded loop+tool+LLM replay batteries | regression of the assembled product, tier-0 deterministic + tier-1 live | `bun run smoke` |

## Reading a hellgate test

Every hellgate file starts with a `★ CONTRACT —` header in its module docstring that names the ADR or claim it pins. Grep that header to find every test that backs a specific claim:

```bash
grep -rn "★ CONTRACT" tests/unit tests/integration | head
```

## Why this matters

- **hellgate ≠ e2e.** A hellgate test fails the moment a contract clause regresses, even if the broader scenario still appears to work. Do not "promote" a hellgate test to a generic e2e by relaxing assertions.
- **hell-e2e is the assembled twin** of a `-hellgate`. If you change loop wiring, run both.
- **Naming drift** breaks the audit pipeline in [quanta-comparison.md](analysis/code-agent-loop/quanta-comparison.md) — claims become unanchored. Keep the suffix.

## Cross-links

- [docs/decisions/0003-test-pyramid.md](decisions/0003-test-pyramid.md) — 4-tier test pyramid (unit/integration/contract/eval) — the rule the suffixes implement.
- [docs/analysis/code-agent-loop/quanta-comparison.md](analysis/code-agent-loop/quanta-comparison.md) — the claims index that consumes these filenames.
- [docs/tool-authoring.md](tool-authoring.md) — when adding a new tool, add a `*-hellgate.test.ts` for its contract.
