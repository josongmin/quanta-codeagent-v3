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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const REPO_ROOT = new URL("../../../", import.meta.url).pathname

describe("I — the shell effect authority survives compilation", () => {
  test(
    "a compiled binary arms the grammar and still hard-denies a structural bypass",
    async () => {
      // INSIDE the repo, because bun resolves bare specifiers (`@/…`,
      // `web-tree-sitter`) against the nearest `node_modules` and a scratch-dir
      // entry cannot be compiled at all — but under `.cache/`, not at the ROOT.
      //
      // MEASURED: a campaign killed this worker mid-test, the `finally` never
      // ran, and `__compiled-parser-probe-38563.ts` was left in the repo root,
      // where the next run's typecheck, lint and lint:debt all read it. The
      // prepush guard caught it as `endDirty=true` and invalidated an otherwise
      // complete campaign. `.cache/` is gitignored and resolution is identical
      // — bun walks UP for both `node_modules` and the tsconfig — so a killed
      // worker can no longer dirty the tracked tree.
      const entry = join(REPO_ROOT, ".cache", "compiled-probe", `entry-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "compiled-probe-"))
      const bin = join(out, "probe")
      try {
        mkdirSync(dirname(entry), { recursive: true })
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

  test(
    "the retrieval code-parser's grammar-dir OVERRIDE is usable in a compiled binary",
    async () => {
      // Same class, measured separately rather than presumed: the retrieval
      // parser resolves its grammars from `node_modules` too. From source it
      // parses; in a compiled binary run OUTSIDE the repo it returned
      // `{ok:false, reason:"parse-error"}` — indistinguishable from a genuinely
      // unparseable file.
      //
      // Only the 200 KB RUNTIME wasm is embedded. The grammars are ~21 MB across
      // 16 languages and this parser is opt-in (`QUANTA_INDEX`), so bundling all
      // of them is a product decision, not an integration fix. What the embed
      // buys is that `QUANTA_TREE_SITTER_DIR` — which already existed — now
      // actually works, because init no longer aborts before any grammar is
      // looked up. This asserts exactly that, and nothing stronger.
      // Same reason as above: inside the repo for resolution, under an ignored
      // directory so a killed worker cannot leave it in the tracked tree.
      const entry = join(REPO_ROOT, ".cache", "compiled-probe", `retrieval-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "compiled-retrieval-"))
      const bin = join(out, "probe")
      const grammarDir = join(REPO_ROOT, "node_modules/@vscode/tree-sitter-wasm/wasm")
      try {
        mkdirSync(dirname(entry), { recursive: true })
        writeFileSync(
          entry,
          [
            `import { createTreeSitterParser } from "@/retrieval/code-parser"`,
            `const p = createTreeSitterParser()`,
            `const r = await p.parse("x.ts", "export const a = 1\\n")`,
            `console.log(JSON.stringify({ ok: r.ok }))`,
          ].join("\n"),
          "utf8",
        )
        const build = Bun.spawnSync({
          cmd: ["bun", "build", "--compile", entry, "--outfile", bin],
          cwd: REPO_ROOT,
        })
        expect(build.exitCode).toBe(0)

        const run = Bun.spawnSync({
          cmd: [bin],
          cwd: out, // deliberately OUTSIDE the repo: no `node_modules` to fall back to
          env: { ...process.env, QUANTA_TREE_SITTER_DIR: grammarDir },
        })
        const stdout = new TextDecoder().decode(run.stdout).trim()
        expect(JSON.parse(stdout.split("\n").at(-1) ?? "{}")).toEqual({ ok: true })
      } finally {
        rmSync(entry, { force: true })
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )
})
