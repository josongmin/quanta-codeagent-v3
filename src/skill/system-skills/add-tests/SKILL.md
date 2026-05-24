---
name: add-tests
description: Author new tests for a function / module by reading the target, enumerating edge cases, matching project conventions, and running the tests before declaring done. Triggers on "add tests", "write tests for", "test coverage for", "what should I test in".
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "Edit", "test_runner", "file_tree_summary"]
category: skill
stability: stable
---

# add-tests — evidence-first test authoring

Engineering-task sibling of the CTK git-skill bundle (ADR-0111 family,
ADR-0134). The killer principle: **a test that doesn't run is not a
test**. A `*.test.ts` file that compiles but never executes the
assertion you imagined is worse than no test — it gives false confidence.

## When this skill activates

- The user says "add tests" / "write tests for X" / "test coverage
  for Y" / "what should I test in Z".
- A reviewer comment requests tests for an untested module.
- A failing CI run identifies a regression that lacks a test.

If none of these apply, do not silently pivot a normal task into a
test-authoring task.

## P0 rules

1. **Read the function under test BEFORE writing tests.** Understand
   its inputs, outputs, side effects (mutations, IO, time, network).
   Tests written from the function NAME alone are wishful thinking.
2. **List edge cases EXPLICITLY before writing.** Write a short
   bulleted plan first — boundary values (0, -1, MAX), null/empty
   inputs, error paths, concurrency / re-entry, contract invariants.
   No plan ⇒ tests will mirror the happy path the author already
   debugged.
3. **Find the project's test framework — match it. Don't introduce a
   new one.** Read `package.json` scripts AND look at existing
   `*.test.*` files. If the project uses `bun:test`, do not import
   `vitest`. Tooling drift is a code smell that survives merges.
4. **Use REAL fixtures when possible** — `tmpdir` + a real file,
   in-memory fake DB, etc. Mock only when the dependency is genuinely
   external (network, time, randomness). Over-mocked tests pass while
   the system is broken.
5. **Run the new tests BEFORE declaring done.** A test that doesn't
   run is not a test. Report the actual pass/fail count from the test
   runner — never assert "tests pass" from compile-cleanliness alone.

## Procedure

1. **Read the target.** Open the file under test in full (not just
   the function); read its imports, its callers, and its existing
   tests if any. Note inputs, outputs, side effects.
2. **Enumerate edge cases.** Write a plain-prose bullet list:
   happy / boundary / error / regression / contract (see below).
   Show it to the user (or include it in the final report) — the
   plan is half the value.
3. **Find test conventions.** `grep` for similar `*.test.*` files in
   the same slice. Match the file name pattern, the imports, the
   describe/test shape. Pin the framework from `package.json`.
4. **Write the test file.** One `describe` per public surface; one
   `test` per case from the plan. Inline minimal setup; extract
   helpers only on the second duplication.
5. **Run.** `bun test <new-file>` (or repo equivalent). Iterate on
   failures — a red test before the implementation can be your
   regression anchor, but a green test you never ran is theatre.
6. **Report counts.** "N tests added; M pass; 0 fail." Never claim
   coverage without numbers.

## What to test (5 axes)

- **Happy path** — the canonical input the function was built for.
- **Boundary** — 0, 1, -1, MAX_SAFE_INTEGER, empty array/string,
  single-element collection.
- **Error path** — invalid input, throws, rejects; pin the error
  TYPE and MESSAGE shape so refactors that swallow errors fail loudly.
- **Regression** — every bug fixed should add a test that fails on
  the pre-fix code; this is how the test suite earns its keep.
- **Contract** — invariants the caller depends on (idempotency,
  ordering, immutability, monotonicity).

## Outcome enum

- `tests-added` — new file(s) written, ran, all green; counts cited.
- `tests-added-with-failures` — tests written, some are red and
  surface a real bug; reported with file:line + repro.
- `blocked` — cannot determine framework, target ambiguous, or
  required fixture is external (DB, network); STOPPED + asked.

The string `complete` is forbidden until `tests-added` is true with
a green count.
