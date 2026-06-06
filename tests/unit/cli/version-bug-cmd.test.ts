/**
 * `/version` (§23.3) + `/bug` (§23.4) hellgate.
 *
 * Pins: version resolution precedence (env > package.json > "unknown"), the
 * repo-URL override, and the `/bug` prefilled-URL builder — especially that it
 * sends nothing and that special characters in the summary cannot break the
 * query string (encodeURIComponent).
 */

import { describe, expect, test } from "bun:test"
import { buildBugCmd, renderBug } from "@/../src/apps/cli/bug-cmd"
import { repoUrl, resolveCommit, resolveVersion } from "@/../src/apps/cli/repo-info"
import type { SlashContext } from "@/../src/apps/cli/slash-contract"
import {
  buildReleaseNotesCmd,
  buildVersionCmd,
  renderVersion,
} from "@/../src/apps/cli/version-cmd"

const capCtx = (): { ctx: SlashContext; lines: string[] } => {
  const lines: string[] = []
  const ctx = {
    out: (s: string) => lines.push(s),
    err: () => undefined,
    cwd: "/tmp",
  } as SlashContext
  return { ctx, lines }
}

describe("HELL-VER-1 — version resolution precedence", () => {
  test("QUANTA_VERSION wins", () => {
    expect(resolveVersion({ QUANTA_VERSION: "9.9.9" }, "/tmp")).toBe("9.9.9")
  })

  test("falls back to package.json version at repo root", () => {
    // cwd is the repo root in the test runner; package.json has a real version.
    const v = resolveVersion({}, process.cwd())
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("blank QUANTA_VERSION is ignored (not treated as a version)", () => {
    expect(resolveVersion({ QUANTA_VERSION: "  " }, process.cwd())).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("unresolvable ⇒ 'unknown' (never throws)", () => {
    expect(resolveVersion({}, "/nonexistent/path/zzz")).toBe("unknown")
  })
})

describe("HELL-VER-2 — repoUrl override", () => {
  test("default repo url, no trailing slash", () => {
    expect(repoUrl({})).toBe("https://github.com/josongmin/quanta-codeagent-v3")
  })

  test("QUANTA_REPO_URL overrides + strips trailing slash", () => {
    expect(repoUrl({ QUANTA_REPO_URL: "https://example.com/x/" })).toBe("https://example.com/x")
  })

  test("hostile/non-https QUANTA_REPO_URL falls back to default (F3 regression)", () => {
    const def = "https://github.com/josongmin/quanta-codeagent-v3"
    for (const evil of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "http://evil.example", // non-https rejected
      "github.com/no-scheme",
      "not a url",
    ]) {
      expect(repoUrl({ QUANTA_REPO_URL: evil })).toBe(def)
    }
  })

  test("malformed/normalization-hostile overrides fall back to default (audit 8/9)", () => {
    const def = "https://github.com/josongmin/quanta-codeagent-v3"
    for (const evil of [
      "https:evil", // schemeless (no //) → not a real https:// URL
      "https:///etc/passwd", // empty host
      "https://example.com/x#frag", // fragment would swallow appended path
      "https://example.com/x?a=b", // query would swallow appended path
      "https://user:pass@evil.example", // userinfo
    ]) {
      expect(repoUrl({ QUANTA_REPO_URL: evil })).toBe(def)
    }
  })

  test("accepted override is returned CANONICAL (origin+pathname, no trailing slash)", () => {
    expect(repoUrl({ QUANTA_REPO_URL: "https://gitlab.com/me/repo/" })).toBe(
      "https://gitlab.com/me/repo",
    )
    // appended paths compose cleanly (no double slash, path not swallowed)
    const out = renderBug([], { env: { QUANTA_REPO_URL: "https://gitlab.com/me/repo" } })
    expect(out).toContain("https://gitlab.com/me/repo/issues/new?title=")
  })
})

describe("HELL-VER-4 — control-char / ANSI sanitization (audit finding 7, bug)", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting strings are stripped of control bytes
  const CONTROL = /[\x00-\x1f\x7f-\x9f]/

  test("QUANTA_VERSION with embedded ESC/newline is stripped (no terminal-escape injection)", () => {
    const v = resolveVersion({ QUANTA_VERSION: "1.0\x1b]0;PWNED\x07\nFile a bug: https://evil" })
    expect(CONTROL.test(v)).toBe(false)
    expect(v).not.toContain("\n")
  })

  test("renderVersion strips ESC/BEL from the version (structural \\n between lines is fine)", () => {
    const out = renderVersion({ env: { QUANTA_VERSION: "9.9\x1b[31m\x07" } })
    expect(out).not.toContain("\x1b")
    expect(out).not.toContain("\x07")
    expect(out).toContain("quanta 9.9")
    // every line is free of C0/C1 control bytes once the structural newline split is removed
    for (const line of out.split("\n")) expect(CONTROL.test(line)).toBe(false)
  })

  test("QUANTA_COMMIT control bytes stripped before the 12-char slice", () => {
    const c = resolveCommit({ QUANTA_COMMIT: "\x1b]0;xabcdef123456" })
    expect(c !== undefined && CONTROL.test(c)).toBe(false)
  })
})

describe("HELL-VER-5 — /release-notes command (audit finding 10)", () => {
  test("prints version + /releases URL (no double slash) + exit 0", async () => {
    const { ctx, lines } = capCtx()
    const code = await buildReleaseNotesCmd({ env: { QUANTA_VERSION: "1.2.3" } }).run([], ctx)
    expect(code).toBe(0)
    const out = lines.join("")
    expect(out).toContain("quanta 1.2.3")
    expect(out).toContain("github.com/josongmin/quanta-codeagent-v3/releases")
    expect(out).not.toContain("//releases")
  })
})

describe("HELL-VER-3 — /version render + command", () => {
  test("renderVersion shows version + platform + repo", () => {
    const out = renderVersion({ env: { QUANTA_VERSION: "1.2.3" }, cwd: "/tmp" })
    expect(out).toContain("quanta 1.2.3")
    expect(out).toContain(process.platform)
    expect(out).toContain("github.com")
  })

  test("commit appended when QUANTA_COMMIT set", () => {
    const out = renderVersion({
      env: { QUANTA_VERSION: "1.2.3", QUANTA_COMMIT: "abcdef123456789" },
    })
    expect(out).toContain("(abcdef123456)") // sliced to 12
  })

  test("/version command prints and exits 0", async () => {
    const { ctx, lines } = capCtx()
    const code = await buildVersionCmd({ env: { QUANTA_VERSION: "1.2.3" } }).run([], ctx)
    expect(code).toBe(0)
    expect(lines.join("")).toContain("quanta 1.2.3")
  })
})

describe("HELL-BUG-1 — /bug prefilled URL is safe + offline", () => {
  test("builds a github new-issue url with prefilled env", () => {
    const out = renderBug(["search", "is", "slow"], {
      env: { QUANTA_VERSION: "1.2.3" },
      cwd: "/tmp",
    })
    expect(out).toContain("https://github.com/josongmin/quanta-codeagent-v3/issues/new?")
    expect(out).toContain("title=search%20is%20slow")
    expect(out).toContain("quanta%3A%201.2.3") // body carries the version
  })

  test("special chars in summary are percent-encoded (cannot break the query)", () => {
    const out = renderBug(["a&b=c#d", '"q"'], { env: {}, cwd: "/tmp" })
    // raw separators must NOT appear unescaped in the title param
    expect(out).not.toContain("title=a&b=c#d")
    expect(out).toContain("%26") // &
    expect(out).toContain("%23") // #
  })

  test("empty summary ⇒ default title, still valid url", () => {
    const out = renderBug([], { env: {}, cwd: "/tmp" })
    expect(out).toContain("title=Bug%20report")
  })

  test("/bug prints the no-data-sent note + exits 0", async () => {
    const { ctx, lines } = capCtx()
    const code = await buildBugCmd({ env: {} }).run(["oops"], ctx)
    expect(code).toBe(0)
    expect(lines.join("")).toContain("nothing was sent")
  })
})
