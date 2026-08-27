# Scan-derived verdicts must carry their own evidence — structural plan (rev 2)

Rev 1 was audited from four angles (adversarial, objective re-measurement,
completeness, prior-art) and did not survive. Three of its evidence rows were
wrong, its performance rationale was a misdiagnosis, its central mechanism had a
measured degenerate equilibrium, and its safety story was inverted. This rev
records the corrections in place rather than quietly restating the plan, because
the errors are the most useful thing the audit produced.

## What rev 1 got wrong

| rev 1 claim | measured truth | consequence |
|---|---|---|
| "shared scan helpers today: 0" | **1, with 54–60 consumers** — `tests/unit/_arch/slice-boundary-scanner.ts`, already repo-anchored, already floored | P1 was a greenfield build of something that exists. It becomes an extension. |
| "4 cwd-anchored sites of 3,362" | **0 remaining**; 4 is the already-fixed count. Detector over history: 7 → 3 → 0 | the row described a fixed past as the present |
| "40 own walkers" | 42 by brace-matched bodies, 170 by a looser grep, 91 files with their own `REPO_ROOT` | the worklist was never the number quoted |
| "7.4s is a re-walk per test; memoisation fixes it" | `git ls-files` is **37ms of 1350ms**; the cost is 32MB of `readFileSync` and an O(chars) detector | P1 property 4 removes 2.7% of the problem, and P2's scope was derived from it |
| "P2 must precede P3" | rev 1 itself then said a simultaneous paired control cancels load | the dependency dissolves; the strongest instrument was scheduled last behind a false gate |
| "P2: build a per-test timing ratchet" | `tools/dev/unit-speed-budget.ts` already does it, gated at `ci.yml:80`, with its own `MIN_TESTCASES=1000` floor | P2 was a duplicate of a CI-wired system |
| "make `floor` required and omission a type error" | of the same population, **56 of 81 already write `toBeGreaterThan(0)`** — floor:1 is the observed equilibrium, not a risk | a required parameter enforces a number, not a meaning |
| P3 flips `test:unit` to the sandbox, safely | CI never calls `test:unit`; `ci.yml:71` runs `bun test tests/unit` directly | a default flip creates permanent dev/CI cwd divergence |
| the sandbox adds a signal | `worktree-pollution-guard` watches the **repo root** only | under a sandboxed default it reports clean forever — the sandbox **masks** the signal it was sold as strengthening |
| P3's acceptance: both suites "at the same time, on a quiet tree" | running two full suites simultaneously *is* the load; the recorded precedent is 4.7h / 232 timeout REDs | the acceptance criterion cannot be satisfied as written |

And the ratchet that motivated rev 1 was itself vacuous. `repo-path-anchor-ratchet`
reported the tree clean while `tool-surface-manifest-hellgate` failed 3 of 36
under a foreign cwd. Two regex defects: a nine-line comment between `execSync(`
and its command string defeated `\s*`, and a `[^`"']*` capture truncated at the
inner quote of `grep -rhoE 'name: …' src/tool …`. Both fixed; the detector now
names that file and it passes 36/36 on both sides.

**That is the strongest evidence for the thesis and against rev 1's design.** The
thesis holds: a scan-derived verdict that does not prove its reach is worthless.
Rev 1's answer — a new helper with a caller-declared floor — would not have
caught it, because the defect was in the detector's reach, not in an author's
diligence.

## The revised thesis

> A scan's REACH must be a committed, ratcheted NUMBER — derived by measurement,
> not chosen by the author — and it must be checked against GROUND TRUTH (running
> from a foreign cwd), because a regex over source can always be blind in a way
> no regex can detect.

Two instruments, and neither replaces the other:

- **Derived floors** catch a scan that shrank. Cheap, runs everywhere, and unlike
  rev 1's `floor` parameter it cannot be satisfied by writing `1`, because the
  number comes from a baseline file the way `lint-debt-ceiling.json` does.
- **The foreign-cwd run** catches a scan that never reached, including every
  shape a regex cannot follow (bindings, hand-rolled walkers, shell-outs with the
  path past an inner quote). It is the only thing that would have caught the two
  live defects this audit found.

---

## A — close the live vacuous-green in `tools/feature-catalog` *(no dependencies)*

Reproduced, today, on main:

```
repo cwd     : validate: 1068 feature(s), all evidence resolved   exit=0
foreign cwd  : validate:    0 feature(s), all evidence resolved   exit=0
```

Checking 1068 and checking 0 emit the same success. `loadFeaturesStrict`'s default
was anchored on `import.meta.dir`, but `cli.ts:61`, `pm/check.ts:18` and
`surface-derive.ts:41` each hardcode `FEATURES_DIR = "tools/feature-catalog/features"`
and pass it explicitly — ten call sites in `cli.ts` alone — so the fix is
overridden at every consumer. `loadFeatures` (non-strict), `loadProse` and
`loadBaseline` still carry cwd-relative defaults, and `gatherYamlFiles` returns
`[]` on ENOENT.

**And a test pins the defect as correct**: `tests/unit/feature-catalog-schema.test.ts:207`
asserts `loadFeatures returns empty array when dir absent`. This must be replaced,
not deleted — the honest form is that a MISSING catalog throws while an EMPTY one
returns `[]`.

**Hellgate (RED first):** `bun fc validate --strict` from a foreign cwd must exit
non-zero. It exits 0 today.

## B — make the detector's reach honest *(no dependencies)*

The detector now covers `readFileSync`-family, `Bun.file`, `Glob`, and the four
shell entry points. Measured blind spots remain: `Bun.Glob`/`new Glob` at the call
position (13 uses in `tests/`), `globSync`, `opendirSync`, `readlinkSync`, `cpSync`,
`watch`, and `Bun.$`. Its walk covers `tests/` only, while the live defect in A
sits in `tools/` and `src/agent/prompt-graph/role-drift.ratchet.test.ts` and
`src/tool/terminal-surface.test.ts` do repo scans from the ungated population.

Each widening lands with the offender it exposes, or with an explicit note that it
exposed none — a widening that finds nothing must say so rather than look like
coverage.

**Hellgate:** for every entry point added, a RED case from the real tree first.

## C — the sandbox as a SECOND observation, never a default *(depends on B)*

Rev 1's flip is withdrawn. `test:unit` stays as it is; CI keeps running at the
repo root, where `worktree-pollution-guard` can see strays.

- Add `test:sandbox` (opt-in) pointing at the existing, already-pinned
  `tools/dev/sandboxed-test.ts`.
- Acceptance is a **sequential** paired control, sharded: run shard *i* at the
  root, then shard *i* in the sandbox, compare. Simultaneity was the error; the
  control needs the same TREE and the same SHARD, not the same clock.
- The diff is the deliverable — each differing file is classified genuine-cwd or
  load, with the second re-run to settle it.

**Hellgate (RED):** a fixture writing a relative path must land in the sandbox and
NOT in the repo, asserted on both sides.

## D — derived floors on the scanner that already exists *(depends on C's diff)*

Extend `tests/unit/_arch/slice-boundary-scanner.ts` — 54–60 consumers, already
anchored, whose only floor is `expect(files.length).toBeGreaterThan(0)`.

- The floor is a number in a baseline JSON adjacent to the detector, the shape
  this repo already uses (`lint-debt-ceiling.json`, `god-code/allowlist.json`,
  `unit-speed-budget.json`), with a `--tighten` path and no way to raise it.
- **Reach is measured with `git ls-files`, not a filesystem walk.** `tools/dev/.scratch`
  is a gitignored twin of `src/` holding **4,394** `.ts` files; a walk-backed floor
  can be satisfied entirely by scratch copies.
- Two numbers, not one: the WALKED set proves the anchor, the MATCHED set proves
  the predicate. A `match` that rotted after a refactor clears any floor on the
  first.

**The migration's proof obligation** — the part rev 1 omitted, and the reason this
phase is last. A shared walker with a fixed skip policy NARROWS the scan for the
6 hand-rollers that walk everything, and narrowing is self-ratifying here: 16
scanning tests assert a ceiling over the scanned set, 11 without a floor, and
`tools/dev/refresh-silent-catch-baseline.ts` rewrites baselines "only DECREASING"
and runs at `ci.yml:121`. So each migrated file must show **set equality** of the
scanned paths before and after, or record the diff with a reason. "The assertion
still passes" is exactly the evidence that cannot distinguish a correct migration
from the defect.

## E — the 359 test files no gate runs *(no dependencies)*

`src/**` 296, `apps/**` 46, `tools/**` 17. No script runs `bun test` over any of
them. `gated-test-scope-ratchet` cannot see them: it walks `join(REPO_ROOT, "tests")`
only, so its closed allowlist is closed over the wrong universe — the guard cited
as a motivating defect has the defect.

Either gate them or give each an `OUT_OF_BAND` entry naming its runner, and widen
the ratchet's walk to the repo.

## F — cognitive complexity classification *(independent, last)*

36 prod sites behind a ratchet that blocks new debt. One correction: the headline
site, `src/apps/bench/trace-viewer.html` at 35, is **outside** the gated 36 —
`collectBiomeTargets` admits zero `.html` targets — so "the ratchet blocks new
debt" is false for HTML and that gap is the first thing to close.

---

## Order

```
A ─┐
B ─┼─→ C ─→ D
E ─┤
F ─┘
```

A, B, E, F are file-disjoint and parallel. C needs B so its diff is readable
against an honest detector; D needs C's classified diff so the floors are derived
from a reach that has been checked against ground truth.

## There is no CI backstop

`gh run list --workflow=ci.yml` returns HTTP 404, and the repo's own records put
Actions billing failures from 2026-07-12 with every sampled job at `steps=0`. Every
gate named here is enforced only by local runs. That is the argument for A and C
being early and for the withdrawn default-flip staying withdrawn.

## Execution log (rev 2, 2026-08-27)

Landed, each with a hellgate that was RED first and a red-on-injection proof.

**A — the fc vacuous-green** (`2845e206c`). The rule became "a relative path is
REFUSED", which a caller cannot override because passing the bad value is what
throws. Three states that used to collapse into `[]` are now distinct. Two more
layers were the same shape and only appeared once the first was fixed:
`const ROOT = process.cwd()` resolved every evidence path (the silent 0 became
9,593 errors), and `adrExists()` read a cwd-relative `docs/decisions` behind
`catch { return false }` (726 more). All four commands are now byte-identical
from the repo root and a foreign cwd.

Anchoring `lint` exposed debt it had never been able to see: **32 orphan Accepted
ADRs**, grandfathered by NAME (18 numbers) so the list can only shrink. And
`feature-catalog-evidence-existence-hellgate` injected its fixture through `cwd`
— once the tool stopped trusting the cwd, its dangling case failed and its clean
case kept passing while silently measuring the real 1,068-feature catalog. Now
`--repo-root <abs>`, with the COUNT pinned so "my fixture resolved" is
distinguishable from "some catalog resolved".

**B — detector reach** (`ffd98858e`). Nine shapes added; NONE had a live
offender, and that is stated rather than dressed up. The widening exposed one
thing not on the list: the shared `stripComments` treats the `/**/` inside a glob
STRING as a block comment, so `globSync("src/**/*.ts")` became `globSync("src*.ts")`
— which had silently disarmed the `Glob` entry point since the file was written.

**F — the lint ratchet's own reach** (`5b3de0e6b`). The gap was real and worse
than stated: `.html` carried 23 diagnostics including **2 at error severity**,
which `bun run lint` itself was blind to. All 23 were genuine and fixed, so the
ceiling file is untouched and prod stayed 36/36.

**C — containment** (`b61dc90d7`, `1ae82a1e1`, `05b8668f6`). The runner's own
summary reads identically whether it contained a write or never ran one, so the
hellgate asserts both sides. The parity harness reported **507 cwd-dependent
files** on its first run and every one was the harness: an `indexOf` -1 dropping
the first root (the second time that off-by-one has shipped here), and relative
roots killing every sandbox arm before bun printed a counter. Both pinned.

**Two defects were found in work landed EARLIER in this same effort**, which is
the most useful thing the execution produced: the anchor ratchet was itself
vacuous (a comment between `execSync(` and its string, and a capture truncating
at an inner quote) while a live offender sat in `tool-surface-manifest-hellgate`;
and the parity harness reproduced a bug its own sibling tool had already been
fixed for. Neither was found by review — both by running against ground truth.

## Second execution round — what auditing the fixes found (2026-08-27)

Two adversarial rounds ran against the work above. Both found real defects IN IT,
which is the part worth recording.

**The audit's method beat mine.** It built an empty mirror of the repo's
directory skeleton — every directory, zero files — dropped byte-identical copies
of guards at their real depths, and ran them. A guard reporting "no violations"
there has proven it cannot tell clean from never-looked. **Eight guards passed
100% green.** Reproduced independently, then fixed with derived floors; all eight
now fail on the mirror and pass on the real tree.

Three of them read `git ls-files` and CHECK ITS EXIT CODE, which looks like
diligence and is not: `git ls-files` exits 0 with no output when nothing matches.
`capability-literal-ratchet` is the sharpest case — it has five matcher positive
controls, all of which passed while the corpus was empty. **A detector control is
not a corpus floor.**

**The fc campaign kept finding more of itself.** After `adrExists` was fixed, the
audit found `collectAdrs` eleven lines away with the identical
`catch { return [] }` (572 records vs 0, no throw), plus `readDependsOn` and
`collectSrcFiles`. Then `stale` (868 features reported as 0, exit 0) and `diff`
— a hard CI gate. Then five `relative(process.cwd(), …)` in `schema.ts`, and a
fourth copy of the bare `"tools/feature-catalog/features"` literal living in a
TEST. Eight commands are now byte-identical across the repo root and a foreign
cwd; there is one place that decides where the catalog is.

**My own instruments were the worst offenders.** The parity harness produced
silent FALSE NEGATIVES on the exact class it exists to catch: `parseCounters`
read the first counter line so an earlier one masked the tail; `armsDiffer`
ignored the pass count so a file that could not LOAD was invisible if it also had
a failing test — **and the paired test pinned that blindness as intended**;
`classify` never checked which arm failed, so a coinflip fixture produced 25%
false findings. The local-walker lens added to the anchor ratchet was INERT on
arrival because its declaration pattern rejected a return-type annotation — the
shape of all three offenders it was written for — and looked green.

**One floor was removed after audit.** `total > CEILING / 2` on
no-raw-process-env encodes nothing: the documented burn-down contract lowers the
ceiling to each new floor, making it `total > total / 2`. Its only live effect was
to red a real burn-down. Kept the measured `files > 2500` beside it.

**And a justification nobody had measured.** The `apps/` allowlist entry claimed
`bun test` runs 0 of the 77 web-frontend files. It runs all 77 — 732 tests, 18
failures, one of them a real cwd bug the wrong reason would have hidden
permanently.

### The recurring shape, stated plainly

Every defect in both rounds is the same sentence: **a verdict derived from a scan,
where the scan's failure and the scan's success produce the same value.** `[]`,
`0`, `false`, exit 0. The fix is never a better detector — it is a floor that
makes the two distinguishable, and the floor has to be a MEASUREMENT, because an
author-chosen one converges on `> 0` (measured: 56 of 81 in this repo).

## How a phase may claim done

A hellgate that was RED first, a red-on-injection proof that the new guard fires,
and a paired control where the verdict could otherwise be explained by load or
ordering. A phase that cannot produce all three reports incomplete, not done.
