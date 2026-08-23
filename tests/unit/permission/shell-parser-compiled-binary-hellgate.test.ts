/**
 * HELLGATE — I: the shell effect authority must survive `bun build --compile`
 * (§17.5 packet I, integration).
 *
 * The structural hard-deny authority loads a tree-sitter grammar. In dev
 * (`bun run src/...`) `node_modules` sits beside the process and everything
 * resolves. The SHIPPED artifact is a single-file binary produced by
 * `bun build --compile`, where there is no `node_modules` — and
 * `web-tree-sitter` then tries to load its runtime wasm from
 * `/$bunfs/root/web-tree-sitter.wasm`, which is not embedded either.
 *
 * Measured on `dist/agent` before this fix:
 *
 *   failed to asynchronously prepare wasm:
 *     ENOENT '/$bunfs/root/web-tree-sitter.wasm'
 *   [warn] shell effect parser: grammar load failed
 *
 * So the authority answered `unknown` for EVERY command and the shipping binary
 * silently ran on the regex-only gate this lane exists to replace. Every unit
 * test still passed, because they run from source.
 *
 * This is the reason the parser's load failure is ATTRIBUTED rather than
 * swallowed: the warning is what made the defect visible at all.
 *
 * The test compiles a real binary and runs it. That is slow and it is the point
 * — no cheaper assertion can distinguish "works from source" from "works when
 * shipped", which is precisely the distinction that was wrong.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = new URL("../../../", import.meta.url).pathname

describe("I — the shell effect authority survives compilation", () => {
  test(
    "a compiled binary arms the grammar and still hard-denies a structural bypass",
    async () => {
      // The entry must live INSIDE the repo: bun resolves bare specifiers
      // (`@/…`, `web-tree-sitter`) against the nearest `node_modules`, so a
      // scratch-dir entry cannot be compiled at all.
      const entry = join(REPO_ROOT, `__compiled-parser-probe-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "compiled-probe-"))
      const bin = join(out, "probe")
      try {
        writeFileSync(
          entry,
          [
            `import { assessShellCommand, initShellEffectParser, shellEffectParserReady } from "@/permission/shell"`,
            `await initShellEffectParser()`,
            `console.log(JSON.stringify({`,
            `  ready: shellEffectParserReady(),`,
            `  verdict: assessShellCommand("cd / && rm -rf *").kind,`,
            `}))`,
          ].join("\n"),
          "utf8",
        )

        const build = Bun.spawnSync({
          cmd: ["bun", "build", "--compile", entry, "--outfile", bin],
          cwd: REPO_ROOT,
        })
        expect(build.exitCode).toBe(0)

        const run = Bun.spawnSync({ cmd: [bin] })
        const stdout = new TextDecoder().decode(run.stdout).trim()
        const last = stdout.split("\n").at(-1) ?? "{}"
        expect(JSON.parse(last)).toEqual({ ready: true, verdict: "hard-deny" })
      } finally {
        rmSync(entry, { force: true })
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )
})
