/**
 * XSS-escaping guard for the leaderboard dashboard's CLIENT-SIDE render layer.
 *
 * The dashboard ships its UI as one big client-side `<script>` template inside
 * server.ts. Report-derived strings (model / preset / campaign key / live log
 * tail — `lastInstance` is a regex match over arbitrary log bytes) are
 * interpolated into `.innerHTML`. If any sink is unescaped an attacker who can
 * land a string in a report file or a log gets stored XSS in the dashboard.
 *
 * We can't import server.ts (it calls Bun.serve at import). Instead we read the
 * source, pull the named render functions out of the shipped HTML template, and
 * evaluate them against a hostile DATA payload, asserting the output carries
 * escaped entities and never the raw `<script>`.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(join(import.meta.dir, "server.ts"), "utf8")

/** Pull a `function name(...) { ... }` body out of the source by brace-matching. */
function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`fn ${name} not found`)
  let depth = 0
  let i = SRC.indexOf("{", start)
  for (; i < SRC.length; i++) {
    const c = SRC[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`fn ${name} unbalanced`)
}

/** Pull the `esc` arrow/function helper. */
function extractEsc(): string {
  const m = SRC.match(/function esc\([^)]*\)\{[\s\S]*?\n\}/)
  if (m) return m[0]
  // single-line form
  const m2 = SRC.match(/function esc\([^)]*\)\s*\{[^\n]*\}/)
  if (!m2) throw new Error("esc not found")
  return m2[0]
}

const HOSTILE = `</style><script>alert(1)</script>`
const HOSTILE_CHARS = `& < > " '`

/** Evaluate the shipped `esc` helper in isolation. */
function loadEsc(): (s: string) => string {
  const src = `${extractEsc()}\nreturn esc;`
  return new Function(src)() as (s: string) => string
}

describe("dashboard XSS escaping", () => {
  test("esc covers & < > \" ' and escapes & first", () => {
    const esc = loadEsc()
    expect(esc(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;")
    // & must be escaped first so existing entities are not double-broken into
    // raw text, AND a lone & becomes &amp; not corrupt output.
    expect(esc("a&b")).toBe("a&amp;b")
    expect(esc(null as unknown as string)).toBe("")
  })

  test("renderRuns escapes campaign model/preset/key/members", () => {
    const DATA = {
      campaigns: [
        {
          key: HOSTILE,
          model: HOSTILE,
          preset: HOSTILE,
          members: [HOSTILE_CHARS],
          resolved: 1,
          total: 2,
          mtime: 0,
        },
      ],
    }
    const src = [extractEsc(), extractFn("renderRuns"), "return renderRuns();"].join("\n")
    const out = new Function("DATA", "document", src)(DATA, {}) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&amp;")
    expect(out).toContain("&#39;")
  })

  test("renderScaffolds escapes scaffold key/model", () => {
    const DATA = {
      topScaffolds: [{ key: HOSTILE, model: HOSTILE, resolved: 1, pct: 50 }],
    }
    const src = [extractEsc(), extractFn("renderScaffolds"), "return renderScaffolds();"].join("\n")
    const out = new Function("DATA", "document", src)(DATA, {}) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  test("renderLive escapes dir/log/lastInstance and the log tail", () => {
    const DATA = {
      live: [
        {
          dir: HOSTILE,
          log: HOSTILE,
          lastInstance: HOSTILE,
          lines: 1,
          mtime: 0,
          tail: `${HOSTILE} ${HOSTILE_CHARS}`,
        },
      ],
    }
    const src = [extractEsc(), extractFn("renderLive"), "return renderLive();"].join("\n")
    const out = new Function("DATA", "document", src)(DATA, { Date }) as string
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&amp;")
  })

  test("renderCards escapes the best-campaign key", () => {
    const DATA = {
      quanta: {},
      rows: {},
      campaigns: [{ key: HOSTILE, resolved: 1, total: 2 }],
      runs: [],
      live: [],
      coverage: null,
    }
    const src = [extractEsc(), extractFn("renderCards"), "renderCards(); return null;"].join("\n")
    const doc = {
      sink: "",
      getElementById() {
        const self = doc
        return {
          set innerHTML(v: string) {
            self.sink = v
          },
        }
      },
    }
    new Function("DATA", "document", src)(DATA, doc)
    expect(doc.sink).not.toContain("<script>")
    expect(doc.sink).toContain("&lt;script&gt;")
  })
})

describe("parseReportFile mtime memo (FIX 3)", () => {
  // We inject a counting `buildRunFromFile` + fresh cache Map so we can prove
  // the memo skips the expensive parse on an unchanged mtime and invalidates
  // (re-parses) the moment the file's mtime moves — i.e. on edit.
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  function loadParseReportFile() {
    // Transpile the TS helper to JS so `new Function` can parse it.
    const tsSrc = extractFn("parseReportFile")
    const src = `${transpiler.transformSync(tsSrc)}\nreturn parseReportFile;`
    let builds = 0
    const RUN_PARSE_CACHE = new Map<string, { mtime: number; run: unknown }>()
    const buildRunFromFile = (f: string, mtime: number) => {
      builds++
      return { file: f, mtime }
    }
    const fn = new Function("RUN_PARSE_CACHE", "buildRunFromFile", src)(
      RUN_PARSE_CACHE,
      buildRunFromFile,
    ) as (f: string, m: number) => unknown
    return { fn, builds: () => builds, cache: RUN_PARSE_CACHE }
  }

  test("unchanged mtime is served from cache (no re-parse)", () => {
    const { fn, builds } = loadParseReportFile()
    fn("/x/a.report.json", 1000)
    fn("/x/a.report.json", 1000)
    fn("/x/a.report.json", 1000)
    expect(builds()).toBe(1)
  })

  test("changed mtime invalidates and re-parses (edit visibility)", () => {
    const { fn, builds } = loadParseReportFile()
    const r1 = fn("/x/a.report.json", 1000) as { mtime: number }
    const r2 = fn("/x/a.report.json", 2000) as { mtime: number }
    expect(builds()).toBe(2)
    expect(r1.mtime).toBe(1000)
    expect(r2.mtime).toBe(2000)
  })

  test("mtime 0 (stat failed) never caches — always parses fresh", () => {
    const { fn, builds, cache } = loadParseReportFile()
    fn("/x/a.report.json", 0)
    fn("/x/a.report.json", 0)
    expect(builds()).toBe(2)
    expect(cache.size).toBe(0)
  })
})
