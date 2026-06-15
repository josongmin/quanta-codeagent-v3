/**
 * QUANTA-HOME ROOT SSOT ratchet (jun-15 config-dir split-brain fix).
 *
 * Quanta's on-disk home root must be resolved through ONE SSOT —
 * `quantaHomeDir()` in `@/shared` (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ??
 * ~/.quanta`). The bug this locks: ~a dozen subsystems hard-coded
 * `join(homedir(), ".quanta", …)` and honored NEITHER root override, so a user
 * who set `QUANTA_CONFIG_DIR`/`QUANTA_HOME` got a SPLIT-BRAIN home (config in
 * one place, sticky-model/scheduler/sessions/grants/caches in another).
 *
 * RULE: a raw `join(homedir(), ".quanta", …)` may appear ONLY in files that
 * legitimately COMPUTE a root (the resolver itself) or own a distinct,
 * intentional override seam (composition-root `QUANTA_CONFIG_DIR` readers, the
 * `QUANTA_PREFS_HOME` test-isolation seam, the web-daemon `QUANTA_WEB_DB_DIR`
 * override, the bench `QUANTA_HOME` persistent-default). Everything else MUST
 * derive from `quantaHomeDir()`. A NEW raw site fails this ratchet → route it
 * through `quantaHomeDir()` (or, if it genuinely owns a new root seam, add it
 * to ALLOWLIST with a reason).
 *
 * This is the forcing function that prevents the split-brain from re-growing.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "src")

/** Raw "Quanta home" hard-code: `homedir()` immediately followed by `".quanta"`
 *  as a path segment. Matches the leak we are forbidding; does NOT match
 *  `quantaHomeDir()` (no `homedir()` token) or unrelated `homedir()` uses
 *  (`.codex`, `.config`, …). */
const RAW = /homedir\(\)\s*,\s*"\.quanta"/

/** Files allowed to keep a raw `homedir(), ".quanta"` — each either COMPUTES the
 *  root or owns a distinct, documented override seam. Path is repo-relative. */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["src/shared/quanta-home.ts", "THE resolver — the one place the root literal lives"],
  [
    "src/host/runtime/agent-arg-builder.ts",
    "composition-root QUANTA_CONFIG_DIR reader (DI env param; pairs with @/config)",
  ],
  [
    "src/apps/agent/index.ts",
    "composition-root QUANTA_CONFIG_DIR reader (central-config trust dir)",
  ],
  ["src/apps/cli/internal.ts", "composition-root QUANTA_CONFIG_DIR reader (central-config dir)"],
  ["src/apps/cli/hooks-cmd.ts", "composition-root QUANTA_CONFIG_DIR reader (hooks write dir)"],
  [
    "src/apps/cli/webhook-server-setup.ts",
    "composition-root QUANTA_CONFIG_DIR reader (delivery-dedup dump; raw-env exempt host entry)",
  ],
  [
    "src/permission/permission-store.ts",
    "resolves QUANTA_CONFIG_DIR ?? QUANTA_HOME via the injected runtimeConfig (not the global singleton)",
  ],
  [
    "src/runner/batch/corpus/paths.ts",
    "bench QUANTA_HOME persistent-default (own override + macOS Library fallback)",
  ],
  ["src/auth/chatgpt-oauth/paths.ts", "QUANTA_PREFS_HOME test-isolation seam (distinct override)"],
  [
    "src/apps/web-daemon/persistence-sqlite.ts",
    "web-daemon QUANTA_WEB_DB_DIR override (separate daemon process root)",
  ],
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "__tests__") continue
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      yield p
    }
  }
}

const isComment = (l: string): boolean => {
  const t = l.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

/** Files (repo-relative, `src/…`) with a NON-comment raw home hard-code. */
const scanRawHomeSites = (srcRoot: string): string[] => {
  const hits: string[] = []
  for (const file of walk(srcRoot)) {
    const src = readFileSync(file, "utf8")
    // Fast reject: skip the per-line comment scan unless the file matches at all.
    if (!RAW.test(src)) continue
    const hasRaw = src.split("\n").some((line) => !isComment(line) && RAW.test(line))
    if (hasRaw) hits.push(`src/${file.slice(srcRoot.length + 1)}`)
  }
  return hits
}

describe("quanta home root SSOT ratchet", () => {
  test('no NEW raw `homedir(), ".quanta"` outside the allowlist', () => {
    const sites = scanRawHomeSites(SRC)
    const offenders = sites.filter((f) => !ALLOWLIST.has(f))
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} raw \`join(homedir(), ".quanta", …)\` site(s) bypassing the ` +
          `quantaHomeDir() SSOT (split-brain home risk). Route through ` +
          `\`import { quantaHomeDir } from "@/shared"\`:\n${offenders.map((o) => `  ${o}`).join("\n")}`,
      )
    }
    expect(offenders).toEqual([])
  })

  test("allowlist has no dead entries (every allowlisted file still has a raw site)", () => {
    const sites = new Set(scanRawHomeSites(SRC))
    const dead = [...ALLOWLIST.keys()].filter((f) => !sites.has(f))
    // A dead entry means the file was migrated/removed — prune it so the
    // allowlist can't silently grant future raw sites in that file.
    expect(dead).toEqual([])
  })

  test("DETECTOR has teeth (red-on-injection)", () => {
    expect(RAW.test('join(homedir(), ".quanta", "snooze")')).toBe(true)
    expect(RAW.test("const p = quantaHomeDir()")).toBe(false)
    expect(RAW.test('join(homedir(), ".codex")')).toBe(false)
  })
})
