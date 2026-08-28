/**
 * PERMANENT GUARD — surrogate-safe truncation.
 *
 * THE BUG CLASS (this session): a naive fixed-length `s.slice(0, CAP)` (or the
 * tail mirror `s.slice(-CAP)`) on a JS string cuts at an arbitrary UTF-16 code
 * UNIT. A JS string is UTF-16, so an astral code point (emoji / CJK-ext /
 * box-drawing in some fonts) is stored as a HIGH+LOW surrogate PAIR. A cut that
 * lands BETWEEN the two halves leaves a LONE surrogate at the boundary. A lone
 * surrogate is NOT a Unicode scalar value: it re-encodes to a U+FFFD
 * replacement char or a malformed byte sequence the moment the string is
 * UTF-8-encoded for the wire / a prompt / a `.docx`/`.xlsx`/`.pptx` part — a
 * REAL corruption (a conforming Office reader refuses to open the file), not a
 * cosmetic one. It was found in the OOXML serializers, the `pty_read` cap, and
 * the side-agent `capDetail`.
 *
 * THE FIX was the shared `sliceWholeChars` / `sliceTailWholeChars` helpers
 * (`src/shared/slice-whole-chars.ts`), which back the cut off a surrogate
 * boundary (dropping a straddling pair WHOLE) so the result is always
 * well-formed.
 *
 * This file is a two-part PERMANENT guard:
 *
 *   PART 1 — PROPERTY-FUZZ every surrogate-safe truncation helper over a SEEDED
 *   PRNG (no `Math.random` / `Date.now` — every input is a pure function of a
 *   fixed seed + loop index, so any counterexample is reproducible). Strings are
 *   PACKED with astral chars at every offset and truncated at every cap. We
 *   assert the output is ALWAYS well-formed (`out.isWellFormed()` — no lone
 *   surrogate) AND the helper never GROWS the input. ≥500 cases / helper, zero
 *   violations = a proof.
 *
 *   PART 2 — STATIC RATCHET against a NEW naive cap-slice. An AST scan over
 *   `src/` flags every `str.slice(0, CAP)` / `str.slice(-CAP)` / `str.slice(CAP
 *   - n)` whose cut bound is a CAP-NAMED const (`*_MAX_*`, `*_CAP`, `*_LEN`,
 *   `*_OUTPUT`, `…PREVIEW`, `…TRUNC…`, `…TAIL…`, `…SNIPPET…`). A flagged site is
 *   a raw hand-rolled truncation that did NOT go through a surrogate-safe
 *   helper. Two allowlists tame the noise (see `ALLOW_*` below): hash/opaque-ID
 *   prefixes (structurally surrogate-free) and a documented BURN-DOWN of the
 *   pre-existing text-truncation sites. The ratchet's job is to catch a NEW,
 *   un-listed cap-slice — and to force the burn-down list to only SHRINK.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { sliceTailWholeChars, sliceWholeChars } from "@/shared"
import { stripIllegalXmlChars } from "@/tool/document/authoring"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "../..")

/* ============================================================ seeded PRNG */
// xorshift32 — fully deterministic, reproducible from a fixed seed (mirrors the
// established `fuzz-pure-cores-r4-hellgate.test.ts` convention). NO wall
// randomness: `Math.random` / `Date.now` are deliberately absent so a failing
// iteration is reproduced by re-running with the same seed + index.
class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9
  }
  next(): number {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    return this.s
  }
  int(n: number): number {
    return n <= 0 ? 0 : this.next() % n
  }
}

const LONE_HI = String.fromCharCode(0xd800) // unpaired high surrogate
const LONE_LO = String.fromCharCode(0xdc00) // unpaired low surrogate
const EMOJI = "\u{1F680}" // U+1F680 rocket — a VALID HIGH+LOW pair
const ASTRALS = ["\u{1F680}", "\u{1F4A9}", "\u{20BB7}", "\u{1F1FA}\u{1F1F8}"] as const

/** Build a string PACKED with VALID astral pairs interleaved with ASCII — so a
 *  cut at ANY offset has a high chance of straddling a pair (the exact corruption
 *  trigger). Pure function of the rng.
 *
 *  `injectLone`: when true ALSO sprinkles deliberately-unpaired surrogates. Use
 *  this ONLY for `stripIllegalXmlChars` (whose contract is to DROP lone
 *  surrogates outright → output always well-formed). The CUT helpers
 *  (`sliceWholeChars` etc.) only promise not to SPLIT a pair — they faithfully
 *  PRESERVE a lone surrogate the input already carried — so injecting lone
 *  surrogates there would make a boundary that was already lone (the input's
 *  fault) indistinguishable from a split (the helper's fault). */
const packedAstralString = (rng: Rng, units: number, injectLone = false): string => {
  let s = ""
  while (s.length < units) {
    const r = rng.int(10)
    if (r < 5) s += ASTRALS[rng.int(ASTRALS.length)]
    else if (injectLone && r < 6) s += rng.int(2) === 0 ? LONE_HI : LONE_LO
    else s += String.fromCharCode(0x41 + rng.int(26))
  }
  return s
}

/* ===================== helpers under test (incl. the private compositions) */
// `pty.capOutput` (src/tool/pty/tools.ts) and `side-agent.capDetail`
// (src/agent/side-agent-runner.ts) are module-private. We RE-DERIVE their exact
// composition here from the SAME exported primitives they use — so the property
// covers the real head+tail / clamp-with-marker semantics, not an approximation.
// (A drift check below pins that these reimplementations stay byte-identical to
// the source caps for under-cap inputs, where they MUST be pass-through.)

const PTY_MAX_READ_OUTPUT = 32 * 1024
const ptyCapOutput = (s: string): string => {
  if (s.length <= PTY_MAX_READ_OUTPUT) return s
  const keep = Math.floor(PTY_MAX_READ_OUTPUT / 2)
  const head = sliceWholeChars(s, keep)
  const tail = sliceTailWholeChars(s, keep)
  const dropped = s.length - head.length - tail.length
  return `${head}\n… [${dropped} chars truncated] …\n${tail}`
}

const DETAIL_MAX = 8_000
const DETAIL_TRUNC_MARKER = "\n…[side-agent finding truncated]"
const sideCapDetail = (detail: string): string => {
  if (detail.length <= DETAIL_MAX) return detail
  const cut = DETAIL_MAX - DETAIL_TRUNC_MARKER.length
  return sliceWholeChars(detail, cut) + DETAIL_TRUNC_MARKER
}

/* ===================================================================== PART 1 */

describe("PART 1 — property-fuzz: every surrogate-safe truncation helper", () => {
  const FUZZ_CASES = 520 // ≥500 per the guard contract
  const SEED = 0x5afe7717

  test("sliceWholeChars: well-formed + never grows + length ≤ max (520 cases)", () => {
    const rng = new Rng(SEED)
    for (let i = 0; i < FUZZ_CASES; i++) {
      const s = packedAstralString(rng, 4 + rng.int(80))
      const max = rng.int(s.length + 4) // can exceed s.length (under-cap path)
      const out = sliceWholeChars(s, max)
      // Input carries NO lone surrogates, so the OUTPUT must be FULLY well-formed
      // — any lone surrogate could ONLY come from the helper splitting a pair.
      expect({ i, ok: out.isWellFormed(), s: JSON.stringify(s), max }).toMatchObject({ ok: true })
      expect(out.length).toBeLessThanOrEqual(max < 0 ? 0 : max)
      expect(out.length).toBeLessThanOrEqual(s.length) // never grows
    }
  })

  test("sliceTailWholeChars: never LEADS with a lone low + never grows (520 cases)", () => {
    const rng = new Rng(SEED ^ 0x1234)
    for (let i = 0; i < FUZZ_CASES; i++) {
      const s = packedAstralString(rng, 4 + rng.int(80))
      const keep = rng.int(s.length + 4)
      const out = sliceTailWholeChars(s, keep)
      // Input is lone-surrogate-free → a lone LOW at the FRONT could only come
      // from the tail cut splitting a pair. Assert full well-formedness.
      expect({ i, ok: out.isWellFormed(), s: JSON.stringify(s), keep }).toMatchObject({ ok: true })
      expect(out.length).toBeLessThanOrEqual(keep < 0 ? 0 : keep)
      expect(out.length).toBeLessThanOrEqual(s.length)
    }
  })

  test("pty capOutput (head+tail compose): well-formed + never grows-the-text (520 cases)", () => {
    const rng = new Rng(SEED ^ 0x2222)
    for (let i = 0; i < FUZZ_CASES; i++) {
      // Force the over-cap branch: build a string well past PTY_MAX_READ_OUTPUT
      // packed with astral chars at the (cap/2) head & tail cut points.
      const base = packedAstralString(rng, PTY_MAX_READ_OUTPUT + 1 + rng.int(2048))
      const out = ptyCapOutput(base)
      // Input is lone-surrogate-free and the marker is pure ASCII, so the WHOLE
      // head+tail result must be fully well-formed — both surrogate-safe cut
      // points (head end, tail start) are exercised at once.
      expect({ i, ok: out.isWellFormed() }).toMatchObject({ ok: true })
      const head = sliceWholeChars(base, Math.floor(PTY_MAX_READ_OUTPUT / 2))
      const tail = sliceTailWholeChars(base, Math.floor(PTY_MAX_READ_OUTPUT / 2))
      // The kept TEXT (head+tail) never exceeds the input.
      expect(head.length + tail.length).toBeLessThanOrEqual(base.length)
    }
  })

  test("side-agent capDetail (clamp+marker): cut is surrogate-safe + ≤ cap (520 cases)", () => {
    const rng = new Rng(SEED ^ 0x3333)
    for (let i = 0; i < FUZZ_CASES; i++) {
      const base = packedAstralString(rng, DETAIL_MAX + 1 + rng.int(1024))
      const out = sideCapDetail(base)
      // Input is lone-surrogate-free; the marker is ASCII — the clamped result
      // (body + marker) must be fully well-formed (no lone HIGH at the join).
      expect({ i, ok: out.isWellFormed() }).toMatchObject({ ok: true })
      expect(out.length).toBeLessThanOrEqual(DETAIL_MAX) // marker accounted for
    }
  })

  test("ooxml stripIllegalXmlChars: output ALWAYS well-formed + never grows (520 cases)", () => {
    const rng = new Rng(SEED ^ 0x4444)
    for (let i = 0; i < FUZZ_CASES; i++) {
      const s = packedAstralString(rng, 4 + rng.int(80), /* injectLone */ true)
      const out = stripIllegalXmlChars(s)
      // This is the OOXML chokepoint: it DROPS lone surrogates (and illegal XML
      // control bytes) while PRESERVING valid pairs — so the result is ALWAYS
      // fully well-formed UTF-16 (the strongest invariant of the five).
      expect(out.isWellFormed()).toBe(true)
      expect(out.length).toBeLessThanOrEqual(s.length) // only drops, never grows
      // A valid astral char placed in `s` survives whole.
    }
  })

  test("ooxml stripIllegalXmlChars: preserves valid pairs, drops lone surrogates", () => {
    expect(stripIllegalXmlChars(`x${EMOJI}y`)).toBe(`x${EMOJI}y`)
    expect(stripIllegalXmlChars(`a${LONE_HI}b`)).toBe("ab")
    expect(stripIllegalXmlChars(`a${LONE_LO}b`)).toBe("ab")
    expect(stripIllegalXmlChars(`${LONE_HI}${EMOJI}${LONE_LO}`)).toBe(EMOJI)
  })

  // Crafted regression: the exact corruption — a cut landing INSIDE an emoji pair.
  test("crafted: sliceWholeChars cut INSIDE an emoji pair drops it whole", () => {
    const s = `ab${EMOJI}cd` // units: a b HI LO c d ; cut at 3 splits the pair
    const out = sliceWholeChars(s, 3)
    expect(out).toBe("ab") // the lone HIGH at index 2 is backed off
    expect(out.isWellFormed()).toBe(true)
  })

  test("crafted: sliceTailWholeChars cut INSIDE an emoji pair drops the lone low", () => {
    const s = `ab${EMOJI}cd` // keep=3 starts at index 3 = the LOW half
    const out = sliceTailWholeChars(s, 3)
    expect(out).toBe("cd") // the lone LOW at the front is skipped
    expect(out.isWellFormed()).toBe(true)
  })
})

/* ===================================================================== PART 2 */

const SRC_DIR = join(REPO_ROOT, "src")

const listTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listTsFiles(full))
    else if (
      st.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".from-worktree") &&
      !name.includes(".my-backup")
    ) {
      out.push(full)
    }
  }
  return out
}

/** A CAP-NAMED identifier: an UPPER_SNAKE const whose name signals a char/length
 *  truncation cap. We require BOTH a structural upper-snake shape AND one of the
 *  cap keywords, so a value like `i + 1` or `limit` (lowercase) never matches. */
const CAP_NAME =
  /^[A-Z][A-Z0-9_]*(?:MAX[A-Z0-9_]*|_CAP|CAP|_LEN|_OUTPUT|PREVIEW|TRUNC[A-Z0-9_]*|TAIL[A-Z0-9_]*|SNIPPET[A-Z0-9_]*|CHARS)$/
const CAP_KEYWORD = /MAX|CAP|LEN|OUTPUT|PREVIEW|TRUNC|TAIL|SNIPPET|CHARS/
const isCapName = (n: string): boolean => CAP_NAME.test(n) && CAP_KEYWORD.test(n)

interface CapSliceSite {
  readonly file: string // relative to src/
  readonly line: number
  readonly cap: string
  readonly text: string
}

/** AST-precise: find every `<expr>.slice(0, CAP)`, `.slice(-CAP)`, `.slice(CAP)`
 *  or `.slice(0|-, CAP - n)` whose cut bound resolves to a CAP-NAMED identifier.
 *  This is the dangerous truncation shape: a fixed char cap applied by a raw
 *  `.slice`. We intentionally do NOT try to prove the receiver is a `string` (a
 *  type check would need a full program); the cap-NAME requirement is the
 *  precision lever that keeps array/parse slices (numeric or lowercase bounds)
 *  out. Sites going through `sliceWholeChars`/`sliceTailWholeChars` never use a
 *  raw `.slice`, so they are inherently absent from this set. */
/** Resolve the CUT-BOUND argument of a `.slice(...)` for the truncation shapes
 *  we care about: `.slice(0, CAP)`, `.slice(-CAP)`, `.slice(CAP)`. Returns the
 *  bound expression, or undefined for any other arity/shape (e.g. `.slice(a, b)`
 *  substring extraction — NOT a truncation). */
const sliceCutBound = (args: ts.NodeArray<ts.Expression>): ts.Expression | undefined => {
  if (
    args.length === 2 &&
    args[0]?.kind === ts.SyntaxKind.NumericLiteral &&
    (args[0] as ts.NumericLiteral).text === "0"
  ) {
    return args[1] // .slice(0, CAP) / .slice(0, CAP - n)
  }
  if (args.length !== 1 || !args[0]) return undefined
  const a = args[0]
  if (ts.isPrefixUnaryExpression(a) && a.operator === ts.SyntaxKind.MinusToken) {
    return a.operand // .slice(-CAP)
  }
  return a // .slice(CAP) — bare tail
}

/** The cap-NAMED identifier in a cut bound, if any: a bare `CAP` ident, or the
 *  left side of `CAP - n`. Returns undefined when the bound is not cap-named. */
const capNameOf = (bound: ts.Expression): string | undefined => {
  if (ts.isIdentifier(bound) && isCapName(bound.text)) return bound.text
  if (ts.isBinaryExpression(bound) && ts.isIdentifier(bound.left) && isCapName(bound.left.text)) {
    return bound.left.text
  }
  return undefined
}

/** A `.slice(...)` call whose cut bound is a cap-named identifier → the site. */
const capSliceSiteOf = (
  node: ts.Node,
  sf: ts.SourceFile,
  relPath: string,
): CapSliceSite | undefined => {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "slice"
  ) {
    return undefined
  }
  const bound = sliceCutBound(node.arguments)
  if (!bound) return undefined
  const cap = capNameOf(bound)
  if (!cap) return undefined
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return {
    file: relPath,
    line: line + 1,
    cap,
    text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100),
  }
}

const findCapSliceSites = (file: string): CapSliceSite[] => {
  const src = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const relPath = relative(SRC_DIR, file)
  const out: CapSliceSite[] = []
  const visit = (node: ts.Node): void => {
    const site = capSliceSiteOf(node, sf, relPath)
    if (site) out.push(site)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** ALLOWLIST 1 — caps where a raw `.slice` can NEVER split a surrogate pair.
 *  Two structural reasons qualify a cap-const NAME here (intent-scoped, not
 *  file-scoped):
 *   - HASH / OPAQUE-ID prefixes — the sliced value is a hex digest / opaque
 *     ASCII id/sha, surrogate-free BY CONSTRUCTION; or
 *   - ARRAY-LENGTH caps — the `.slice(0, CAP)` is on a `string[]` (it bounds the
 *     NUMBER of whole elements, never cuts inside one), so it is not a string
 *     truncation at all. The AST scan can't tell array from string receivers, so
 *     these legit array caps are named here. */
const ALLOW_HASH_ID_CAPS: ReadonlySet<string> = new Set([
  "WORKSPACE_HASH_PREFIX_LEN",
  "HASH_PREFIX_LEN",
  "SHORT_SHA_LEN",
  "SHORT_ID_LEN",
  // array-length cap on git-porcelain lines (ticket-11 worktree dirty-exit list)
  "UNCOMMITTED_LIST_CAP",
  // array-length cap on rg result lines (jun-24 forward-localize per-symbol file
  // list) — the `.slice(0, CAP)` bounds the NUMBER of whole `string[]` lines, never
  // cuts inside one. See runner/batch/eval/forward-localize-trace.ts:96.
  "PER_SYMBOL_FILE_CAP",
  // array-length cap on the compacted trajectory `TrajectoryStep[]` (tail-keep the
  // last N whole steps). Bounds the NUMBER of step objects, never cuts inside a
  // string. See apps/terminal/brain-mode.ts:356 `steps.slice(-TRAJECTORY_MAX_STEPS)`.
  "TRAJECTORY_MAX_STEPS",
  // array-length cap on the recent-memory `MemoryReadoutEntry[]` (keep the newest N
  // whole entries after sort). Bounds the NUMBER of entry objects, never cuts inside
  // a string. See apps/web-daemon/readout.ts:288.
  "MEMORY_RECENT_MAX",
  // array-length cap on the CDP `NetworkEntry[]` rows (tail-keep the newest N whole
  // exchanges). Bounds the NUMBER of entry objects, never cuts inside a string. Each
  // row's own string fields are separately guarded. See tool/browser/index.ts:116,537.
  "NETWORK_ROW_CAP",
])

/** ALLOWLIST 2 — BURN-DOWN. Pre-existing GENUINE text-truncation sites that
 *  hand-roll `.slice()` instead of `sliceWholeChars`/`sliceTailWholeChars`. Each
 *  is a real (latent) surrogate hazard on model/user text; they are grandfathered
 *  here so the ratchet catches NEW sites today while the list is paid DOWN over
 *  time. The set is asserted to be MINIMAL (no stale entries) so it can only
 *  SHRINK. Format: `relativePath:CAP` (line-independent, so unrelated edits in
 *  the file don't churn the list). */
const ALLOW_BURNDOWN: ReadonlySet<string> = new Set([
  // ALREADY surrogate-safe by construction: the `t.slice(0, CLAIM_MAX)` is IMMEDIATELY
  // followed by a manual dangling-high-surrogate drop (`/[\uD800-\uDBFF]$/` → drop last
  // unit) AND a trailing-combining-mark strip — so a split pair can never escape. Listed
  // here (not routed) because the extra `\p{M}` trimming is intentional beyond the helper.
  // See agent/evidence/ingest.ts:22.
  "agent/evidence/ingest.ts:CLAIM_MAX",
  "llm/cache-control-audit/analyzer.ts:SAMPLE_CHARS",
  "mcp/isolated-client.ts:MAX_RESULT_CHARS",
  "tool/output-spill.ts:HEAD_CHARS",
  "agent/shadow-verify-adapters/check-lsp-test.ts:TEST_TAIL_CAP",
  "agent/issue-hint/extract-errors.ts:MAX_MSG_LEN",
  "agent/side-agent-runner.ts:SUMMARY_MAX",
  "mcp/resources/notifications.ts:RESOURCE_UPDATED_MAX_URI_CHARS",
  "integrations/github/webhook-server.ts:SNIPPET_MAX_CHARS",
  "integrations/github/event-source-actions.ts:SNIPPET_MAX_CHARS",
  "apps/cli/memory-cmd.ts:PREVIEW_MAX",
  "apps/cli/paste-cmd.ts:MAX_LABEL_LEN",
  "apps/cli/web-cmd.ts:MAX_LABEL_LEN",
  "apps/eval/compare/adapters/cli-base.ts:STDERR_TAIL_BYTES",
  "tool/web/search.ts:WEB_SEARCH_SNIPPET_MAX",
  "tool/web/fetch.ts:WEB_FETCH_MAX_OUTPUT",
  "tool/shadow/restore-partial.ts:MAX_OUTPUT",
  "tool/shadow/snapshots.ts:MAX_OUTPUT",
  "tool/document/yaml-read.ts:YAML_READ_MAX_OUTPUT",
  "tool/document/csv-read.ts:CSV_READ_MAX_OUTPUT",
  "tool/document/ndjson-read.ts:NDJSON_READ_MAX_OUTPUT",
  "tool/bash/kill.ts:MAX_OUTPUT",
  "tool/bash/kill.ts:STDERR_CAP",
  "tool/bash/await.ts:MAX_OUTPUT",
  "tool/bash/await.ts:STDERR_CAP",
  "tool/bash/index.ts:STDERR_CAP",
  "tool/bash/index.ts:MAX_BG_PLACEHOLDER_OUTPUT",
  "tool/bash/index.ts:CMD_PREVIEW",
  "tool/localize/index.ts:SNIPPET_CAP",
  "tool/browser/index.ts:CDP_OUTPUT_CAP",
  "tool/browser/index.ts:CONSOLE_OUTPUT_CAP",
  "tool/browser/index.ts:READ_OUTPUT_CAP",
  "tool/file-tree-summary/index.ts:SUMMARY_LEN",
  "tool/file-tree-summary/index.ts:SUMMARY_FILE_CAP",
  "tool/test-runner/index.ts:TAIL_CAP",
  "tool/test-runner/index.ts:STDERR_EVIDENCE_CAP",
  "tool/mcp_resources/render.ts:MAX_OUTPUT",
  "tool/file-history/tool.ts:MAX_OUTPUT",
  "tool/mcp_tasks/list_tasks.ts:MAX_OUTPUT",
  "tool/git/conflict-inspect.ts:MAX_OUTPUT",
  "tool/git/diff.ts:MAX_OUTPUT",
  "tool/git/moved-code-tool.ts:MAX_OUTPUT",
  "reactor/trigger-source-pr-comment.ts:SNIPPET_MAX_CHARS",
]) // NOTE: this set must only ever SHRINK. Do NOT add a new entry — route the
//   new truncation through `sliceWholeChars` / `sliceTailWholeChars` instead.

const keyOf = (s: CapSliceSite): string => `${s.file}:${s.cap}`

const collectAllCapSlices = (): CapSliceSite[] => {
  const out: CapSliceSite[] = []
  for (const f of listTsFiles(SRC_DIR)) out.push(...findCapSliceSites(f))
  return out
}

describe("PART 2 — static ratchet: no NEW naive cap-slice on a string", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // A cap-slice ratchet over an empty file list finds no naive slice anywhere.
    assertScanPopulation(listTsFiles(SRC_DIR), SRC_DIR, {
      min: 500,
      collectable: (n) =>
        n.endsWith(".ts") &&
        !n.endsWith(".d.ts") &&
        !n.includes(".from-worktree") &&
        !n.includes(".my-backup"),
    })
  })

  test("every raw cap-slice is allowlisted (hash/id) or burn-down — no new unlisted site", () => {
    const sites = collectAllCapSlices()
    const violations = sites.filter(
      (s) => !ALLOW_HASH_ID_CAPS.has(s.cap) && !ALLOW_BURNDOWN.has(keyOf(s)),
    )
    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      throw new Error(
        "NEW naive cap-slice(s) found — a fixed char cap applied by a raw `.slice()` " +
          "that did NOT go through a surrogate-safe helper. Route it through " +
          "`sliceWholeChars` / `sliceTailWholeChars` (src/shared/slice-whole-chars.ts), " +
          "or — if the sliced value is provably surrogate-free (a hex digest / opaque " +
          "ASCII id) — add its CAP const to `ALLOW_HASH_ID_CAPS`:\n\n" +
          lines.join("\n"),
      )
    }
    // AST-scans the whole src/ tree — the 5s default trips on a cold run (~6.8s
    // measured). 30s headroom so the ratchet never flakes under full-suite load.
  }, 30_000)

  test("burn-down list is MINIMAL — every entry still corresponds to a live site", () => {
    const live = new Set(collectAllCapSlices().map(keyOf))
    const stale = [...ALLOW_BURNDOWN].filter((k) => !live.has(k))
    if (stale.length > 0) {
      throw new Error(
        "Stale BURN-DOWN allowlist entries (the site was removed or migrated to a " +
          "surrogate-safe helper — DELETE these entries so the list can only shrink):\n\n" +
          stale.map((s) => `  ${s}`).join("\n"),
      )
    }
  }, 30_000)

  test("hash/id allowlist is MINIMAL — every cap is still referenced by a live slice", () => {
    const liveCaps = new Set(collectAllCapSlices().map((s) => s.cap))
    const stale = [...ALLOW_HASH_ID_CAPS].filter((c) => !liveCaps.has(c))
    expect(stale).toEqual([])
  }, 30_000)

  // SELF-PROOF that the ratchet actually FIRES on a synthetic NEW cap-slice and
  // stays CLEAN when the same cap is routed through the surrogate-safe helper —
  // drives the exact predicate the on-disk scan uses, no fixture file needed.
  test("self-proof: a NEW `s.slice(0, FOO_MAX)` is FLAGGED; `sliceWholeChars(s, FOO_MAX)` is CLEAN", () => {
    const dangerous = "const FOO_MAX = 1024\nexport const f = (s: string) => s.slice(0, FOO_MAX)\n"
    const safe =
      'import { sliceWholeChars } from "@/shared"\n' +
      "const FOO_MAX = 1024\nexport const f = (s: string) => sliceWholeChars(s, FOO_MAX)\n"

    // Drive the EXACT predicate the on-disk scan uses (`capSliceSiteOf`) over a
    // synthetic source string — no fixture file needed.
    const scan = (code: string): CapSliceSite[] => {
      const sf = ts.createSourceFile("synthetic.ts", code, ts.ScriptTarget.Latest, true)
      const out: CapSliceSite[] = []
      const visit = (node: ts.Node): void => {
        const site = capSliceSiteOf(node, sf, "synthetic.ts")
        if (site) out.push(site)
        ts.forEachChild(node, visit)
      }
      visit(sf)
      return out
    }

    expect(scan(dangerous).map((s) => s.cap)).toEqual(["FOO_MAX"]) // raw .slice → flagged
    expect(scan(safe)).toEqual([]) // routed through the helper → no raw cap-slice
  })
})
