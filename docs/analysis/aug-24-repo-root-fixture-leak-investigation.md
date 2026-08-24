# The repo-root fixture leak: what is known, and what five methods failed to find

**Status: UNRESOLVED source. Detection is in place; the writer is not identified.**

This records an investigation that did not reach its goal, so the next person
does not repeat the five approaches that already failed — including the one an
earlier draft of this very document recommended.

## The symptom

A full `bun test tests/unit` leaves three untracked files at the repo root:

| path | bytes | content |
|---|---|---|
| `src/x.ts` | 7 | `no edit` |
| `rel.txt` | 5 | `based` |
| `round.txt` | 9 | `jailed-ok` |

All three are test FIXTURES by content. `rel.txt` holds exactly the bytes
`tests/unit/storage.test.ts` writes; `round.txt` exactly what `fs-jail.test.ts`
writes; `src/x.ts` exactly the `"no edit"` payload in
`dispatch-lint-delta-hellgate.test.ts`. None of those three tests can be the
writer on its own — each passes a temp `baseDir`, and `resolvePath` resolves a
relative path against the base, never `process.cwd()`.

## Why it costs more than a dirty tree

The suite POISONS ITSELF. `storage.test.ts` asserts that a relative name does
**not** exist under `process.cwd()`:

```ts
await writeFile("rel.txt", "based", dir)
…
expect(await fileExists("rel.txt")).toBe(false)   // ← fails on the NEXT run
```

So one leaking run makes the following run red, deterministically, with no
ordering or load involved. `src/x.ts` is worse: it is not valid TypeScript, so
it fails `typecheck:all` (TS1434), adds two `lint` errors, and — because
`lint:debt` is a CLOSED universe — fails that gate too, all in a file no commit
contains. The aug-23 incident was three gates red at once with nothing wrong in
`git log`.

## What IS established

- **It is an INTERACTION, not one test.** `bun test tests/unit --shard=1/2` and
  `--shard=2/2` were each run to completion: NEITHER produces any of the three
  files. The full run produces all three. Running the three suspect files alone
  produces nothing.
- **Timing within a 278 s full run** (from a timestamped run with a 20 ms
  poller): `src/x.ts` at +170 s, `rel.txt` at +239 s, `round.txt` at +254 s.
- **The write is not visible at the obvious fs seams.** A `--preload` hook over
  `Bun.write`, `fs.writeFileSync`, `fs.appendFileSync`, `fsp.writeFile`,
  `fsp.appendFile`, `fs.createWriteStream`, `fs.openSync`, `fsp.open`,
  `fs.renameSync`, `fsp.rename`, `copyFile*`, `link*`, `symlink*` and `mkdir`
  logged NOTHING across a full run in which all three files appeared. The hook
  is not blind: a self-check that writes `round.txt` through `Bun.write`, and a
  second through `writeFileAtomic`, are both recorded when driven directly.
- **`Bun.spawn`/`spawnSync` with `cwd` = repo root** was hooked too. Nothing.

## The four approaches that failed, and why

1. **Namespace monkey-patching in a preload.** This is the likely reason the
   hooks saw nothing in the suite while working in a self-check. `writeFileAtomic`
   uses `import { open, rename } from "node:fs/promises"` — ESM named bindings,
   resolved at module load. Patching the *namespace object* returned by
   `require("node:fs/promises")` does not affect a module that imported the
   bindings directly. The obvious remedy — intercept at the module-resolution
   layer instead — was tried and is refused by Bun; see the retraction below.
2. **Correlating appearance time with test output.** `bun test` buffers per file
   and prints headers only for files with output, so a timestamped stdout stream
   has nothing to correlate a wall-clock hit against.
3. **Occupying the paths as DIRECTORIES** so the write fails loudly with EISDIR.
   The decoy directories survived a full run untouched, and no EISDIR naming any
   of the three paths appeared. Either the write is attempted and its error is
   swallowed, or it never reaches a syscall this decoy can catch. (The decoy does
   produce one unrelated failure — `src/x.ts` as a directory breaks the arch scan
   that reads every `src/**/*.ts`.)
4. **Shard bisection.** Both halves are clean. Read as "the interaction spans
   them" at the time; the intermittency measured below means it is equally
   consistent with the leak simply not firing on those two runs.

## What IS in place

`tools/dev/worktree-pollution-guard.ts` measures the untracked-path DELTA across
a command and fails on anything the run created. It is wired into CI's `unit`,
`integration` and PTY-e2e steps, and available locally as
`bun run test:pollution`. It caught this leak on the run that produced it, with
byte counts and content previews — which is how the three files above were
identified. Detection is solved; attribution is not.

## Frequency (measured aug-25)

INTERMITTENT, not deterministic. Across six full-suite runs where the paths were
free and observable, three leaked and three did not — including a clean
`bun run test:pollution` (37,908 tests, "0 created by the run"). Both `--shard`
halves were clean, which is consistent with either "the interaction spans them"
or "it simply did not fire that run".

This matters for method: a delta-debugging bisect over the file list cannot
converge cheaply, because a clean result on a candidate set is not evidence of
absence. Any bisect would need N repetitions per candidate to reach useful
confidence, multiplying an already-4-minute step.

## The suggested next step, RETRACTED

An earlier version of this document proposed intercepting `node:fs` through a
`Bun.plugin` `onLoad` rewrite, on the reasoning that it is the only hook that
survives ESM named binding. **That does not work.** Bun refuses it outright:

```
error: module() cannot be used to override builtin module "node:fs/promises"
```

So there is no supported way to intercept the writes from inside the test
process. Recorded rather than quietly dropped, because the retracted idea was
the plausible-looking one.

## What DOES work, and is the better shape anyway

Measured: the suite runs correctly from a FOREIGN working directory. A slice of
583 tests across 37 files passes with `cwd` set to a throwaway directory, given
the two `bunfig.toml` preloads passed explicitly (`--preload tests/preload-clean-source-js.ts
--preload tests/setup.ts`), and leaves that directory empty.

That reframes the problem. Attribution is hard; CONTAINMENT is easy, and it is
what actually costs us:

  - A relative-path write lands in the sandbox, so the repo can no longer be
    poisoned and `typecheck` / `lint` / `lint:debt` can no longer go red from a
    file no commit contains.
  - Anything that appears in the sandbox is attributable to the run BY
    CONSTRUCTION — nothing else on the machine uses that directory — which turns
    the pollution guard's known "another process may have created it" caveat
    into a non-issue.
  - `storage.test.ts`'s `expect(await fileExists("rel.txt")).toBe(false)` stops
    being self-poisoning, because the cwd starts empty on every run.

The blocker is bounded and measurable: 95 of 3,311 test files reference
`process.cwd()`. Each is either a test that should have been cwd-independent
anyway (repo-root scans belong on `import.meta.dir`) or one whose assertion
gets STRONGER under a sandbox. That migration is the real next step.
