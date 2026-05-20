/**
 * Anti-regression scanner — pins the "no silent fallback / no heuristic"
 * contract for the eval app at the SOURCE level.
 *
 * Why a scanner instead of biome rules: the patterns we want to ban are
 * semantic ("silent catch that returns a default" vs "explicit error-surface
 * catch") and biome has no rule that distinguishes them. A targeted regex
 * scan over `src/apps/eval/**` with file-level allowlists is the smallest
 * machine-checkable expression of the policy.
 *
 * Each rule has:
 *   - a clear violation pattern (regex over file contents)
 *   - a rationale string (why this is banned)
 *   - an allowlist of files where the pattern is justified (with reason)
 *
 * Adding a new file under `src/apps/eval/`? The scan runs against it
 * automatically. If you legitimately need a banned pattern, document why and
 * add the path to that rule's allowlist below — that is the audit trail.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const ROOT = join(__dirname, "..", "..", "src", "apps", "eval")

interface Rule {
  /** Stable id used in failure messages. */
  id: string
  /** Regex matched against each scanned file's contents. */
  pattern: RegExp
  /** Why this pattern is banned (printed on violation). */
  why: string
  /** Repo-relative paths where the pattern is permitted (with a justification
   *  string the author has signed off on). */
  allowlist?: Record<string, string>
}

const RULES: readonly Rule[] = [
  {
    id: "no-silent-empty-catch",
    pattern: /catch\s*\{\s*\}/,
    why: "Empty catch swallows errors without logging or surfacing — use `catch (e) { logger.warn(...); }` or rethrow.",
    allowlist: {
      "compare/adapters/cli-base.ts":
        "child.stdin.end() inside finally — best-effort close on an already-closed pipe is benign",
    },
  },
  {
    id: "no-math-random",
    pattern: /Math\.random\(/,
    why: "Use `node:crypto.randomBytes` for run-ids / nonces — Math.random's collision space is too small for parallel runs.",
  },
  {
    id: "no-posix-slash-path-split",
    pattern: /\.split\(["']\/["']\)/,
    why: "Use `node:path.basename`/`relative` instead of splitting on POSIX `/` — the latter breaks on Windows.",
    allowlist: {
      "compare/pairwise-judge.ts": "string scan over JSON braces, not a path operation",
    },
  },
  {
    id: "no-undocumented-magic-timeout",
    // 5_000 / 30_000 / 60_000 / 120_000 / 180_000 / 240_000 number literals
    // outside a `const UPPER_SNAKE_CASE = ...` declaration — force operators
    // to bind a named constant before passing the literal to setTimeout/spawn.
    pattern:
      /(?<!const\s+[A-Z][A-Z_0-9]*\s*=\s*)(?<![A-Z_0-9])(?:5_000|30_000|60_000|120_000|180_000|240_000)(?!\d)/,
    why: "Wall-clock magic numbers must be bound to a named UPPER_SNAKE_CASE `const` with a comment explaining the choice.",
  },
  {
    id: "no-as-type-assertion-on-unknown-payload",
    // `as EvalRecord` (or any sketchy as-cast on a freshly-parsed JSON value)
    // — payloads must go through a validator (`isKnownPayloadKind`, schema parse)
    // BEFORE being cast.
    pattern: /\bas\s+EvalRecord\b/,
    why: "Cast to EvalRecord must follow `isKnownPayloadKind` validation — otherwise an unknown kind silently corrupts the report.",
    allowlist: {
      "storage/result-store.ts":
        "the cast is the LAST step of the validated readOne() generator after isKnownPayloadKind passes",
    },
  },
  {
    id: "no-coerce-config-to-default",
    // `?? "software-quality."` — hardcoded leaf-id fallback string in code
    // (not in a constant). Catches the swebench `mapping?.primary ?? "..."`
    // anti-pattern.
    pattern: /\?\?\s*["']software-quality\./,
    why: "Hardcoded UseCaseId fallbacks mask mapping-table errors — throw on missing mapping instead.",
  },
]

const isAllowed = (rule: Rule, relativePath: string): boolean =>
  rule.allowlist !== undefined && Object.hasOwn(rule.allowlist, relativePath)

const walk = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (extname(name) === ".ts") out.push(full)
  }
  return out
}

const scanFile = (path: string): readonly { rule: Rule; lineNo: number; line: string }[] => {
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n")
  const violations: { rule: Rule; lineNo: number; line: string }[] = []
  const relPath = relative(ROOT, path)
  for (const rule of RULES) {
    if (isAllowed(rule, relPath)) continue
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      // Skip lines inside JSDoc / line comments — the patterns are about
      // executable code, not prose explaining the policy.
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue
      }
      if (rule.pattern.test(line)) {
        violations.push({ rule, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return violations
}

describe("eval source: anti-regression scan", () => {
  const files = walk(ROOT).filter((f) => !f.includes("/scenarios/"))

  test("every TS file scans clean against the lazy-pattern allowlist", () => {
    const failures: string[] = []
    for (const f of files) {
      const v = scanFile(f)
      for (const { rule, lineNo, line } of v) {
        failures.push(`${relative(ROOT, f)}:${lineNo}  [${rule.id}]  ${line}\n    → ${rule.why}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Anti-regression scan tripped ${failures.length} violation(s) in src/apps/eval/:\n\n${failures.join("\n\n")}`,
      )
    }
    expect(failures.length).toBe(0)
  })

  test("scan covers a non-empty file set (smoke)", () => {
    expect(files.length).toBeGreaterThan(20)
  })
})
