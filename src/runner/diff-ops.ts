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
export const resolveEnvCaps = (): { maxBytes: number; maxLines: number } => ({
  maxBytes: parsePositiveInt(process.env.QUANTA_DIFF_MAX_BYTES, DEFAULT_MAX_BYTES),
  maxLines: parsePositiveInt(process.env.QUANTA_DIFF_MAX_LINES, DEFAULT_MAX_LINES),
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
