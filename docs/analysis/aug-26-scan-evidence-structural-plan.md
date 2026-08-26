# Scan-derived verdicts must carry their own evidence — structural plan (aug-26)

## The single root cause

Four defect classes were found separately over the last two days:

- a repo scan anchored on the ambient cwd (4 sites; 1 inverted to green)
- `loadFeaturesStrict(dir = "tools/feature-catalog/features")` — same shape one
  layer down, in a LOADER, so every consumer inherited it
- 10 `*.test.ts` files that no gate ever ran, three of which were documented as
  running at CI
- a ratchet whose scan takes 7.4s against a 5s timeout under load

They are not four problems. Every one is the same one:

> **A test derives a verdict from a scan, and the scan's REACH is neither typed
> nor proven. So "I found no violations" and "I never looked" are the same
> value — `[]` — and they are indistinguishable at the assertion.**

Measured support for that being the root and not a story:

| fact | value | how measured |
|---|---|---|
| test files that scan the repo | 118 | `grep -l readdirSync tests/**/*.test.ts` |
| of those, defining their OWN recursive walker | 40 | + `grep -l 'const walk\|function walk\|const collect'` |
| shared scan helpers that exist today | 0 | `ls tests/_helpers/` → only `expect-present.ts` |
| cwd-anchored fs/shell sites | 4 of 3,362 | `repo-path-anchor-ratchet` detector |
| of those that inverted to GREEN | 1 | `cli-feature-gates-drift` |
| tests that assert on cwd or chdir | 4 | all 4 pass under a sandbox (paired) |

So the anchor bug is small and mostly loud. The DUPLICATION is the large number,
and it is what makes the class recur: 40 independent authors each decide where
the root is, what to ignore, and what an empty result means.

## What "structural" means here, and what it rules out

The fix landed on 2026-08-26 (`repo-path-anchor-ratchet`) is a REGEX GUARD. It
detects the shape after someone writes it. It cannot follow a binding or a
hand-rolled walker — a limit it states rather than hides. A guard is the right
answer when the bad shape is unavoidable; it is the wrong answer when the bad
shape can be made unrepresentable.

Here it can. The plan is therefore:

> **Make the scan's reach a value the consumer cannot discard.** A scan does not
> return `string[]`. It returns evidence: the anchor it resolved, the count it
> saw, and the floor it was constructed against. Below the floor it THROWS at
> the scan, not at the assertion — so an empty scan can never reach a verdict.

The regex ratchet is then demoted from primary defense to migration guard, which
is what it is actually good at.

---

## P1 — the evidence-bearing scanner  *(no dependencies; do first)*

`tests/_helpers/repo-scan.ts`:

```ts
export type ScanEvidence = {
  readonly files: readonly string[]   // repo-relative, sorted
  readonly anchor: string             // the resolved root, for failure messages
  readonly floor: number              // what the caller declared it must exceed
}
export const repoScan = (opts: {
  under: string                       // "src" | "tests" | "tools/…"
  match: (rel: string) => boolean
  floor: number                       // REQUIRED — no default, no zero
}): ScanEvidence
```

Four properties, each of which kills one of the four defect classes:

1. **The anchor is the module's own location, once.** `import.meta.dir` of the
   helper, not of the caller, not the cwd. 40 decisions collapse to 1.
2. **`floor` has no default.** Omitting it is a type error, so "I never looked"
   cannot be spelled. Below it, `repoScan` throws naming the anchor it used —
   which is the message that would have solved `cli-feature-gates-drift` in one
   run instead of five methods.
3. **`files` is only reachable through `ScanEvidence`.** A helper that returns a
   bare array can be destructured and the provenance dropped; this cannot.
4. **One `git ls-files` / walk per process, memoised.** That is also the fix for
   the 7.4s-vs-5s timeout, which is a re-walk per test, not a slow walk.

**Hellgate (RED before any implementation):**
- `repoScan({under:"tests", match:…, floor:2000})` against an anchor pointing at
  an EMPTY directory must THROW. Today the equivalent returns `[]` and every
  downstream ratchet passes.
- A call site that omits `floor` must fail `typecheck:tests`.
- Red-on-injection: delete the floor check → the empty-anchor case goes green.

**Migration:** the 40 own-walker files. Each is a mechanical replacement, and
each one that had NO anti-vacuity floor gains one for free — that count is the
burn-down metric, measured before the first edit.

**Ratchet:** no test may define a recursive walker over the repo. Admit-list for
the genuine exceptions (a test ABOUT walking), with a stated reason each.

## P2 — timeout headroom  *(no dependencies; parallel with P1)*

`capability-literal-ratchet` is 7.4s against a 5s timeout under load and 1.4s at
rest. It passes today and fails tomorrow, and when it fails during the P3
sandbox migration it will read as "the sandbox broke it".

**This must land BEFORE P3 or P3's failure list is unreadable.** That ordering
is the whole reason P2 exists as a phase rather than a cleanup.

- Measure every test file's wall time at rest against its effective timeout.
- Fix everything under 2× headroom. Most are re-walks that P1's memoisation
  already removes — so P1 and P2 converge, and P2's residue is the real work.
- Ratchet: a test at less than 2× headroom on a quiet tree fails.

**Hellgate:** the measurement harness must report a KNOWN-slow test as slow. Run
it against a deliberately-sleeping fixture first; a harness that reports "no
slow tests" on a tree with a 4.9s test is the vacuous-measurement failure that
already happened twice this session.

## P3 — sandbox cwd as the default runner  *(depends on P2)*

`tools/dev/sandboxed-test.ts` exists, is pinned by 26 tests, and works
end-to-end (97/98, sandbox empty, 0 repo paths created). No `package.json`
script points at it. The audit shrank its blocker considerably: the 4 tests that
assert on cwd or `chdir` ALL pass under a sandbox.

- **Hellgate (RED):** a fixture that writes a relative path must land in the
  sandbox and NOT in the repo — asserted on both sides, so a runner that
  silently ran at the repo root fails.
- **Paired control, non-negotiable:** full suite under sandbox AND the same
  scope at the repo root, at the same time, on a quiet tree. Only the DIFF is
  evidence. Without it a load timeout is indistinguishable from a wiring bug —
  which is exactly what the 7.4s case looked like an hour ago.
- Wire `test:sandbox` as opt-in first; flip `test:unit` only after one clean
  paired run.

## P4 — cognitive complexity, 36 prod sites  *(independent; last)*

Already 274 → 36, and the ratchet blocks new debt, so this is the only phase
with no regression risk. The work is CLASSIFICATION, not lowering a number:
each site is either a genuine split or a justified allowlist entry with a
reason. Top: `trace-viewer.html` 35, `agent/converge/exercise.ts` 35,
`agent/lsp-bridge/nav.ts` 34, `apps/cli/login-cmd.ts` 32.

---

## Order and parallelism

```
P1 ─┐
P2 ─┼─→ P3 ─→ final adversarial audit (≥3 rounds)
P4 ─┘
```

P1, P2, P4 are file-disjoint and run in parallel. P3 is gated on P2 for the
reason stated above, and on a quiet tree for the paired control.

## How each phase is allowed to claim done

Not "the tests pass". For every phase: a hellgate that was RED first, a
red-on-injection proof that the new guard fires, and a paired control where the
verdict could otherwise be explained by load or ordering. A phase that cannot
produce all three reports as incomplete, not as done.
