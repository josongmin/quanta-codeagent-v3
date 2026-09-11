import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  createResourceAnalyzer,
  dynamicImportPrefixes,
  EXTERNAL_MODULE_EFFECTS,
  foldConstantSpecifiers,
  importSpecifiers,
} from "../../../tools/dev/test-resource-analysis"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "resource-analysis-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }
  return root
}

const keysOf = (root: string, entry: string): readonly string[] =>
  createResourceAnalyzer(root)
    .closureFor(join(root, entry))
    .claims.map(({ key }) => key)
    .sort()

describe("import-closure resource analysis", () => {
  test("an effect hidden behind a fixture helper is still claimed", () => {
    // ★ THE RAIL. The test file itself touches nothing: every resource is
    // inside the harness it calls, which is precisely the shape the
    // single-file classifier scored `pure`.
    const root = fixture({
      "tests/integration/quiet.test.ts": `
        import { startHarness } from "./_harness"
        test("looks pure", async () => { await startHarness() })
      `,
      "tests/integration/_harness.ts": `
        import { spawn } from "node:child_process"
        export const startHarness = async () => {
          const server = Bun.listen({ port: 0, socket: {} })
          process.env.QUANTA_HOME = "/tmp/q"
          spawn("git", ["status"])
          return server
        }
      `,
    })
    const keys = keysOf(root, "tests/integration/quiet.test.ts")
    expect(keys).toContain("port:ephemeral")
    expect(keys).toContain("process-env")
    expect(keys).toContain("child-process")
    expect(keys).not.toContain("unknown")

    // PAIRED CONTROL — the SAME test file with an inert helper claims nothing,
    // so the claims above come from the helper's body and not from the
    // test file's name or its position under tests/integration.
    const inert = fixture({
      "tests/integration/quiet.test.ts": `
        import { startHarness } from "./_harness"
        test("looks pure", async () => { await startHarness() })
      `,
      "tests/integration/_harness.ts": `
        export const startHarness = async () => ({ ok: true })
      `,
    })
    expect(keysOf(inert, "tests/integration/quiet.test.ts")).toEqual([])
  })

  test("a TYPE-only import is not followed; the same module as a value import is", () => {
    const typeOnly = fixture({
      "a.test.ts": `import type { Cfg } from "./effectful"\nconst x: Cfg = {}`,
      "effectful.ts": `export const go = () => Bun.listen({ port: 0, socket: {} })`,
    })
    expect(keysOf(typeOnly, "a.test.ts")).toEqual([])
    const valueImport = fixture({
      "a.test.ts": `import { go } from "./effectful"\ngo()`,
      "effectful.ts": `export const go = () => Bun.listen({ port: 0, socket: {} })`,
    })
    expect(keysOf(valueImport, "a.test.ts")).toContain("port:ephemeral")
  })

  test("a package nobody declared is `unknown`; a declared one is not", () => {
    const undeclared = fixture({
      "a.test.ts": `import { thing } from "some-unlisted-package"\nthing()`,
    })
    expect(keysOf(undeclared, "a.test.ts")).toEqual(["unknown"])
    // PAIRED CONTROL — the allowlist is what makes the difference, and a
    // resource-owning entry contributes its claim rather than nothing.
    expect(EXTERNAL_MODULE_EFFECTS.zod).toEqual([])
    const declared = fixture({ "a.test.ts": `import { z } from "zod"\nz.object({})` })
    expect(keysOf(declared, "a.test.ts")).toEqual([])
    const owner = fixture({ "a.test.ts": `import { createServer } from "node:http"` })
    expect(keysOf(owner, "a.test.ts")).toEqual(["port:ephemeral"])
  })

  test("an import cycle terminates and still unions both sides' claims", () => {
    // A recursive walk either caches a frame cut short by the cycle — which
    // publishes an UNDER-approximation — or never terminates. The fixpoint
    // does neither.
    const root = fixture({
      "a.test.ts": `import { a } from "./a"\na()`,
      "a.ts": `import { b } from "./b"\nexport const a = () => { Bun.listen({ port: 0, socket: {} }); return b() }`,
      "b.ts": `import { a } from "./a"\nimport { spawn } from "node:child_process"\nexport const b = () => { spawn("ls"); return a }`,
    })
    const keys = keysOf(root, "a.test.ts")
    expect(keys).toContain("port:ephemeral")
    expect(keys).toContain("child-process")
  })

  test("`host-cpu` does not flow up an import edge", () => {
    // Reaching a CDP adapter's SOURCE is not starting a browser. Propagating
    // `host-cpu: exclusive` transitively gave it to 297 of 562 files, each of
    // which would then have refused to run beside even a `pure` chunk.
    const root = fixture({
      "a.test.ts": `import { drive } from "./cdp"\ndrive()`,
      "cdp.ts": `export const drive = () => "chromium adapter"`,
    })
    const keys = keysOf(root, "a.test.ts")
    expect(keys).toContain("browser-profile")
    expect(keys).not.toContain("host-cpu")
    // PAIRED CONTROL — a file whose OWN source drives a browser keeps it.
    const own = fixture({ "a.test.ts": `const c = await launchChromium()` })
    expect(keysOf(own, "a.test.ts")).toContain("host-cpu")
  })

  test("prose and strings are not import statements", () => {
    // Both of these were measured defects, and both reported hundreds of files
    // as unanalyzable: a bare `from "…"` matched an English sentence in a doc
    // comment, and a bare `import "…"` matched an LLDB command inside a
    // template literal.
    expect(
      importSpecifiers(`
        export const LINES = [
          ...FIRST,
          ...SECOND,
        ]

        /** Tail body. Everything from "Honesty rail" onwards. */
      `),
    ).toEqual([])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder IS the fixture — an uninterpolated template specifier is the construct under test.
    expect(importSpecifiers('const cmds = [`command script import "${lookup}"`]')).toEqual([])
    // PAIRED CONTROL — real statements, including a multi-line one, ARE found.
    expect(
      importSpecifiers(`
        import {
          alpha,
          beta,
        } from "./multi-line"
        import "./side-effect"
        const mod = await import("./dynamic")
      `),
    ).toEqual(["./multi-line", "./side-effect", "./dynamic"])
  })

  test("a dynamic import whose specifier is a module constant is resolved, not opaque", () => {
    // `src/llm/providers/mantle-adapter.ts` holds its specifier in a variable
    // deliberately, and that one call site made 276 of 562 files unanalyzable.
    expect(foldConstantSpecifiers('const PKG = "./target"\nconst m = await import(PKG)')).toContain(
      'import("./target")',
    )
    const root = fixture({
      "a.test.ts": `const PKG = "./target"\nconst m = await import(PKG)`,
      "target.ts": `export const go = () => Bun.listen({ port: 0, socket: {} })`,
    })
    const keys = keysOf(root, "a.test.ts")
    expect(keys).toContain("port:ephemeral")
    expect(keys).not.toContain("unknown")
    // PAIRED CONTROL — a specifier that is NOT a module constant stays opaque.
    const opaque = fixture({ "a.test.ts": `const m = await import(whateverTheCallerPassed)` })
    expect(keysOf(opaque, "a.test.ts")).toEqual(["unknown"])
  })

  test("a template import with a static prefix reaches the directory, not `unknown`", () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the `${…}` is
    // the FIXTURE — an uninterpolated template specifier is the construct under
    // test, and interpolating it would remove the thing being asserted about.
    expect(dynamicImportPrefixes("await import(`./presets/${mode}`)")).toEqual(["./presets"])
    expect(dynamicImportPrefixes("await import(`${root}/presets`)")).toEqual([])
    const root = fixture({
      "a.test.ts": "const m = await import(`./presets/${mode}`)",
      "presets/one.ts": `export const one = () => Bun.listen({ port: 0, socket: {} })`,
      "presets/two.ts": `export const two = () => 1`,
    })
    const keys = keysOf(root, "a.test.ts")
    expect(keys).toContain("port:ephemeral")
    expect(keys).not.toContain("unknown")
    // PAIRED CONTROL — a prefix that names no directory is as opaque as a
    // fully computed specifier.
    const missing = fixture({ "a.test.ts": "const m = await import(`./absent/${mode}`)" })
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of fixture block.
    expect(keysOf(missing, "a.test.ts")).toEqual(["unknown"])
  })

  test("an unresolvable relative specifier fails closed", () => {
    const root = fixture({ "a.test.ts": `import { x } from "./nowhere"\nx()` })
    expect(keysOf(root, "a.test.ts")).toEqual(["unknown"])
  })
})
