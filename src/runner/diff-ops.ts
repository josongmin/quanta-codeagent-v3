/**
 * `@/runner/diff-ops` — surface-agnostic line-level diff math.
 *
 * ADR-0440 hoisted the pure diff computation out of `src/apps/cli/diff-preview.ts`
 * so BOTH the CLI inline preview AND the web-daemon canvas emitter consume ONE
 * implementation (the diff math runs once, never re-implemented per surface).
 * The CLI module re-exports these and keeps its ANSI serialization +
 * file-reading concerns; this slice is pure (no I/O, no ANSI, no surface
 * import) so it is safely importable from any library/app slice.
 *
 * Layering: lives in `@/runner` (Layer-2, surface-agnostic) which the
 * web-daemon already imports (`@/runner/assemble`). No `apps/**` import.
 */

// ───────────────────────────────────────────────────────────────────────
// Caps + ENV knobs
// ───────────────────────────────────────────────────────────────────────

/** Default content byte cap (per file side). Larger files render a
 *  "too large" placeholder instead of a diff. */
export const DEFAULT_MAX_BYTES = 64 * 1024
/** Default visible diff line cap. Beyond this the caller clips with a
 *  trailing "… (N more lines)". */
export const DEFAULT_MAX_LINES = 200

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Resolve env-driven caps at call time so tests can mutate `process.env`
 *  without re-importing the module. */
export const resolveEnvCaps = (): { maxBytes: number; maxLines: number; diffHunks: boolean } => ({
  maxBytes: parsePositiveInt(process.env.QUANTA_DIFF_MAX_BYTES, DEFAULT_MAX_BYTES),
  maxLines: parsePositiveInt(process.env.QUANTA_DIFF_MAX_LINES, DEFAULT_MAX_LINES),
  diffHunks: process.env.QUANTA_DIFF_HUNKS === "1",
})

// ───────────────────────────────────────────────────────────────────────
// Binary probe
// ───────────────────────────────────────────────────────────────────────

/** NUL byte is the canonical fast binary signal used by `git diff` and most
 *  diff tools. Avoids false positives on UTF-8 text containing high-bit bytes
 *  (e.g. CJK). The character is built via fromCharCode so this TS source
 *  stays NUL-free. */
const NUL = String.fromCharCode(0)

/** True iff `s` contains a NUL byte (treated as binary). */
export const isBinary = (s: string): boolean => s.includes(NUL)

// ───────────────────────────────────────────────────────────────────────
// Unified-diff math (line-level LCS, Hunt–McIlroy)
// ───────────────────────────────────────────────────────────────────────

/** A single line-level diff op. `keep` = unchanged, `del` = removed (old
 *  side), `add` = inserted (new side). */
export interface DiffOp {
  kind: "keep" | "del" | "add"
  line: string
}

/**
 * Line-level LCS (Hunt–McIlroy classical form). Quadratic in document size;
 * combined with the 64 KiB content cap this is bounded at ≈ 4 M cells worst
 * case which runs in well under 50 ms on the harness.
 *
 * Internally the dp table is flattened to a single `Uint32Array` of size
 * `(m+1)*(n+1)` so every cell read is a bounds-checked index rather than a
 * chain of `dp[i]![j]!` non-null assertions (which biome's `noNonNullAssertion`
 * rule flags). The semantics are identical to the textbook 2-D form.
 */
export const diffLines = (a: readonly string[], b: readonly string[]): DiffOp[] => {
  const dp = buildLcsTable(a, b)
  return backtrack(a, b, dp)
}

/**
 * Diff two whole documents (newline-joined). Empty-string inputs are the empty
 * document (mirrors the CLI `renderUnified` split convention). Pure — no I/O,
 * no ANSI.
 */
export const diffOps = (before: string, after: string): DiffOp[] => {
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  return diffLines(a, b)
}

interface LcsTable {
  readonly dp: Uint32Array
  readonly stride: number
}

const buildLcsTable = (a: readonly string[], b: readonly string[]): LcsTable => {
  const m = a.length
  const n = b.length
  const stride = n + 1
  const dp = new Uint32Array((m + 1) * stride)
  const at = (i: number, j: number): number => dp[i * stride + j] ?? 0
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * stride + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  return { dp, stride }
}

// ───────────────────────────────────────────────────────────────────────
// Hunk decomposition + partial reconstruction (T05 — per-hunk accept/reject)
// ───────────────────────────────────────────────────────────────────────

/**
 * One ATOMIC hunk: a maximal run of consecutive non-`keep` ops (a contiguous
 * change region). A modify (`del` immediately followed by `add`) is ONE hunk,
 * not two — the smallest unit a user can accept/reject without leaving a
 * half-applied edit. Context (`keep`) ops never belong to a hunk; they are
 * always emitted unchanged on both sides, so partial application stays
 * line-coherent regardless of which hunks are selected.
 *
 * `id` is a deterministic 1-based `h<N>` derived purely from hunk ORDER, so the
 * same `(before, after)` pair always produces the same ids — the selection a
 * surface sends back (referencing the preview's numbering) is stable as long as
 * the SAME `before`/`after` are re-diffed at apply time (the staleness guard
 * enforces that `before` still matches disk).
 */
export interface DiffHunk {
  /** Stable order-derived identifier: `h1`, `h2`, … */
  readonly id: string
  /** 0-based hunk index (=== Number(id.slice(1)) - 1). */
  readonly index: number
  /** The consecutive `del`/`add` ops composing this change (no `keep`). */
  readonly ops: readonly DiffOp[]
  /** 1-based old-file line of the first old line this hunk touches; for a pure
   *  insertion (zero `del`) it is the old-line AFTER which the insertion lands
   *  (0 when inserting before the very first line / into an empty file). */
  readonly oldStart: number
  /** 1-based new-file line of the first new line this hunk produces; for a pure
   *  deletion (zero `add`) it is the new-line the deletion sits between (0 when
   *  the deletion is at the very top). */
  readonly newStart: number
  readonly delCount: number
  readonly addCount: number
}

/**
 * Decompose `before → after` into atomic hunks (see {@link DiffHunk}). Pure —
 * computes the line-LCS once and groups maximal non-`keep` runs. An unchanged
 * pair yields `[]`. Ids are assigned in document order (`h1`, `h2`, …).
 */
export const splitHunks = (before: string, after: string): DiffHunk[] =>
  hunksFromOps(diffOps(before, after))

/**
 * Group a pre-computed op list into atomic hunks. Factored out so
 * {@link applySelectedHunks} can derive hunk membership from the SAME op array
 * it walks for reconstruction (op object identity is meaningless across two
 * separate `diffOps` calls — membership is keyed by ARRAY INDEX instead).
 */
const hunksFromOps = (ops: readonly DiffOp[]): DiffHunk[] => {
  const hunks: DiffHunk[] = []
  let oldLine = 0 // 1-based cursor: last old line CONSUMED
  let newLine = 0 // 1-based cursor: last new line PRODUCED
  let run: DiffOp[] = []
  let runOldCursor = 0 // old cursor captured when the run started
  let runNewCursor = 0 // new cursor captured when the run started
  let runDel = 0
  let runAdd = 0
  const flush = (): void => {
    if (run.length === 0) return
    const index = hunks.length
    hunks.push({
      id: `h${index + 1}`,
      index,
      ops: run,
      // First old line touched when the hunk deletes; else the insertion point
      // (the cursor — the old line the inserted block follows).
      oldStart: runDel > 0 ? runOldCursor + 1 : runOldCursor,
      // First new line produced when the hunk inserts; else the deletion's
      // position on the new side (the cursor it sits between).
      newStart: runAdd > 0 ? runNewCursor + 1 : runNewCursor,
      delCount: runDel,
      addCount: runAdd,
    })
    run = []
    runDel = 0
    runAdd = 0
  }
  for (const op of ops) {
    if (op === undefined) continue
    if (op.kind === "keep") {
      flush()
      oldLine++
      newLine++
      continue
    }
    if (run.length === 0) {
      runOldCursor = oldLine
      runNewCursor = newLine
    }
    run.push(op)
    if (op.kind === "del") {
      oldLine++
      runDel++
    } else {
      newLine++
      runAdd++
    }
  }
  flush()
  return hunks
}

/**
 * Reconstruct the file content that results from applying ONLY the hunks in
 * `selectedIds` to `before` (the other hunks stay at their `before` state).
 * Pure — re-diffs `before → after` and walks the ops once:
 *   - `keep` → always emitted (shared context),
 *   - `del`  → emitted (line RETAINED) iff its hunk is NOT selected,
 *   - `add`  → emitted (line INSERTED) iff its hunk IS selected.
 *
 * Invariants (asserted in tests): selecting every hunk id reproduces `after`
 * exactly; selecting none reproduces `before` exactly. Unknown / duplicate ids
 * are ignored (the Set membership is idempotent) — never throws.
 */
export const applySelectedHunks = (
  before: string,
  after: string,
  selectedIds: readonly string[],
): string => {
  const selected = new Set(selectedIds)
  const ops = diffOps(before, after)
  const out: string[] = []
  // Walk the ops once, tracking the CURRENT hunk index the same way
  // `hunksFromOps` numbers them: a hunk is a maximal run of non-`keep` ops, so
  // the index advances when a non-`keep` run STARTS (after a `keep` boundary).
  let hunkIndex = -1
  let inRun = false
  for (const op of ops) {
    if (op.kind === "keep") {
      out.push(op.line)
      inRun = false
      continue
    }
    if (!inRun) {
      inRun = true
      hunkIndex++
    }
    const isSelected = selected.has(`h${hunkIndex + 1}`)
    if (op.kind === "del") {
      // Retain the original line when its hunk was NOT accepted.
      if (!isSelected) out.push(op.line)
    } else if (isSelected) {
      // Insert the new line only when its hunk WAS accepted.
      out.push(op.line)
    }
  }
  return out.join("\n")
}

const backtrack = (a: readonly string[], b: readonly string[], t: LcsTable): DiffOp[] => {
  const m = a.length
  const n = b.length
  const at = (i: number, j: number): number => t.dp[i * t.stride + j] ?? 0
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    const ai = a[i]
    const bj = b[j]
    if (ai === bj) {
      ops.push({ kind: "keep", line: ai ?? "" })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "del", line: ai ?? "" })
      i++
    } else {
      ops.push({ kind: "add", line: bj ?? "" })
      j++
    }
  }
  while (i < m) {
    ops.push({ kind: "del", line: a[i] ?? "" })
    i++
  }
  while (j < n) {
    ops.push({ kind: "add", line: b[j] ?? "" })
    j++
  }
  return ops
}
