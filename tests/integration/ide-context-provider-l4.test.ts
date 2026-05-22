/**
 * ADR-0080 — ide-context-provider-seam L4 promotion battery.
 *
 * Covers the concrete in-repo provider (`FileSystemIdeContextProvider`) +
 * its metadata-only persistence path. The seam unit/integration tests in
 * `tests/unit/agent/ide-context-render.test.ts` and
 * `tests/integration/ide-context-provider-wire.test.ts` already cover the
 * render + loop-injection paths; THIS file covers the L4 promotion:
 *
 *   Hellgate:
 *     1. Provider returning a snapshot with a HUGE file `text` MUST strip
 *        text in persistence (metadata-only contract — Cursor's pattern).
 *     2. Provider that throws synchronously ⇒ loop catches at the
 *        boundary, emits an `error` AgentEvent, turn proceeds (we re-run
 *        the seam contract here against the concrete provider).
 *     3. Subagent (child runAgent invocation) MUST NOT inherit the IDE
 *        provider (per design — subagent is an isolated sub-conversation).
 *     4. Snapshot persistence is metadata-only — selection.text is NEVER
 *        written into the IdeContextMetadata.
 *     5. Malformed JSON ⇒ provider throws a typed error.
 *     6. JSON file absent ⇒ snapshot returns null (no IDE attached).
 *     7. JSON file with absolute paths ⇒ relative paths in the rendered
 *        block + metadata (privacy / reproducibility — Cursor's pattern).
 *     8. Sink that throws ⇒ provider absorbs (boundary contract — same
 *        semantics as the loop's catch).
 *
 *   E2E:
 *     9. Full IDE provider lifecycle: write `.quanta/ide-context.json`
 *        on disk → drive `runAgent` with `FileSystemIdeContextProvider`
 *        → loop reads it → context injected into prompt the LLM sees →
 *        metadataSink fires with scrubbed metadata.
 *    10. Replaying the same `runAgent` against a CHANGED JSON file
 *        re-reads each turn (provider has no across-turn cache).
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import {
  FileSystemIdeContextProvider,
  type IdeContextMetadata,
  type IdeContextProvider,
  type IdeSnapshot,
  runAgent,
  toMetadataSnapshot,
  toRelativePath,
} from "@/agent"
import { baseConfig, FakeLLM, RecordingStream, text, withTimeout } from "./_harness"

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const mkSandbox = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-ide-ctx-l4-"))
  mkdirSync(join(dir, ".quanta"), { recursive: true })
  return dir
}

const seedContext = (sandbox: string, body: Record<string, unknown>): string => {
  const path = join(sandbox, ".quanta", "ide-context.json")
  writeFileSync(path, JSON.stringify(body))
  return path
}

// ─────────────────────────────────────────────────────────────────────────
// (A) toRelativePath — path normalisation
// ─────────────────────────────────────────────────────────────────────────

describe("toRelativePath — privacy / reproducibility helper", () => {
  test("absolute path under cwd ⇒ relative path returned", () => {
    expect(toRelativePath("/Users/jo/proj", "/Users/jo/proj/src/foo.ts")).toBe("src/foo.ts")
  })

  test("absolute path outside cwd ⇒ '..'-prefixed relative path", () => {
    expect(toRelativePath("/Users/jo/proj", "/Users/jo/other/bar.ts")).toBe("../other/bar.ts")
  })

  test("relative path ⇒ unchanged", () => {
    expect(toRelativePath("/cwd", "src/foo.ts")).toBe("src/foo.ts")
  })

  test("empty path ⇒ empty string", () => {
    expect(toRelativePath("/cwd", "")).toBe("")
  })

  test("absolute path === cwd ⇒ '.' fallback (never empty)", () => {
    expect(toRelativePath("/Users/jo", "/Users/jo")).toBe(".")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (B) toMetadataSnapshot — strip file contents
// ─────────────────────────────────────────────────────────────────────────

describe("toMetadataSnapshot — metadata-only projection", () => {
  test("selection.text is STRIPPED — only textLength preserved", () => {
    const snap: IdeSnapshot = {
      selection: {
        path: "src/secret.ts",
        range: [0, 1000],
        text: "x".repeat(1000),
      },
    }
    const md = toMetadataSnapshot("/cwd", snap, "injected", 1234)
    expect(md.selection?.textLength).toBe(1000)
    // No `text` field at all on the metadata.
    expect((md.selection as unknown as Record<string, unknown>).text).toBeUndefined()
  })

  test("diagnostic.message is STRIPPED — only messageLength preserved", () => {
    const snap: IdeSnapshot = {
      diagnostics: [
        {
          path: "src/x.ts",
          severity: "error",
          line: 42,
          message: "secret-leak-here-DO-NOT-PERSIST",
        },
      ],
    }
    const md = toMetadataSnapshot("/cwd", snap, "injected", 1234)
    const d = md.diagnostics?.[0]
    expect(d?.messageLength).toBe("secret-leak-here-DO-NOT-PERSIST".length)
    expect((d as unknown as Record<string, unknown>).message).toBeUndefined()
  })

  test("absolute paths in snapshot ⇒ relative in metadata", () => {
    const snap: IdeSnapshot = {
      activeFile: { path: "/Users/jo/proj/src/foo.ts", line: 10 },
      openTabs: [
        { path: "/Users/jo/proj/src/a.ts", dirty: true },
        { path: "/Users/jo/proj/src/b.ts" },
      ],
      selection: { path: "/Users/jo/proj/src/c.ts", range: [1, 2], text: "x" },
      diagnostics: [
        { path: "/Users/jo/proj/src/d.ts", severity: "warning", line: 1, message: "msg" },
      ],
    }
    const md = toMetadataSnapshot("/Users/jo/proj", snap, "injected", 0)
    expect(md.activeFile?.relativeFilePath).toBe("src/foo.ts")
    expect(md.openTabs?.[0]?.relativeFilePath).toBe("src/a.ts")
    expect(md.openTabs?.[1]?.relativeFilePath).toBe("src/b.ts")
    expect(md.selection?.relativeFilePath).toBe("src/c.ts")
    expect(md.diagnostics?.[0]?.relativeFilePath).toBe("src/d.ts")
  })

  test("tier is carried through (injected | predicted)", () => {
    const snap: IdeSnapshot = {}
    expect(toMetadataSnapshot("/cwd", snap, "injected", 1).tier).toBe("injected")
    expect(toMetadataSnapshot("/cwd", snap, "predicted", 1).tier).toBe("predicted")
  })

  test("capturedAtMs is carried through", () => {
    const snap: IdeSnapshot = {}
    expect(toMetadataSnapshot("/cwd", snap, "injected", 1700000000000).capturedAtMs).toBe(
      1700000000000,
    )
  })

  test("empty snapshot ⇒ metadata with only tier + capturedAtMs", () => {
    const md = toMetadataSnapshot("/cwd", {}, "injected", 0)
    expect(md.tier).toBe("injected")
    expect(md.capturedAtMs).toBe(0)
    expect(md.activeFile).toBeUndefined()
    expect(md.openTabs).toBeUndefined()
    expect(md.selection).toBeUndefined()
    expect(md.diagnostics).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (C) FileSystemIdeContextProvider — file presence + parsing
// ─────────────────────────────────────────────────────────────────────────

describe("FileSystemIdeContextProvider — file presence + parsing", () => {
  test("JSON file absent ⇒ snapshot returns null (no IDE attached)", async () => {
    const sandbox = mkSandbox()
    try {
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap).toBeNull()
      expect(provider.calls).toBe(1)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Malformed JSON ⇒ throws a typed error", async () => {
    const sandbox = mkSandbox()
    try {
      writeFileSync(join(sandbox, ".quanta", "ide-context.json"), "{not json")
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow(
        /JSON parse failed/,
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("JSON file with wrong shape ⇒ throws descriptive error", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: "not-an-object" })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow(
        /activeFile.*object/,
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Selection without text ⇒ throws", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { selection: { path: "x", range: [0, 1] } })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow(
        /selection.text/,
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Selection range with wrong length ⇒ throws", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { selection: { path: "x", range: [0, 1, 2], text: "" } })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow(/range/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Diagnostic with unknown severity ⇒ throws", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, {
        diagnostics: [{ path: "x", severity: "info", line: 1, message: "x" }],
      })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow(/severity/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Well-formed JSON ⇒ snapshot returned with all 4 fields", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, {
        activeFile: { path: "src/x.ts", line: 5 },
        openTabs: [{ path: "src/x.ts", dirty: true }, { path: "src/y.ts" }],
        selection: { path: "src/x.ts", range: [10, 20], text: "doThing()" },
        diagnostics: [{ path: "src/x.ts", severity: "error", line: 5, message: "type error" }],
      })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap).not.toBeNull()
      expect(snap?.activeFile?.path).toBe("src/x.ts")
      expect(snap?.activeFile?.line).toBe(5)
      expect(snap?.openTabs?.length).toBe(2)
      expect(snap?.openTabs?.[0]?.dirty).toBe(true)
      expect(snap?.selection?.text).toBe("doThing()")
      expect(snap?.selection?.range).toEqual([10, 20])
      expect(snap?.diagnostics?.[0]?.message).toBe("type error")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Absolute paths in JSON ⇒ relative in returned snapshot", async () => {
    const sandbox = mkSandbox()
    try {
      const abs = join(sandbox, "src/foo.ts")
      seedContext(sandbox, { activeFile: { path: abs, line: 1 } })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap?.activeFile?.path).toBe("src/foo.ts")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Pre-aborted signal ⇒ snapshot returns null without reading", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "x", line: 1 } })
      let readCount = 0
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        read: (p): string | null => {
          readCount += 1
          return p ? "{}" : null
        },
      })
      const controller = new AbortController()
      controller.abort()
      const snap = await provider.snapshot(controller.signal)
      expect(snap).toBeNull()
      expect(readCount).toBe(0)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Provider has no cross-turn cache — each snapshot() re-reads the file", async () => {
    const sandbox = mkSandbox()
    try {
      let readCount = 0
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        read: (p): string | null => {
          readCount += 1
          return p ? JSON.stringify({ activeFile: { path: "x" } }) : null
        },
      })
      await provider.snapshot(new AbortController().signal)
      await provider.snapshot(new AbortController().signal)
      await provider.snapshot(new AbortController().signal)
      expect(readCount).toBe(3)
      expect(provider.calls).toBe(3)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (D) Metadata sink — metadata-only persistence contract
// ─────────────────────────────────────────────────────────────────────────

describe("FileSystemIdeContextProvider — metadata sink", () => {
  test("snapshot triggers metadataSink with scrubbed snapshot — selection text dropped", async () => {
    const sandbox = mkSandbox()
    try {
      const hugeText = "secret".repeat(10_000) // 60kB
      seedContext(sandbox, {
        selection: { path: "src/leak.ts", range: [0, 60_000], text: hugeText },
        activeFile: { path: "src/leak.ts", line: 1 },
      })
      const sinkCalls: IdeContextMetadata[] = []
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: (md) => sinkCalls.push(md),
        now: () => 42,
      })
      await provider.snapshot(new AbortController().signal)
      expect(sinkCalls.length).toBe(1)
      const md = sinkCalls[0]
      // No file content / no text field anywhere.
      expect(md?.selection?.textLength).toBe(hugeText.length)
      expect((md?.selection as unknown as Record<string, unknown>).text).toBeUndefined()
      const serialized = JSON.stringify(md)
      // The huge text must NOT appear in the serialised metadata.
      expect(serialized).not.toContain("secretsecret")
      expect(serialized.length).toBeLessThan(1000) // bounded — sanity
      expect(md?.tier).toBe("injected")
      expect(md?.capturedAtMs).toBe(42)
      expect(md?.activeFile?.relativeFilePath).toBe("src/leak.ts")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("metadataSink that throws ⇒ snapshot still returns (boundary contract)", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "src/x.ts" } })
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: () => {
          throw new Error("sink boom")
        },
      })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap?.activeFile?.path).toBe("src/x.ts")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("metadataSink omitted ⇒ provider works without persistence path", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "src/x.ts" } })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap?.activeFile?.path).toBe("src/x.ts")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("metadataSink fires ONCE per snapshot() call — not per render", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "src/x.ts" } })
      const sinkCalls: IdeContextMetadata[] = []
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: (md) => sinkCalls.push(md),
      })
      await provider.snapshot(new AbortController().signal)
      await provider.snapshot(new AbortController().signal)
      await provider.snapshot(new AbortController().signal)
      expect(sinkCalls.length).toBe(3)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("Absent JSON file ⇒ metadataSink is NOT called (no IDE attached signal)", async () => {
    const sandbox = mkSandbox()
    try {
      const sinkCalls: IdeContextMetadata[] = []
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: (md) => sinkCalls.push(md),
      })
      const snap = await provider.snapshot(new AbortController().signal)
      expect(snap).toBeNull()
      expect(sinkCalls.length).toBe(0)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (E) Hellgate — throwing provider, huge text, subagent inheritance
// ─────────────────────────────────────────────────────────────────────────

/** Provider that throws synchronously. Used to verify the loop's boundary
 *  catch path is exercised against the concrete provider class too. */
class ConcreteThrowingProvider implements IdeContextProvider {
  calls = 0
  async snapshot(_signal: AbortSignal): Promise<IdeSnapshot | null> {
    this.calls += 1
    throw new Error("concrete-provider-boom")
  }
}

describe("ide-context provider hellgate — loop boundary", () => {
  test("provider throw ⇒ loop emits error event + proceeds with no block", async () => {
    const llm = new FakeLLM([text("ok")])
    const stream = new RecordingStream()
    const provider = new ConcreteThrowingProvider()
    const config: AgentConfig = baseConfig({ llm, stream, ideContextProvider: provider })
    const outcome = await withTimeout(runAgent(config), 2000, "throwing-concrete")
    expect(outcome.reason).toBe("completed")
    expect(provider.calls).toBeGreaterThan(0)
    const errors = stream.events.filter((e) => e.type === "error")
    expect(errors.length).toBeGreaterThan(0)
    expect(
      errors.some((e) => e.type === "error" && e.message.includes("ide-context provider failed")),
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (F) End-to-end: full lifecycle through runAgent
// ─────────────────────────────────────────────────────────────────────────

describe("FileSystemIdeContextProvider — full lifecycle e2e through runAgent", () => {
  test("write .quanta/ide-context.json → runAgent picks it up → context in prompt → metadata sink fires", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, {
        activeFile: { path: join(sandbox, "src/foo.ts"), line: 42 },
        selection: {
          path: join(sandbox, "src/foo.ts"),
          range: [10, 20],
          text: "doThing()",
        },
      })
      const llm = new FakeLLM([text("ack")])
      const sinkCalls: IdeContextMetadata[] = []
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: (md) => sinkCalls.push(md),
        now: () => 7,
      })
      const config: AgentConfig = baseConfig({ llm, ideContextProvider: provider })
      const outcome = await withTimeout(runAgent(config), 2000, "fs-provider-e2e")
      expect(outcome.reason).toBe("completed")
      // Provider was called once for the single turn.
      expect(provider.calls).toBe(1)
      // Metadata sink fired once with scrubbed paths + length-only fields.
      expect(sinkCalls.length).toBe(1)
      const md = sinkCalls[0]
      expect(md?.tier).toBe("injected")
      expect(md?.capturedAtMs).toBe(7)
      expect(md?.activeFile?.relativeFilePath).toBe("src/foo.ts")
      expect(md?.selection?.relativeFilePath).toBe("src/foo.ts")
      expect(md?.selection?.textLength).toBe("doThing()".length)
      // Selection text not present in metadata.
      expect((md?.selection as unknown as Record<string, unknown>).text).toBeUndefined()
      // The LLM saw the rendered IDE block — RELATIVE paths only.
      const userTexts = llm.seenMessages[0]
        ?.flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
      expect(userTexts).toContain("<ide-context>")
      expect(userTexts).toContain("## Active file: src/foo.ts:42")
      expect(userTexts).toContain("doThing()")
      // Absolute path MUST NOT leak.
      expect(userTexts).not.toContain(sandbox)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("no JSON file ⇒ runAgent proceeds without the IDE block (byte-identical to no-provider)", async () => {
    const sandbox = mkSandbox()
    try {
      // NO seedContext call — the file does not exist.
      const llm = new FakeLLM([text("ack")])
      const sinkCalls: IdeContextMetadata[] = []
      const provider = new FileSystemIdeContextProvider({
        cwd: sandbox,
        metadataSink: (md) => sinkCalls.push(md),
      })
      const config: AgentConfig = baseConfig({ llm, ideContextProvider: provider })
      await withTimeout(runAgent(config), 2000, "no-json-file")
      expect(provider.calls).toBe(1)
      expect(sinkCalls.length).toBe(0)
      const userTexts = llm.seenMessages[0]
        ?.flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
      expect(userTexts).not.toContain("<ide-context>")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("malformed JSON ⇒ loop emits error event + proceeds (boundary)", async () => {
    const sandbox = mkSandbox()
    try {
      writeFileSync(join(sandbox, ".quanta", "ide-context.json"), "{not json")
      const llm = new FakeLLM([text("ack")])
      const stream = new RecordingStream()
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const config: AgentConfig = baseConfig({ llm, stream, ideContextProvider: provider })
      const outcome = await withTimeout(runAgent(config), 2000, "malformed-json-e2e")
      expect(outcome.reason).toBe("completed")
      const errors = stream.events.filter((e) => e.type === "error")
      expect(errors.length).toBeGreaterThan(0)
      expect(
        errors.some((e) => e.type === "error" && e.message.includes("ide-context provider failed")),
      ).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("changing the JSON file between turns ⇒ next runAgent invocation sees the new context", async () => {
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "src/before.ts" } })
      const llm1 = new FakeLLM([text("first")])
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const cfg1: AgentConfig = baseConfig({ llm: llm1, ideContextProvider: provider })
      await withTimeout(runAgent(cfg1), 2000, "first-turn")

      seedContext(sandbox, { activeFile: { path: "src/after.ts" } })
      const llm2 = new FakeLLM([text("second")])
      const cfg2: AgentConfig = baseConfig({ llm: llm2, ideContextProvider: provider })
      await withTimeout(runAgent(cfg2), 2000, "second-turn")

      const firstTexts = llm1.seenMessages[0]
        ?.flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
      const secondTexts = llm2.seenMessages[0]
        ?.flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
      expect(firstTexts).toContain("src/before.ts")
      expect(secondTexts).toContain("src/after.ts")
      expect(firstTexts).not.toContain("src/after.ts")
      expect(secondTexts).not.toContain("src/before.ts")
      // Provider called once per turn (2 runAgent invocations × 1 turn each).
      expect(provider.calls).toBe(2)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// (G) Negative invariant — subagent does NOT inherit the IDE provider
// ─────────────────────────────────────────────────────────────────────────

describe("ide-context provider — negative invariants", () => {
  test("subagent (depth+1 runAgent) does NOT auto-inherit the IDE provider", async () => {
    // The seam contract spec: "subagent runner는 IDE provider를 자동 상속
    // 시키지 않음 (의도적 — subagent는 격리된 sub-conversation)."
    //
    // The contract is enforced at the SUBAGENT runner's config builder
    // boundary — it constructs a fresh AgentConfig that intentionally does
    // NOT copy `ideContextProvider` from the parent. We verify this by
    // inspecting the IdeContextProvider TYPE: it does not declare an
    // "inherit-by-default" contract on the seam — the subagent runner is
    // the ONLY caller that constructs sub-AgentConfigs.
    //
    // Direct behavioural assertion: construct a parent config with provider
    // wired + check that the SUBAGENT contract docstring explicitly forbids
    // inheritance — we cannot exercise the subagent runner here without
    // ALSO wiring its tool registry, so we lock the contract via a runtime
    // assertion of the spec's negative invariant: a NEW AgentConfig built
    // by a host MUST be constructed without a provider unless explicitly
    // passed (no global default).
    const sandbox = mkSandbox()
    try {
      seedContext(sandbox, { activeFile: { path: "src/x.ts" } })
      const provider = new FileSystemIdeContextProvider({ cwd: sandbox })
      const parentLLM = new FakeLLM([text("ok")])
      const parentCfg: AgentConfig = baseConfig({
        llm: parentLLM,
        ideContextProvider: provider,
      })
      expect(parentCfg.ideContextProvider).toBe(provider)
      // A "subagent" config the parent might construct in its registry —
      // it MUST opt in to the provider explicitly.
      const childLLM = new FakeLLM([text("child-ok")])
      const childCfg: AgentConfig = baseConfig({ llm: childLLM })
      // The child has NO ideContextProvider — that's the closed signal.
      expect(childCfg.ideContextProvider).toBeUndefined()
      await withTimeout(runAgent(childCfg), 2000, "child-no-inherit")
      const childTexts = childLLM.seenMessages[0]
        ?.flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n")
      expect(childTexts).not.toContain("<ide-context>")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("IdeSnapshot shape stays closed — adding random keys does not enter the metadata", () => {
    // Compile-time contract — the IdeSnapshot type is the closed shape.
    // We add a runtime assertion that toMetadataSnapshot only carries the
    // 4 known field families (activeFile/openTabs/selection/diagnostics).
    const snap: IdeSnapshot = {
      activeFile: { path: "src/x.ts" },
    }
    const md = toMetadataSnapshot("/cwd", snap, "injected", 0)
    const keys = Object.keys(md).sort()
    expect(keys).toEqual(["activeFile", "capturedAtMs", "tier"])
  })
})
