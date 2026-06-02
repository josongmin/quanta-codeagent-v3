# ADR-0449 — CLI diff preview: unified-diff hunk headers + old/new line-number gutters

**Status:** Accepted (2026-06-02)
**Slice:** `src/apps/cli/diff-preview.ts` (+ `tests/unit/cli/diff-preview.test.ts`)
**Builds on:** ADR-0440 (RFC-06 — pure line-LCS diff math hoisted to `@/runner/diff-ops`; this module keeps ANSI serialization)
**Default-OFF:** Yes — additive. The legacy simple render (`  keep` / `- del` / `+ add`, no gutters, no headers) is the default; the richer path is lit ONLY by `renderUnified(..., { hunks: true })`. Existing callers and the prior test corpus are byte-identical.

## Context

`renderUnified` previously rendered every diff op on its own coloured line
with a `+`/`-`/space prefix — no line numbers, no hunk headers. On a large
file the reviewer staring at the confirm prompt could see THAT lines
changed but not WHICH section of the file, and there was no way to map a
shown line back to its position in the source. Standard unified-diff
vocabulary — git-style `@@ -A,B +C,D @@` hunk headers plus per-line
old/new line-number gutters — is exactly what developers expect from a
diff and is the missing affordance.

The pure diff math (`diffLines` → `DiffOp[]`) lives in `@/runner/diff-ops`
(ADR-0440). `DiffOp` carries only `{ kind, line }` — **no line numbers**.
Rather than mutate that surface-agnostic shape (and risk the web-daemon
canvas consumer), this slice computes cumulative 1-based line numbers
locally during a single render walk and leaves `diff-ops.ts` untouched.

## Decision

Add an opt-in richer render path to `renderUnified` via a new
`RenderUnifiedOptions` 4th argument:

```ts
renderUnified(before, after, maxLines, { hunks?: boolean; context?: number })
```

- `hunks` defaults to **false** → the exact legacy simple render (byte-identical).
- `context` defaults to `DEFAULT_CONTEXT_LINES = 3` — git's `--unified=3`
  / `-U3` default (`git diff --help`, "-U<n> / --unified=<n>").

### Algorithm (all pure, no I/O, no new deps)

1. **`numberOps`** — single walk over the `DiffOp[]` assigning 1-based
   old/new line numbers. `keep` → both advance; `del` → only old advances
   (new gutter blank, stored as `0`); `add` → only new advances (old
   gutter blank, stored as `0`).

2. **`groupHunks`** — collect indices of non-`keep` ops. Coalesce two
   consecutive changed ops into one hunk when the number of unchanged ops
   strictly between them is `<= 2*context` (their context windows touch or
   overlap); split when `> 2*context`. Each hunk's index range is
   `[max(0, first-context), min(len, last+1+context))`. An all-`keep` op
   list yields **zero hunks** → empty body.

3. **`spanCounts`** — for a hunk's index span, `oldStart`/`newStart` are
   the first old/new line numbers present; `oldCount`/`newCount` are how
   many lines the span covers per side (keep counts both, del only old,
   add only new). Git convention: a 0 count pairs with start 0 (e.g.
   all-add into an empty file → `@@ -0,0 +1,N @@`; all-delete → `@@ -1,N +0,0 @@`).

4. **`gutterWidth`** — digit-count of the widest line number rendered
   across all hunk bodies (≥1), so old/new columns right-align file-wide
   even on ≥1000-line files.

5. **`gutterLine`** — `<oldG> <newG> <marker><line>`, both gutters
   `padStart(w)` (blank string of width `w` on the absent side). Colour
   matches the simple path: del red, add green, keep uncoloured. Headers
   are `dim(cyan(...))` to mirror git.

`clip(..., maxLines)` is reused unchanged so the hunk body honours the
same line cap and `… (N more lines)` suffix.

## Consequences

- The simple path remains reachable and unchanged; the new path is dead
  code until a caller passes `{ hunks: true }` (wiring into the confirm
  prompt is intentionally a follow-up — this slice ships the render
  capability only).
- No mutation of `@/runner/diff-ops` — `DiffOp` stays surface-agnostic;
  line numbers are a CLI-render concern computed at the serialization
  boundary.
- Slice-fence clean: only `@/runner/diff-ops` (existing) + `@/ui`
  (existing red/green/dim/cyan) + `@/permission`. No new deps.

## Deferred (honest)

- **Wiring** the `{ hunks: true }` path into the actual confirm-prompt
  callers (`renderWrite` / `renderScriptedReplace`) — left OFF so this
  slice is purely additive and byte-identical.
- **Word-level / intra-line** diff (highlighting the changed sub-span of a
  modified line) — out of scope; this is line-granular only.
- **Line-wrap interaction** — long lines are not wrapped to terminal
  width; a wrapped continuation line would not carry a gutter. Existing
  module has no wrap handling either; unchanged here.
- **`\ No newline at end of file`** marker — not emitted (git does); the
  LCS split convention treats a trailing newline implicitly.
