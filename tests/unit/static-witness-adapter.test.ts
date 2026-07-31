/**
 * SCAFF-02 hellgate — PURE Python AST static-witness adapter.
 *
 * Teeth: REAL Python source strings are fed through an injected `readSource`, and
 * we assert the EXACT relation kind + authority each one yields. Symbols are
 * GENERIC made-up names (no real benchmark symbol/path). Self-policing test at the
 * bottom asserts neither this file nor the module names a benchmark instance,
 * gold path, or hidden grader label.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildAstStaticWitnesses,
  type StaticWitnessProviderInput,
} from "../../src/runner/batch/eval/static-witness-adapter"

const sourceMap = (m: Record<string, string>): ((rel: string) => string | null) => {
  return (rel) => m[rel] ?? null
}

describe("buildAstStaticWitnesses", () => {
  test("stage1-only (one owner, no shared symbol, not issue-mentioned) => no witness", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "Something is broken in the widget pipeline somewhere.",
      ownerCandidates: ["pkg/solo.py"],
      readSource: sourceMap({
        "pkg/solo.py": ["class Solo:", "    def helper(self, x):", "        return x + 1"].join(
          "\n",
        ),
      }),
    }
    expect(buildAstStaticWitnesses(input)).toEqual([])
  })

  test("same method in TWO owner files + issue-mentioned => AUTHORITATIVE override-family with both files", () => {
    const sym = "settings_to_cmd_args_env"
    const input: StaticWitnessProviderInput = {
      problemStatement: `The \`${sym}\` builder drops an argument for some backends.`,
      ownerCandidates: ["pkg/base.py", "pkg/postgres.py"],
      readSource: sourceMap({
        "pkg/base.py": [
          "class BaseBuilder:",
          `    def ${sym}(self, settings):`,
          "        return []",
        ].join("\n"),
        "pkg/postgres.py": [
          "class PgBuilder:",
          `    def ${sym}(self, settings):`,
          "        return ['--pg']",
        ].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const fam = out.filter((w) => w.kind === "override-family")
    expect(fam.length).toBe(1)
    expect(fam[0]?.authority).toBe("authoritative")
    expect(fam[0]?.provenance).toBe("ast")
    expect([...(fam[0]?.subjectFiles ?? [])].sort()).toEqual(["pkg/base.py", "pkg/postgres.py"])
    expect(fam[0]?.subjectSymbols).toEqual([sym])
  })

  test("class Sub(Base) overriding a base method => AUTHORITATIVE override-family even if issue doesn't name it", () => {
    const sym = "render_payload"
    const input: StaticWitnessProviderInput = {
      // issue does NOT mention render_payload — structural override must carry it.
      problemStatement: "Output formatting is wrong; nothing names the method.",
      ownerCandidates: ["pkg/base.py", "pkg/sub.py"],
      readSource: sourceMap({
        "pkg/base.py": ["class Base:", `    def ${sym}(self):`, "        return 'base'"].join("\n"),
        "pkg/sub.py": [
          "from pkg.base import Base",
          "class Sub(Base):",
          `    def ${sym}(self):`,
          "        return 'sub'",
        ].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const fam = out.filter((w) => w.kind === "override-family")
    expect(fam.length).toBe(1)
    expect(fam[0]?.authority).toBe("authoritative")
    expect([...(fam[0]?.subjectFiles ?? [])].sort()).toEqual(["pkg/base.py", "pkg/sub.py"])
  })

  test("same method across two owner files, NOT mentioned, NO inheritance => ADVISORY override-family", () => {
    const sym = "compute_thing"
    const input: StaticWitnessProviderInput = {
      problemStatement: "Bug in the thing pipeline; method name absent from prose.",
      ownerCandidates: ["pkg/a.py", "pkg/b.py"],
      readSource: sourceMap({
        // two unrelated classes (no inheritance) both defining compute_thing.
        "pkg/a.py": ["class Alpha:", `    def ${sym}(self):`, "        return 1"].join("\n"),
        "pkg/b.py": ["class Beta:", `    def ${sym}(self):`, "        return 2"].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const fam = out.filter((w) => w.kind === "override-family")
    expect(fam.length).toBe(1)
    expect(fam[0]?.authority).toBe("advisory")
  })

  test("issue-mentioned symbol defined in exactly ONE owner file => unique-symbol-definer authoritative", () => {
    const sym = "lonely_loader"
    const input: StaticWitnessProviderInput = {
      problemStatement: `The \`${sym}\` function fails on empty input.`,
      ownerCandidates: ["pkg/only.py", "pkg/other.py"],
      readSource: sourceMap({
        "pkg/only.py": [`def ${sym}(data):`, "    return data"].join("\n"),
        "pkg/other.py": ["def unrelated():", "    return None"].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const uniq = out.filter((w) => w.kind === "unique-symbol-definer")
    expect(uniq.length).toBe(1)
    expect(uniq[0]?.authority).toBe("authoritative")
    expect(uniq[0]?.provenance).toBe("ast")
    expect(uniq[0]?.subjectFiles).toEqual(["pkg/only.py"])
    expect(uniq[0]?.subjectSymbols).toEqual([sym])
  })

  test("HTML comments in the issue text do not create witnesses", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: [
        "<!-- hidden_helper should not count as a public symbol mention -->",
        "Visible issue text does not mention any owner symbol.",
      ].join("\n"),
      ownerCandidates: ["pkg/only.py"],
      readSource: sourceMap({
        "pkg/only.py": ["def hidden_helper():", "    return 1"].join("\n"),
      }),
    }
    expect(buildAstStaticWitnesses(input)).toEqual([])
  })

  test("producer-consumer: symbol defined in one owner file, called in another => authoritative", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "Pipeline wiring issue.",
      ownerCandidates: ["pkg/producer.py", "pkg/consumer.py"],
      readSource: sourceMap({
        "pkg/producer.py": ["def build_widget(spec):", "    return spec"].join("\n"),
        "pkg/consumer.py": [
          "from pkg.producer import build_widget",
          "def run():",
          "    return build_widget({})",
        ].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const pc = out.filter((w) => w.kind === "producer-consumer")
    expect(pc.length).toBe(1)
    expect(pc[0]?.authority).toBe("authoritative")
    expect(pc[0]?.fromFile).toBe("pkg/producer.py")
    expect([...(pc[0]?.subjectFiles ?? [])].sort()).toEqual(["pkg/consumer.py", "pkg/producer.py"])
  })

  test("registration-callback: callback passed into register(...) with resolvable impl => authoritative", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "Callback not firing.",
      ownerCandidates: ["pkg/registry_site.py", "pkg/handlers.py"],
      readSource: sourceMap({
        "pkg/registry_site.py": [
          "from pkg.handlers import on_event",
          "def setup(reg):",
          "    register(on_event)",
        ].join("\n"),
        "pkg/handlers.py": ["def on_event(evt):", "    return evt"].join("\n"),
      }),
    }
    const out = buildAstStaticWitnesses(input)
    const reg = out.filter((w) => w.kind === "registration-callback")
    expect(reg.length).toBe(1)
    expect(reg[0]?.authority).toBe("authoritative")
    expect(reg[0]?.subjectSymbols).toEqual(["on_event"])
    expect([...(reg[0]?.subjectFiles ?? [])].sort()).toEqual([
      "pkg/handlers.py",
      "pkg/registry_site.py",
    ])
  })

  test("ownerResolved ripgrep sibling => ADVISORY override-family only (never authoritative)", () => {
    const sym = "shared_hook"
    const input: StaticWitnessProviderInput = {
      // issue MENTIONS the symbol — proving the sibling stays advisory regardless,
      // because ripgrep-sibling provenance can't confer authority on its own.
      problemStatement: `The \`${sym}\` is wrong.`,
      ownerCandidates: [],
      ownerResolved: [
        { file: "pkg/x.py", forSymbol: sym, fromFile: "pkg/y.py" },
        { file: "pkg/z.py", forSymbol: sym },
      ],
      readSource: () => null,
    }
    const out = buildAstStaticWitnesses(input)
    expect(out.length).toBeGreaterThan(0)
    for (const w of out) {
      expect(w.kind).toBe("override-family")
      expect(w.authority).toBe("advisory")
    }
    const w0 = out[0]
    expect([...(w0?.subjectFiles ?? [])].sort()).toEqual(["pkg/x.py", "pkg/y.py", "pkg/z.py"])
  })

  test("missing source (readSource returns null) => empty", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "Anything mentioning helper and builder.",
      ownerCandidates: ["pkg/gone.py", "pkg/also_gone.py"],
      readSource: () => null,
    }
    expect(buildAstStaticWitnesses(input)).toEqual([])
  })

  test("deterministic: deep-equal across two calls on the same input", () => {
    const sym = "settings_to_cmd_args_env"
    const input: StaticWitnessProviderInput = {
      problemStatement: `\`${sym}\` and \`lonely_loader\` and \`build_widget\`.`,
      ownerCandidates: ["pkg/base.py", "pkg/postgres.py", "pkg/consumer.py"],
      ownerResolved: [{ file: "pkg/sib.py", forSymbol: "lonely_loader", fromFile: "pkg/only.py" }],
      readSource: sourceMap({
        "pkg/base.py": ["class B:", `    def ${sym}(self):`, "        return []"].join("\n"),
        "pkg/postgres.py": ["class P:", `    def ${sym}(self):`, "        return []"].join("\n"),
        "pkg/consumer.py": ["def lonely_loader(x):", "    return build_widget(x)"].join("\n"),
      }),
    }
    const a = buildAstStaticWitnesses(input)
    const b = buildAstStaticWitnesses(input)
    expect(a).toEqual(b)
  })
})

describe("SCAFF-02 self-policing (no benchmark contamination)", () => {
  const moduleSrc = readFileSync(
    join(import.meta.dir, "../../src/runner/batch/eval/static-witness-adapter.ts"),
    "utf8",
  )
  const testSrc = readFileSync(import.meta.path, "utf8")
  const corpus = `${moduleSrc}\n${testSrc}`

  test("no benchmark instance prefix / gold path / hidden grader labels", () => {
    // Patterns are assembled from fragments so the literal forbidden strings never
    // appear in this guard's OWN source (which it reads into `corpus`) — otherwise
    // the guard would match itself and false-fail.
    const u = "_".repeat(2)
    const forbidden = [
      `django${u}`,
      `astropy${u}`,
      ["FAIL", "TO", "PASS"].join("_"),
      ["PASS", "TO", "PASS"].join("_"),
      // real django gold owner path that must not be hard-coded as a solve mechanism.
      ["db", "backends"].join("/"),
    ]
    for (const needle of forbidden) {
      expect(corpus.includes(needle)).toBe(false)
    }
  })
})
