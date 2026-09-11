# cli-sdk-parity — removed tests, and where the coverage went

Kept as MARKDOWN, not as a `.test.ts`.

This was a `.test.ts` containing a comment and `export {}` — zero tests. The
corpus selects test files by NAME, so it was planned into a chunk on every
campaign, and `bun test` on it alone exits 1 with `Ran 0 tests across 1 file`
and writes no JUnit at all. It sat there from 2026-06-08 until the shard
runner started comparing the EXACT executed file set instead of a count, and
the first real campaign under that check reported it as a planned file with
no execution evidence. The count it replaced could never have seen it.

The note below is the original, unchanged.

---

NOTE: This file's two source-grep "parity" tests were removed as confirmed
DUPLICATE / LOC_STRUCTURE_BUDGET findings (test-quality audit 2026-06-08).

They only readFileSync()'d production sources and asserted on import-literal
substrings (no behavior exercised). Every assertion is already covered by:
  - tests/unit/cli/runtime-sdk-cutover-hellgate.test.ts
      * "session-loop consumes sdk runtime, not runner interactive primitives"
        (lines 42-56) is a strict SUPERSET of the deleted
        "CLI session loop no longer reaches legacy runtime escape hatches"
        block (same session-loop.ts not.toContain set + @/sdk/runtime).
      * "cli setup and side-conversation seams..." (lines 67-102) covers the
        runtime-context-compose @/sdk/runtime + composeRuntimeBootstrapContext
        assertions and session-setup's not.toContain("sideConversationPort").
  - tests/unit/apps/cli/repl-thin-surface-ownership-hellgate.test.ts
      * "CLI repl host uses the single runner compat owner..." re-asserts the
        runtime-context-compose @/sdk/runtime + composeRuntimeBootstrapContext
        contract.
  - biome noRestrictedImports (file-specific overrides) authoritatively pins
    the import-fence for these files (type-imports + all subpaths), which a
    toContain('from "@/sdk/runtime"') grep cannot.

No new test added: this was redundant proxy coverage, not behavioral coverage.
