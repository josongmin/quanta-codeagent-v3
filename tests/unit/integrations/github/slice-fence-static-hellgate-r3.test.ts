/**
 * ADR-0311 / 0313 hellgate R3 — slice-fence static invariants.
 *
 * The `@/integrations/github` slice is a LEAF; it may import only:
 *   - `@/reactor` (types it consumes — ProactiveTrigger / GhCliPort / EnvPort
 *     / ClockPort),
 *   - `node:crypto` (HMAC + sha hashing),
 *   - sibling files in the same slice (`./*`).
 *
 * One carve-out: `webhook-transports.ts` is the dedicated boundary file for
 * the Tier-1 HTTP server adapters (ADR-0312); it MAY additionally import
 * `node:http`. Every other slice file remains port-only. (Same pattern as
 * `from-pr-cmd-adapters.ts` for the gh-CLI side.)
 *
 * Anything else is a fence breach.  In particular the slice MUST NOT import
 * from `@/agent`, `@/llm`, `@/permission`, `@/tool`, `@/apps`, `@/stream`,
 * `@/runner`, `@/skill`, `@/mcp`, `@/memory`, `@/storage`, `@/host`,
 * `@/kernel`, `@/protocol`, or `@/sdk`.  Direct `process.env` / `Bun.spawn`
 * / `node:fs` calls are also banned — every IO concern goes through a port.
 *
 * The `from-pr-cmd*.ts` CLI files live one layer up but follow a related
 * rule: the LIB (`from-pr-cmd.ts`) is port-only, the ADAPTERS file
 * (`from-pr-cmd-adapters.ts`) is the ONE permitted boundary that touches
 * node:fs / process.env / Bun.spawn / @/security/redaction.
 *
 * This test reads every slice file at runtime and asserts the invariant
 * with a regex pass over each file's import lines. A regression here
 * surfaces BEFORE the slice ships an accidental dependency on a heavy
 * trunk module.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertScanPopulation } from "../../_shared/scan-population"
import { stripComments } from "../../_shared/strip-comments"

// Repo-anchored on this file, not the ambient cwd — this fence reads real
// source out of the checkout.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SLICE_DIR = resolve(REPO_ROOT, "src/integrations/github")
const CLI_LIB = resolve(REPO_ROOT, "src/apps/cli/from-pr-cmd.ts")
const CLI_ADAPTERS = resolve(REPO_ROOT, "src/apps/cli/from-pr-cmd-adapters.ts")

/**
 * Path prefixes that MUST NOT appear anywhere on the LHS of an `import …
 * from "X"` in slice files. Each entry is a string literal that the
 * source-text scan looks for in import specifier position.
 */
const FORBIDDEN_TRUNK_PREFIXES: readonly string[] = [
  "@/agent",
  "@/llm",
  "@/permission",
  "@/tool",
  "@/apps",
  "@/stream",
  "@/runner",
  "@/skill",
  "@/mcp",
  "@/memory",
  "@/storage",
  "@/host",
  "@/kernel",
  "@/protocol",
  "@/sdk",
]

const NODE_FS_BANNED = [
  // `node:fs` / `node:fs/promises` direct import in slice files — banned
  // (FsPort is the seam). Adapters file lives one layer up; tested separately.
  /from\s+["']node:fs["']/,
  /from\s+["']node:fs\/promises["']/,
  /require\(["']node:fs/,
]

const PROCESS_ENV_RE = /\bprocess\.env\b/
const BUN_SPAWN_RE = /\bBun\.spawn\b/
const TIMING_SAFE_RE = /\btimingSafeEqual\b/

interface SliceFile {
  readonly absPath: string
  readonly relPath: string
  readonly content: string
}

const listSliceFiles = (): readonly SliceFile[] => {
  const out: SliceFile[] = []
  for (const entry of readdirSync(SLICE_DIR)) {
    const abs = join(SLICE_DIR, entry)
    if (!statSync(abs).isFile()) continue
    if (!entry.endsWith(".ts")) continue
    out.push({
      absPath: abs,
      relPath: entry,
      content: readFileSync(abs, "utf8"),
    })
  }
  return out
}

const SLICE_FILES: readonly SliceFile[] = listSliceFiles().map((f) => ({
  ...f,
  content: stripComments(f.content),
}))
/**
 * Read LAZILY, and a missing file is an assertion failure rather than a crash.
 *
 * These were module-scope `readFileSync` calls, so a corpus file that is not
 * there killed the file before a single test ran — bun reports that as
 * `1 fail`, indistinguishable from a real violation, and an empty-corpus oracle
 * credited the crash as "the guard noticed". It noticed nothing; it never
 * executed. Naming the absence is what makes the difference visible.
 */
const readSlice = (abs: string): string => {
  if (!existsSync(abs)) {
    throw new Error(
      `${abs.slice(REPO_ROOT.length + 1)} is missing — this guard's verdict is derived ` +
        `from its contents, so there is nothing to check rather than nothing wrong.`,
    )
  }
  return stripComments(readFileSync(abs, "utf8"))
}
const CLI_LIB_TEXT = (): string => readSlice(CLI_LIB)
const CLI_ADAPTERS_TEXT = (): string => readSlice(CLI_ADAPTERS)

describe("ADR-0311 hellgate R3 — slice fence (static)", () => {
  test("slice dir is non-empty (sanity)", () => {
    assertScanPopulation(
      SLICE_FILES.map((file) => file.absPath),
      SLICE_DIR,
      {
        id: "tests/unit/integrations/github/slice-fence-static-hellgate-r3.test.ts#SLICE-DIR",
        collectable: (name) => name.endsWith(".ts"),
        topLevelOnly: true,
      },
    )
    expect(SLICE_FILES.length).toBeGreaterThan(0)
  })

  test("no slice file imports a forbidden trunk module", () => {
    const offenders: string[] = []
    for (const f of SLICE_FILES) {
      for (const banned of FORBIDDEN_TRUNK_PREFIXES) {
        // Use exact specifier match: `"@/agent"` or `"@/agent/anything"`.
        // We must not flag a comment that mentions the path (look at import
        // lines only) — scan for the regex `from\s+["']<banned>(/|["'])`.
        const re = new RegExp(`from\\s+["']${banned.replace(/[/]/g, "\\/")}(?:\\/|["'])`)
        if (re.test(f.content)) offenders.push(`${f.relPath} imports ${banned}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("no slice file calls process.env directly (use EnvPort)", () => {
    const offenders = SLICE_FILES.filter((f) => PROCESS_ENV_RE.test(f.content))
    expect(offenders.map((f) => f.relPath)).toEqual([])
  })

  test("no slice file calls Bun.spawn directly (use GhCliPort)", () => {
    const offenders = SLICE_FILES.filter((f) => BUN_SPAWN_RE.test(f.content))
    expect(offenders.map((f) => f.relPath)).toEqual([])
  })

  test("no slice file imports node:fs (use FsPort)", () => {
    const offenders: string[] = []
    for (const f of SLICE_FILES) {
      for (const re of NODE_FS_BANNED) {
        if (re.test(f.content)) {
          offenders.push(f.relPath)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("timingSafeEqual is used ONLY in signature-verify.ts", () => {
    const users = SLICE_FILES.filter((f) => TIMING_SAFE_RE.test(f.content)).map((f) => f.relPath)
    expect(users).toEqual(["signature-verify.ts"])
  })

  test("every slice file with public surface routes through the index.ts barrel", () => {
    // Each non-index, non-types-only file MUST be re-exported by index.ts —
    // or it's dead/orphan code. We accept `types.ts` (the SoT is type-only).
    const indexText = SLICE_FILES.find((f) => f.relPath === "index.ts")?.content ?? ""
    const orphans: string[] = []
    for (const f of SLICE_FILES) {
      if (f.relPath === "index.ts") continue
      if (f.relPath === "types.ts") continue // re-exported as types
      // Strip ".ts" and look for `from "./<name>"`.
      const base = f.relPath.replace(/\.ts$/, "")
      const needle = `"./${base}"`
      if (!indexText.includes(needle)) orphans.push(f.relPath)
    }
    expect(orphans).toEqual([])
  })

  test("every slice file imports only from `@/reactor`, `node:crypto`, or `./*`", () => {
    const RE_IMPORT_FROM = /from\s+["']([^"']+)["']/g
    const offenders: Array<{ file: string; spec: string }> = []
    for (const f of SLICE_FILES) {
      // Carve-out: `webhook-transports.ts` is the dedicated network-adapter
      // boundary file; it MAY additionally import `node:http`. (Same pattern
      // as the CLI adapters file at apps/cli.)
      const isTransports = f.relPath === "webhook-transports.ts"
      const m = f.content.matchAll(RE_IMPORT_FROM)
      for (const hit of m) {
        const spec = hit[1] ?? ""
        const ok =
          spec === "@/reactor" ||
          spec.startsWith("@/reactor/") ||
          spec === "node:crypto" ||
          spec.startsWith("./") ||
          (isTransports && spec === "node:http")
        if (!ok) offenders.push({ file: f.relPath, spec })
      }
    }
    expect(offenders).toEqual([])
  })

  test("Object.freeze appears on every emitter (defensive immutability)", () => {
    // Files that build a public DTO return-value MUST freeze it. We check
    // by file name: event-payload (NormalizedGhEvent), event-source-actions
    // (ProactiveTrigger), mention-filter, pr-context-loader, pr-output-sink.
    // The check is "the file contains Object.freeze(" — necessary but not
    // sufficient; the unit hellgate already proves shape immutability.
    const must = [
      "event-payload.ts",
      "event-source-actions.ts",
      "pr-context-loader.ts",
      "pr-output-sink.ts",
    ]
    for (const m of must) {
      const f = SLICE_FILES.find((x) => x.relPath === m)
      expect(f).toBeDefined()
      if (f === undefined) throw new Error("unreachable")
      expect(f.content).toContain("Object.freeze")
    }
  })

  test("CLI lib (`from-pr-cmd.ts`) is port-only — no node:fs / Bun.spawn / @/security", () => {
    for (const re of NODE_FS_BANNED) expect(re.test(CLI_LIB_TEXT())).toBe(false)
    expect(BUN_SPAWN_RE.test(CLI_LIB_TEXT())).toBe(false)
    expect(PROCESS_ENV_RE.test(CLI_LIB_TEXT())).toBe(false)
    expect(/from\s+["']@\/security/.test(CLI_LIB_TEXT())).toBe(false)
    // The CLI lib MUST only import from `@/integrations/github` and `@/reactor`.
    const RE = /from\s+["']([^"']+)["']/g
    for (const m of CLI_LIB_TEXT().matchAll(RE)) {
      const spec = m[1] ?? ""
      const ok =
        spec === "@/integrations/github" ||
        spec === "@/reactor" ||
        spec.startsWith("@/reactor/") ||
        spec.startsWith("./") ||
        spec.startsWith("node:")
      if (!ok) throw new Error(`CLI lib forbidden import: ${spec}`)
    }
  })

  test("CLI adapters file IS the only place that imports node:fs / @/security", () => {
    // Inverse fence: adapters file SHOULD import node:fs/promises and
    // @/security/redaction (otherwise the redact wire is broken).
    expect(/from\s+["']node:fs\/promises["']/.test(CLI_ADAPTERS_TEXT())).toBe(true)
    expect(/from\s+["']@\/security\/redaction["']/.test(CLI_ADAPTERS_TEXT())).toBe(true)
    // And adapters MUST not pull trunk modules.
    for (const banned of FORBIDDEN_TRUNK_PREFIXES) {
      // `@/apps` is itself the adapters' own surface — skip self-reference.
      if (banned === "@/apps") continue
      const re = new RegExp(`from\\s+["']${banned.replace(/[/]/g, "\\/")}(?:\\/|["'])`)
      expect(re.test(CLI_ADAPTERS_TEXT())).toBe(false)
    }
  })

  test("redact port is mandatory at pr-output-sink construction (type+runtime)", () => {
    const sinkFile = SLICE_FILES.find((f) => f.relPath === "pr-output-sink.ts")
    expect(sinkFile).toBeDefined()
    if (sinkFile === undefined) throw new Error("unreachable")
    // Runtime: we throw at construction when redactPort is missing.
    expect(sinkFile.content).toMatch(/throw new Error\(["'`].*redactPort is mandatory/)
    // Type: `redactPort: RedactPort` (non-optional) in PrOutputSinkOpts.
    expect(sinkFile.content).toMatch(/readonly redactPort: RedactPort/)
  })

  test("pr-output-sink redacts BEFORE sending — text-level invariant", () => {
    const sinkFile = SLICE_FILES.find((f) => f.relPath === "pr-output-sink.ts")
    expect(sinkFile).toBeDefined()
    if (sinkFile === undefined) throw new Error("unreachable")
    // `redactPort.redact(body)` must appear and be called in a `prepareBody`
    // helper that runs BEFORE any safeRun.
    expect(sinkFile.content).toMatch(/opts\.redactPort\.redact\(/)
    // Order check (best-effort): redact call appears before postNewComment.
    const redactIdx = sinkFile.content.indexOf("opts.redactPort.redact(")
    const postIdx = sinkFile.content.indexOf("postNewComment(")
    expect(redactIdx).toBeGreaterThan(-1)
    expect(postIdx).toBeGreaterThan(-1)
    expect(redactIdx).toBeLessThan(postIdx)
  })

  test("self-loop marker SoT is shared across mention-filter and pr-output-sink", () => {
    const mf = SLICE_FILES.find((f) => f.relPath === "mention-filter.ts")?.content ?? ""
    const sink = SLICE_FILES.find((f) => f.relPath === "pr-output-sink.ts")?.content ?? ""
    // Both files must reference the same marker literal `<!-- quanta:idempotency=`.
    expect(mf).toContain("<!-- quanta:idempotency=")
    expect(sink).toContain("<!-- quanta:idempotency=")
  })
})
