/**
 * TYPED RESOURCE CLAIMS — what a test file may touch that another file can see.
 *
 * # The defect this replaces
 *
 * `classifyTestResource` returned the FIRST regex that matched. A file that
 * opens a port AND rewrites `process.env` was recorded as whichever pattern
 * happened to be listed earlier, and the later hazard became invisible to the
 * scheduler — not "considered and allowed", but never represented at all.
 * Measured on this tree at the time of writing: 130 of the 3,950 discovered
 * files match more than one class detector, so 130 files were carrying a
 * hazard the plan could not name.
 *
 * A claim SET has no such ordering. Every detector that fires contributes a
 * claim; the legacy class is a PROJECTION of the same evidence (the first
 * detector that carries a `classSignal`), which is why the class values are
 * byte-identical to the ones the first-match classifier produced —
 * `tests/unit/dev/test-resource-claims.test.ts` proves that over the whole
 * discovered corpus, not over a sample.
 *
 * # Over-approximation is the safe direction
 *
 * Detection runs on RAW source: a commented-out `Bun.spawn` still contributes
 * `child-process`. That costs a little parallelism and can never invent a
 * missing serialization, whereas comment-stripping can only ever remove a
 * claim — and removing a claim is what corrupts a peer. The one thing we do
 * NOT do is infer a claim from a FILE NAME; every claim here names a construct
 * that appears in source.
 */

export const RESOURCE_CLAIM_KINDS = [
  /** The repository working tree of this checkout. */
  "checkout",
  /** `.git` itself: worktree list, index, refs — shared by every worktree. */
  "git-common",
  /** The shared verification cache (`.cache`, receipt/timing stores). */
  "cache",
  /** A TCP port, or the ephemeral port space when the number is not literal. */
  "port",
  /** A browser user-data directory / a live CDP target. */
  "browser-profile",
  /** A language-server workspace and its on-disk index. */
  "lsp-workspace",
  /** `process.env` / cwd of the worker process. */
  "process-env",
  /** Descendant processes: they compete for pids, fds and CPU. */
  "child-process",
  /** The host Docker daemon. */
  "docker-daemon",
  /** Host CPU. Shared by default; `exclusive` means "no peer at all". */
  "host-cpu",
  /** Host RAM, for fixtures large enough to page a peer out. */
  "host-memory",
  /**
   * "This file may hold resources nobody enumerated."
   *
   * NOT a resource — a statement about the evidence. It is what every
   * uncertified file carries, and it is why an uncertified file may still
   * overlap a file that holds NOTHING while never overlapping one that holds
   * something.
   */
  "unknown",
] as const

export type ResourceClaimKind = (typeof RESOURCE_CLAIM_KINDS)[number]
export type ResourceClaimMode = "shared" | "exclusive"

export interface ResourceClaim {
  /** `kind` or `kind:scope`, e.g. `port:4317`, `process-env:QUANTA_HOME`. */
  readonly key: string
  readonly mode: ResourceClaimMode
}

const CLAIM_KINDS: ReadonlySet<string> = new Set(RESOURCE_CLAIM_KINDS)

/** The vocabulary term a raw key belongs to. `port:4317` -> `port`. */
export const resourceClaimKind = (key: string): ResourceClaimKind | undefined => {
  const kind = key.split(":")[0] ?? ""
  return CLAIM_KINDS.has(kind) ? (kind as ResourceClaimKind) : undefined
}

export const isResourceClaimKey = (key: string): boolean =>
  resourceClaimKind(key) !== undefined &&
  !key.includes("..") &&
  /^[a-z][a-z0-9-]*(?::\S+)?$/u.test(key)

/**
 * Resource classes, kept because the runner, the membership buckets and the
 * cache identity are all keyed on them. They are now derived, not primary:
 * see `resourceClaimsFor`.
 */
export const TEST_RESOURCE_CLASSES = [
  "pure",
  "worktree",
  "repo-write",
  "browser",
  "lsp",
  "port",
  "process-global",
  "integration-path",
] as const

export type TestResourceClass = (typeof TEST_RESOURCE_CLASSES)[number]

interface ClaimDetector {
  readonly key: string
  readonly mode: ResourceClaimMode
  readonly pattern: RegExp
  /**
   * Set on the six detectors that the legacy first-match classifier used, in
   * its exact order. Everything else contributes claims only, so adding a
   * detector can never move a file between classes (and therefore can never
   * silently re-cut a chunk's membership or invalidate its cache receipt).
   */
  readonly classSignal?: TestResourceClass
  /**
   * Run against source with whole-line comments removed.
   *
   * ONLY the `unknown` detector sets this, and only because its direction of
   * error is the opposite of every other detector's. Over-claiming a resource
   * costs parallelism; over-claiming `unknown` costs the entire certification.
   * Measured: the phrase "…import (keeps…" and nine other English sentences in
   * doc comments — plus one `d.eval(js)` CDP METHOD — made eleven production
   * modules opaque, and through them 331 of the 562 integration-path files.
   * A comment cannot execute, so removing comment LINES cannot hide a
   * construct that runs; every other detector still reads raw source, where a
   * commented-out `Bun.spawn` costs nothing but a serialization.
   */
  readonly ignoreComments?: boolean
}

/**
 * The six class detectors, verbatim from the first-match classifier, in its
 * order — followed by the claim-only detectors it never had.
 *
 * The comments on the first four are the measured reasons they are worded the
 * way they are; they are preserved because each one names a defect that was
 * paid for once already.
 */
const CLAIM_DETECTORS: readonly ClaimDetector[] = [
  // Shell form ("git worktree add …") AND argv-array form (["worktree", "add"]).
  {
    key: "git-common",
    mode: "exclusive",
    pattern: /\bgit\s+worktree\b|\bworktree\b[^\n]{0,40}\b(?:add|remove|prune|lock)\b/,
    classSignal: "worktree",
  },
  {
    key: "checkout",
    mode: "exclusive",
    pattern:
      /\b(?:writeFileSync|rmSync|renameSync|unlinkSync)\s*\([^\n]*(?:REPO_ROOT|repoRoot|process\.cwd\s*\(\s*\))/,
    classSignal: "repo-write",
  },
  // `REAL_CHROME` is this repo's own real-spawn gate: the browser e2e flips it
  // only once a live CDP session exists. It is listed because the four tokens
  // beside it are OTHER projects' vocabulary — our CDP adapter says `cdp` and
  // `chrome`, so the one test that actually spawns Chrome scored zero matches
  // and got overlapped with 135 integration files (2026-09-02 gate audit: a 60s
  // navigate timeout that reproduces 0/4 in isolation). Deliberately NOT a bare
  // /cdp|chrome/ — that reclassifies 56 files, nearly all pure unit tests with
  // no browser, and serializes the suite for nothing.
  {
    key: "browser-profile",
    mode: "exclusive",
    pattern: /puppeteer|playwright|chromium|--headless|REAL_CHROME/i,
    classSignal: "browser",
  },
  {
    key: "lsp-workspace",
    mode: "exclusive",
    pattern: /\b(?:typescript-language-server|pyright|rust-analyzer|gopls|lldb|lsp)\b/i,
    classSignal: "lsp",
  },
  {
    key: "port:ephemeral",
    mode: "exclusive",
    pattern:
      /\bBun\.listen\s*\(|\b(?:createServer|createConnection)\s*\(|\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/,
    classSignal: "port",
  },
  {
    key: "process-env",
    mode: "exclusive",
    pattern:
      /\b(?:killProcessTree|process\.kill)\s*\(|\b(?:QUANTA_HOME|QUANTA_BENCH_HOME|process\.env\.HOME)\b/,
    classSignal: "process-global",
  },

  // ── claim-only detectors: hazards the first-match classifier could not see ──

  // `exec(` is deliberately absent: `RegExp.prototype.exec` is everywhere in
  // this corpus and would claim a child process for every parser test.
  {
    key: "child-process",
    mode: "shared",
    pattern:
      /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|execFileSync|execFile|execSync)\s*\(|\bBun\.\$\s*`|\bfrom\s+["']node:child_process["']/,
  },
  { key: "port:ephemeral", mode: "exclusive", pattern: /\bBun\.serve\s*\(|\bnew\s+WebSocket\s*\(/ },
  {
    key: "process-env",
    mode: "exclusive",
    pattern:
      /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]|\bdelete\s+process\.env|\bprocess\.env\[[^\]]+\]\s*=[^=]|\bprocess\.chdir\s*\(/,
  },
  { key: "checkout", mode: "exclusive", pattern: /\bgit\s+(?:add|commit|checkout|reset|stash)\b/ },
  { key: "git-common", mode: "exclusive", pattern: /\.git\/(?:config|index|HEAD|refs)\b/ },
  {
    key: "cache",
    mode: "exclusive",
    pattern: /\bsharedVerificationCacheRoot\s*\(|\bQUANTA_CACHE|\/\.cache\//,
  },
  {
    key: "docker-daemon",
    mode: "exclusive",
    pattern:
      /\bdocker(?:\s+(?:run|compose|build|ps|exec)|-compose)\b|\bDOCKER_HOST\b|testcontainers/i,
  },
  { key: "browser-profile", mode: "exclusive", pattern: /--user-data-dir/ },
  {
    key: "host-memory",
    mode: "shared",
    pattern: /\bBuffer\.alloc(?:Unsafe)?\s*\(\s*\d{8,}|\bnew\s+Array\s*\(\s*\d{8,}/,
  },
  // Constructs whose effects cannot be read from source at all. These are the
  // ONLY source of `unknown` inside a file's own claims; everything else is a
  // named resource or nothing.
  {
    key: "unknown",
    mode: "exclusive",
    ignoreComments: true,
    // The template alternative matters: `import(\`${spec}\`)` starts with a
    // quote character, so a bare "not a quote" lookahead reads it as a static
    // import and the specifier is never known.
    //
    // A template WITH a static directory prefix — `import(\`./presets/${m}\`)`
    // — is deliberately NOT unknown: `test-resource-analysis.ts` follows every
    // module under that prefix, the same convention
    // `tools/feature-catalog/reachability.ts` already uses, so those modules'
    // claims are counted rather than erased. `[^`$/]*` is what draws that line:
    // it stops at the first `/`, so only a template whose FIRST segment is
    // interpolated is opaque.
    // `import(` with NO space, and `eval` with no `.` before it: prose writes
    // "import (keeps …" and a CDP session exposes an `eval` METHOD, so the
    // permissive forms matched sentences and method calls rather than opaque
    // constructs.
    // The whitespace sits INSIDE the lookahead. Written as `import\(\s*(?!")`
    // the engine simply backtracks `\s*` to zero width and the lookahead then
    // inspects the newline, so a multi-line `await import(\n  "@/x/y"\n)` —
    // 67 files' worth in `mention-symbol-deps.ts` — read as opaque.
    //
    // `eval\(` and `new\s+Function\(` take no space before the paren: prose
    // writes "Bench eval (T1, jun-24)" and 32 knob descriptions did. A typed
    // first parameter is excluded too, because `eval(expr: string, …)` in an
    // interface is a method DECLARATION, not a call.
    pattern:
      /(?<![.\w$])import\((?!\s*["'`])|(?<![.\w$])require\((?!\s*["'`])|(?<![.\w$])(?:import|require)\(\s*`[^`$/]*\$\{|(?<![.\w$])eval\((?!\s*\w+\s*:)|\bnew\s+Function\(/,
  },
]

/** `integration`/`e2e` naming, or a path that names a shared subsystem. */
const SHARED_RESOURCE_PATH =
  /(?:^|\/)(?:integration|e2e)(?:\/|$)|(?:git|worktree|mcp|lsp|server|socket|process-tree|multi-process)/i

/** The class a file gets from its PATH alone, when no detector fires. */
export const pathOnlyResourceClass = (file: string): TestResourceClass =>
  SHARED_RESOURCE_PATH.test(file) ? "integration-path" : "pure"

const MODE_RANK: Readonly<Record<ResourceClaimMode, number>> = { shared: 0, exclusive: 1 }

/** Merge claims: one row per key, the stricter mode wins. */
export const mergeResourceClaims = (
  ...sets: readonly (readonly ResourceClaim[])[]
): readonly ResourceClaim[] => {
  const byKey = new Map<string, ResourceClaimMode>()
  for (const set of sets) {
    for (const claim of set) {
      const current = byKey.get(claim.key)
      if (current === undefined || MODE_RANK[claim.mode] > MODE_RANK[current]) {
        byKey.set(claim.key, claim.mode)
      }
    }
  }
  return [...byKey.entries()]
    .map(([key, mode]) => ({ key, mode }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

export interface SourceResourceEvidence {
  readonly claims: readonly ResourceClaim[]
  /** The legacy class this source projects to, or undefined for path fallback. */
  readonly classSignal: TestResourceClass | undefined
}

/**
 * Every claim this source supports, plus the legacy class projection.
 *
 * ONE pass over the detector table produces both, so the class can never
 * disagree with the claims about the same source — the disagreement that made
 * `policy.resources` fiction for 359 files.
 */
/**
 * Whole-line comments removed, nothing else touched.
 *
 * Line-oriented on purpose: a lexer that tracks string state can mis-read one
 * apostrophe in a regex literal and swallow the code after it, which is the
 * failure mode that HIDES an effect. Dropping lines whose first non-space
 * characters are `//`, `/*` or `*` cannot do that.
 */
export const withoutCommentLines = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
    .join("\n")

export const resourceEvidenceFor = (source: string): SourceResourceEvidence => {
  const claims: ResourceClaim[] = []
  let classSignal: TestResourceClass | undefined
  let stripped: string | undefined
  for (const detector of CLAIM_DETECTORS) {
    if (detector.ignoreComments === true) stripped ??= withoutCommentLines(source)
    if (!detector.pattern.test(detector.ignoreComments === true ? (stripped ?? source) : source)) {
      continue
    }
    claims.push({ key: detector.key, mode: detector.mode })
    if (classSignal === undefined && detector.classSignal !== undefined) {
      classSignal = detector.classSignal
    }
  }
  // A real browser's hazard is the PEER's CPU appetite, not a resource kind:
  // measured 2026-09-02, a real-Chrome file lost an honoured, pressure-scaled
  // 60,000ms CDP budget by 1.88ms beside a 137-file `pure` chunk and passed
  // 3/3 alone. `host-cpu: exclusive` is that fact expressed as a claim, which
  // is what keeps the carve-out from being a special case in the scheduler.
  if (claims.some(({ key }) => key === "browser-profile")) {
    claims.push({ key: "host-cpu", mode: "exclusive" })
  }
  return { claims: mergeResourceClaims(claims), classSignal }
}

/** Source evidence wins over the path heuristic, exactly as before. */
export const resourceClassFor = (file: string, source: string): TestResourceClass =>
  resourceEvidenceFor(source).classSignal ?? pathOnlyResourceClass(file)

/**
 * What a LEGACY CLASS claims, for a file the registry has not certified.
 *
 * Every non-pure class carries `unknown`, and that is the honest content of
 * first-match classification: "one detector fired; nothing enumerated the
 * rest". It is also exactly what reproduces the shipped overlap matrix —
 * `pure` beside anything except a browser, every other pair serial — with no
 * validated-pair allowlist to keep in sync.
 */
export const CLASS_RESOURCE_CLAIMS: Readonly<Record<TestResourceClass, readonly ResourceClaim[]>> =
  {
    pure: [],
    "integration-path": [{ key: "unknown", mode: "exclusive" }],
    port: [
      { key: "port:ephemeral", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
    lsp: [
      { key: "lsp-workspace", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
    browser: [
      { key: "browser-profile", mode: "exclusive" },
      { key: "host-cpu", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
    worktree: [
      { key: "git-common", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
    "repo-write": [
      { key: "checkout", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
    "process-global": [
      { key: "process-env", mode: "exclusive" },
      { key: "unknown", mode: "exclusive" },
    ],
  }

const hasExclusiveHostCpu = (claims: readonly ResourceClaim[]): boolean =>
  claims.some(({ key, mode }) => key === "host-cpu" && mode === "exclusive")

const hasUnknown = (claims: readonly ResourceClaim[]): boolean =>
  claims.some(({ key }) => resourceClaimKind(key) === "unknown")

/** Does this set name anything a peer could collide with? */
export const holdsResource = (claims: readonly ResourceClaim[]): boolean =>
  claims.some(({ key }) => resourceClaimKind(key) !== "host-cpu")

const keysCompatible = (
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean => {
  const rightByKey = new Map(right.map((claim) => [claim.key, claim.mode]))
  return left.every((claim) => {
    const peer = rightByKey.get(claim.key)
    return peer === undefined || (claim.mode === "shared" && peer === "shared")
  })
}

/**
 * May these two claim sets execute at the same time?
 *
 * Three rules, in order:
 *
 *  1. `host-cpu: exclusive` tolerates NO peer. This is the browser carve-out,
 *     and it is first because CPU is the one resource a peer cannot opt out of.
 *  2. `unknown` on one side conflicts with a peer that HOLDS something. It does
 *     NOT conflict with a peer that holds nothing: a resource collision needs
 *     two parties, and this is what lets `pure` overlap the uncertified corpus
 *     exactly as it does today.
 *  3. Otherwise the ordinary lock rule — same key, both `shared`, or no key in
 *     common.
 *
 * Rule 2 is the whole reason certification buys anything: drop `unknown` by
 * enumerating a file's claims and it can overlap peers whose keys are disjoint.
 */
export const scheduleClaimsOverlap = (
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[],
): boolean => {
  if (hasExclusiveHostCpu(left) || hasExclusiveHostCpu(right)) return false
  if (hasUnknown(left) && holdsResource(right)) return false
  if (hasUnknown(right) && holdsResource(left)) return false
  return keysCompatible(left, right) && keysCompatible(right, left)
}
