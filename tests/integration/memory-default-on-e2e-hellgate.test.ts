/**
 * ADR-0414 END-TO-END HELLGATE — memory learning DEFAULT-ON, proven through
 * the REAL composition chain rather than the factory unit alone.
 *
 * The factory unit test (`tests/unit/memory-factory-hellgate.test.ts`) proves
 * `buildMemoryForSession` resolves the right SLOTS. It does NOT prove the slots
 * actually FLOW into a runnable session, that the durable default writes under
 * HOME and nothing under the cwd (ADR-0557), that a sqlite store survives a
 * reopen, or that the bench/escape paths are byte-identical to the legacy
 * no-memory loop.
 *
 * This file seals those holes by exercising the production wire:
 *
 *   buildMemoryForSession(env)            ← surface env read (default-ON)
 *     → buildToolingCore({ store, … })    ← Tooling.store (the CLI's buildTooling core)
 *       → assembleConfig(history, deps)   ← config.store (host/runtime context-binding)
 *         → runAgent(config)              ← loop.resolveMemoryContext → recallContext
 *
 * Adversarial focus:
 *   1. default-ON real flow:  env unset ⇒ durable SqliteStore (ADR-0557, under
 *      an injected temp home) + config, and a save→recall roundtrip on THAT
 *      store actually returns the entry.
 *   2. CLI assembly e2e:      the default-ON store survives buildToolingCore →
 *      assembleConfig so `config.store` is the SAME instance the loop recalls.
 *   3. real runAgent recall:  a fact saved in "session 1" surfaces in the
 *      recalled <system-reminder> tail of "session 2" — when the store came
 *      from the default-ON factory (NOT a hand-built store).
 *   4. sqlite opt-in:         QUANTA_MEMORY=sqlite + temp path writes a real
 *      on-disk file, persists, and a fresh factory call REOPENS + restores it.
 *   5. home-scoped, not cwd:  env unset ⇒ the store lands under
 *      `<quanta home>/memory/` and NO `.quanta/memory.sqlite` appears in the
 *      cwd (proven by running inside a temp cwd with a temp home — ADR-0557).
 *      `override.homeDir` is the QUANTA home root since f4b71f89f (memory follows
 *      QUANTA_HOME), so the store is `<homeDir>/memory/memory.sqlite`; these two arms
 *      still expected the OS-home spelling `<homeDir>/.quanta/memory/…` and were red
 *      from that commit until sep-14 — the integration tier was not run against it.
 *   6. escape byte-identical: QUANTA_MEMORY=off AND override.storeDisabled both
 *      collapse to `{}` ⇒ config has NO store ⇒ the loop's recall/persist are
 *      skipped ⇒ the LLM sees the SAME messages as a legacy no-memory run.
 *   7. bench determinism:     override.storeDisabled=true ⇒ two runs over the
 *      same env produce identical (store-free) config + identical LLM inputs.
 *   8. auto gate orthogonal: QUANTA_MEMORY_AUTO=off leaves the factory shape
 *      untouched (store stays ON; the gate is read elsewhere — ADR-0556).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { type MemoryEntry, SqliteStore } from "@/memory"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
import { buildMemoryForSession, buildToolingCore, type Tooling } from "@/runner/assemble"
import { assembleConfig, type SessionDeps } from "@/runner/assemble/config"
import type { AgentEvent, StreamPort } from "@/stream"

/* ------------------------------------------------------------------ */
/* fakes (self-contained — no harness coupling)                        */
/* ------------------------------------------------------------------ */

/** Scriptable fake LLM. Records every {@link StreamInput}. The distill prompt
 *  (system text marker) emits a scripted JSON array; any normal turn emits a
 *  final assistant text so the loop completes in one turn. */
class FakeLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  constructor(
    private readonly distillJson: string,
    private readonly finalText = "done",
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
    const lastText = (lastUser?.content ?? [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    const out = lastText.includes("You distill durable long-term memory")
      ? this.distillJson
      : this.finalText
    yield { type: "text_delta", delta: out }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** No-op stream sink that records events for assertions. */
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Real {@link StructuredLogger} with a no-op sink — `buildToolingCore` only
 *  logs for opt-in configs (all undefined here), so nothing is emitted; the
 *  sink swallows any line without touching stdout. */
const silentSlog = (): StructuredLogger => new StructuredLogger({ sink: () => undefined })

const env = (e: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  e as NodeJS.ProcessEnv

/** Build a Tooling bundle through the SAME core the CLI's `buildTooling`
 *  invokes (`buildToolingCore`), seeded from a memory-factory slot. This is the
 *  real surface path minus the env read + uuid mint (supplied here). */
const toolingFromSlot = (
  slot: ReturnType<typeof buildMemoryForSession>,
  sessionId = "e2e-session",
): Tooling =>
  buildToolingCore({
    store: slot.store,
    embedder: undefined,
    sessionId,
    memoryConfig: slot.config,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    mcpTools: [],
    lspTools: [],
    lspNavTools: [],
    gitToolList: [],
    slog: silentSlog(),
    memoryKindLabel: slot.kind ?? "memory",
    onMemoryReady: () => undefined,
  })

/** Build a minimal-but-type-correct {@link SessionDeps}. Every optional
 *  default-OFF slot is `undefined` (guarded by `!== undefined` spreads in
 *  `assembleConfig`), so only the memory-relevant fields drive behavior. The
 *  store/memoryConfig/embedder come from the Tooling bundle exactly like the
 *  host's `context-binding.ts` threads `boot.tooling.*`. */
const depsFromTooling = (tooling: Tooling, llm: LLMPort): SessionDeps => ({
  llm,
  registry: tooling.registry,
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 2,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  store: tooling.store,
  sessionId: tooling.sessionId,
  embedder: tooling.embedder,
  memoryConfig: tooling.memoryConfig,
  planMode: false,
  metrics: undefined,
  run: undefined,
  subagentConfig: tooling.subagentConfig,
  skillsConfig: tooling.skillsConfig,
  compactionBreakerConfig: tooling.compactionBreakerConfig,
  verifyGuardConfig: tooling.verifyGuardConfig,
  summarizerLlm: undefined,
  onShellEvent: undefined,
  workMetricsSink: undefined,
})

const lastUserTailText = (input: StreamInput | undefined): string => {
  const tail = input?.messages.at(-1)
  return tail?.role === "user"
    ? tail.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    : ""
}

const mkTmp = (label: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), `mem-e2e-${label}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** ADR-0557 — the durable default resolves under HOME; every default-env
 *  build in this file injects a temp home (+ the same dir as cwd) so the real
 *  `~/.quanta/` is never touched. Returns the slot + a cleanup that closes the
 *  sqlite handle and removes the dir. */
const buildDefault = (
  e: NodeJS.ProcessEnv,
  label: string,
): { slot: ReturnType<typeof buildMemoryForSession>; home: string; cleanup: () => void } => {
  const { dir, cleanup } = mkTmp(label)
  const slot = buildMemoryForSession(e, { homeDir: dir, cwd: dir })
  return {
    slot,
    home: dir,
    cleanup: () => {
      if (slot.store instanceof SqliteStore) slot.store.close()
      cleanup()
    },
  }
}

const entry = (over: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "text">): MemoryEntry => ({
  kind: "fact",
  tags: [],
  createdAt: Date.now(),
  ...over,
})

/* ================================================================== */
/* 1. default-ON real flow: factory store does a real save→recall      */
/* ================================================================== */

describe("ADR-0414 e2e — default-ON real flow (factory store roundtrip)", () => {
  // ADR-0557: the default store WAS the volatile InMemoryStore; it is now the
  // durable SqliteStore under the injected home.
  test("env unset ⇒ durable SqliteStore + config; save→recall returns the entry", async () => {
    const { slot, cleanup } = buildDefault(env({}), "flow")
    try {
      expect(slot.store).toBeInstanceOf(SqliteStore)
      expect(slot.config).toBeDefined()

      const store = slot.store
      if (!store) throw new Error("default-ON must yield a store")
      await store.save(entry({ id: "m1", text: "user prefers tabs over spaces", tags: ["pref"] }))
      const hits = await store.recall({ text: "tabs" })
      expect(hits.length).toBe(1)
      expect(hits[0]?.text).toBe("user prefers tabs over spaces")
    } finally {
      cleanup()
    }
  })
})

/* ================================================================== */
/* 2. CLI assembly e2e: store flows factory → tooling → assembleConfig */
/* ================================================================== */

describe("ADR-0414 e2e — CLI assembly threads the default-ON store to config.store", () => {
  test("buildToolingCore → assembleConfig yields config.store === the factory store", () => {
    const { slot, cleanup } = buildDefault(env({}), "assemble") // ADR-0557 temp home
    const tooling = toolingFromSlot(slot)
    // Tooling carries the same store identity the factory minted.
    expect(tooling.store).toBe(slot.store)
    expect(tooling.memoryConfig).toBe(slot.config)

    const config = assembleConfig(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      depsFromTooling(tooling, new FakeLLM("[]")),
    )
    // The loop reads `config.store`; prove it is present AND identity-equal.
    expect(config.store).toBe(slot.store)
    expect(config.memory).toBe(slot.config)
    expect(config.sessionId).toBe("e2e-session")
    cleanup()
  })

  test("memory_* self-edit tools register when the default-ON store exists", () => {
    const { slot, cleanup } = buildDefault(env({}), "tools") // ADR-0557 temp home
    const tooling = toolingFromSlot(slot)
    const names = tooling.registry.all().map((t) => t.name)
    expect(names.some((n) => n.startsWith("memory_"))).toBe(true)
    cleanup()
  })
})

/* ================================================================== */
/* 3. real runAgent recall using a store born from the default factory */
/* ================================================================== */

describe("ADR-0414 e2e — recall reachable through real runAgent (default-ON store)", () => {
  test("fact saved via factory store surfaces in session-2 recalled tail", async () => {
    // The store comes from the PRODUCTION default-ON path, not a hand-built one.
    const { slot, cleanup: cleanupDefault } = buildDefault(env({}), "recall") // ADR-0557 temp home
    const store = slot.store
    if (!store) throw new Error("default-ON must yield a store")

    await store.save(
      entry({ id: "fact1", text: "the deploy key lives in vault/prod", tags: ["ops"] }),
    )

    const llm = new FakeLLM("[]", "acknowledged")
    const tooling = toolingFromSlot(slot, "s2")
    const config = assembleConfig(
      [{ role: "user", content: [{ type: "text", text: "where is the deploy key" }] }],
      depsFromTooling(tooling, llm),
    )
    const out = await runAgent(config)
    expect(out.reason).toBe("completed")

    // The first non-distill turn must carry the recalled memory hint tail.
    const turnInput = llm.inputs.find((i) => {
      const lastUser = [...i.messages].reverse().find((m) => m.role === "user")
      const t = (lastUser?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n")
      return !t.includes("You distill durable long-term memory")
    })
    const tail = lastUserTailText(turnInput)
    expect(tail).toContain("<system-reminder>")
    expect(tail).toContain("the deploy key lives in vault/prod")
    cleanupDefault()
  })
})

/* ================================================================== */
/* 4. sqlite opt-in: real on-disk file + persist + reopen restore      */
/* ================================================================== */

describe("ADR-0414 e2e — sqlite is an explicit opt-in (on-disk persist + reopen)", () => {
  test("QUANTA_MEMORY=sqlite + temp path ⇒ real file, persist, fresh-factory reopen restores", async () => {
    const { dir, cleanup } = mkTmp("sqlite")
    try {
      const dbPath = join(dir, "memory.sqlite")
      const slot = buildMemoryForSession(
        env({ QUANTA_MEMORY: "sqlite", QUANTA_MEMORY_PATH: dbPath }),
      )
      expect(slot.store).toBeInstanceOf(SqliteStore)
      // The sqlite adapter opens the db eagerly in its constructor ⇒ file exists.
      expect(existsSync(dbPath)).toBe(true)

      const store1 = slot.store
      if (!store1) throw new Error("sqlite opt-in must yield a store")
      await store1.save(entry({ id: "persist1", text: "persisted across processes", tags: ["x"] }))

      // A SECOND factory call (simulating a fresh process) over the same path
      // must REOPEN the file and see the prior write.
      const slot2 = buildMemoryForSession(
        env({ QUANTA_MEMORY: "sqlite", QUANTA_MEMORY_PATH: dbPath }),
      )
      const store2 = slot2.store
      if (!store2) throw new Error("reopen must yield a store")
      const restored = await store2.get("persist1")
      expect(restored?.text).toBe("persisted across processes")
    } finally {
      cleanup()
    }
  })
})

/* ================================================================== */
/* 5. home-scoped, not cwd: env unset writes under HOME, ZERO bytes to cwd */
/* ================================================================== */

// ADR-0557: this section USED to pin "the volatile default writes NOTHING to
// disk". The default is now the durable home-scoped sqlite store; what stays
// pinned is the half that mattered for repo hygiene — nothing lands in the cwd.
describe("ADR-0557 e2e — durable default writes under the quanta home, never into the cwd", () => {
  test("env unset ⇒ store at <quanta home>/memory/memory.sqlite; no .quanta/ in the temp cwd", async () => {
    const { dir, cleanup } = mkTmp("nodisk")
    const home = mkTmp("home")
    const prevCwd = process.cwd()
    try {
      process.chdir(dir)
      const slot = buildMemoryForSession(env({}), { homeDir: home.dir, cwd: dir })
      expect(slot.store).toBeInstanceOf(SqliteStore)
      expect(slot.storePath).toBe(join(home.dir, "memory", "memory.sqlite"))
      // Drive a real write through the store — the durable store writes
      // under the quanta home, and STILL nothing under the cwd.
      await slot.store?.save(entry({ id: "v1", text: "durable under home" }))
      expect(existsSync(join(home.dir, "memory", "memory.sqlite"))).toBe(true)

      // No `.quanta` dir, no sqlite file anywhere in the temp cwd.
      const top = readdirSync(dir)
      expect(top).not.toContain(".quanta")
      expect(existsSync(join(dir, ".quanta", "memory.sqlite"))).toBe(false)
      expect(existsSync(join(dir, "memory.sqlite"))).toBe(false)
      if (slot.store instanceof SqliteStore) slot.store.close()
    } finally {
      process.chdir(prevCwd)
      cleanup()
      home.cleanup()
    }
  })

  test("bare truthy QUANTA_MEMORY=1 (the CLI seed) is durable too (under the quanta home, nothing in cwd)", async () => {
    const { dir, cleanup } = mkTmp("truthy")
    const home = mkTmp("home")
    const prevCwd = process.cwd()
    try {
      process.chdir(dir)
      const slot = buildMemoryForSession(env({ QUANTA_MEMORY: "1" }), {
        homeDir: home.dir,
        cwd: dir,
      })
      expect(slot.store).toBeInstanceOf(SqliteStore)
      await slot.store?.save(entry({ id: "t1", text: "truthy durable" }))
      expect(existsSync(join(dir, ".quanta"))).toBe(false)
      expect(existsSync(join(home.dir, "memory", "memory.sqlite"))).toBe(true)
      if (slot.store instanceof SqliteStore) slot.store.close()
    } finally {
      process.chdir(prevCwd)
      cleanup()
      home.cleanup()
    }
  })
})

/* ================================================================== */
/* 6. escape hatch byte-identical: off ≡ storeDisabled ≡ legacy        */
/* ================================================================== */

describe("ADR-0414 e2e — escape hatch is byte-identical to the legacy no-memory loop", () => {
  test("QUANTA_MEMORY=off ⇒ {} ⇒ config has NO store ⇒ recall/persist skipped, LLM sees no memory hints", async () => {
    const slot = buildMemoryForSession(env({ QUANTA_MEMORY: "off" }))
    expect(slot).toEqual({})

    const tooling = toolingFromSlot(slot)
    expect(tooling.store).toBeUndefined()

    const llm = new FakeLLM("[]", "final answer")
    const config = assembleConfig(
      [{ role: "user", content: [{ type: "text", text: "just answer" }] }],
      depsFromTooling(tooling, llm),
    )
    expect(config.store).toBeUndefined()
    expect(config.memory).toBeUndefined()

    const out = await runAgent(config)
    expect(out.reason).toBe("completed")
    // No store ⇒ no distill call ⇒ exactly ONE llm stream and no memory tail.
    expect(llm.inputs.length).toBe(1)
    const tail = lastUserTailText(llm.inputs[0])
    expect(tail).not.toContain("## Memory hints")
  })

  test("byte-identical: a config built with NO factory at all matches the QUANTA_MEMORY=off config (same llm transcript)", async () => {
    // Legacy run: an AgentConfig assembled with a store-free slot (== {}).
    const legacyLlm = new FakeLLM("[]", "legacy")
    const legacyTooling = toolingFromSlot({}, "legacy-session")
    const legacyConfig = assembleConfig(
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      depsFromTooling(legacyTooling, legacyLlm),
    )

    // Escape-hatch run: QUANTA_MEMORY=off resolved by the factory.
    const offLlm = new FakeLLM("[]", "legacy")
    const offTooling = toolingFromSlot(
      buildMemoryForSession(env({ QUANTA_MEMORY: "off" })),
      "legacy-session",
    )
    const offConfig = assembleConfig(
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      depsFromTooling(offTooling, offLlm),
    )

    expect(legacyConfig.store).toBeUndefined()
    expect(offConfig.store).toBeUndefined()
    expect("store" in legacyConfig).toBe(false)
    expect("store" in offConfig).toBe(false)
    expect("memory" in legacyConfig).toBe(false)
    expect("memory" in offConfig).toBe(false)

    await runAgent(legacyConfig)
    await runAgent(offConfig)
    // Identical LLM transcripts ⇒ behaviorally byte-identical.
    expect(offLlm.inputs.length).toBe(legacyLlm.inputs.length)
    expect(lastUserTailText(offLlm.inputs[0])).toBe(lastUserTailText(legacyLlm.inputs[0]))
  })
})

/* ================================================================== */
/* 7. bench determinism: storeDisabled override is deterministic       */
/* ================================================================== */

describe("ADR-0414 e2e — bench/replay determinism (override.storeDisabled)", () => {
  test("storeDisabled=true ⇒ {} even when env forces sqlite ON (bench one-knob)", () => {
    const { dir, cleanup } = mkTmp("bench")
    try {
      const slot = buildMemoryForSession(
        env({ QUANTA_MEMORY: "sqlite", QUANTA_MEMORY_PATH: join(dir, "x.sqlite") }),
        { storeDisabled: true },
      )
      expect(slot).toEqual({})
      // The hard escape hatch must NOT open the sqlite file.
      expect(existsSync(join(dir, "x.sqlite"))).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("two runs with storeDisabled ⇒ identical store-free config + identical LLM transcript", async () => {
    const e = env({})
    const runOnce = async (): Promise<{ hasStore: boolean; tail: string; calls: number }> => {
      const slot = buildMemoryForSession(e, { storeDisabled: true })
      const tooling = toolingFromSlot(slot, "bench-session")
      const llm = new FakeLLM("[]", "bench")
      const config = assembleConfig(
        [{ role: "user", content: [{ type: "text", text: "bench" }] }],
        depsFromTooling(tooling, llm),
      )
      await runAgent(config)
      return {
        hasStore: config.store !== undefined,
        tail: lastUserTailText(llm.inputs[0]),
        calls: llm.inputs.length,
      }
    }
    const a = await runOnce()
    const b = await runOnce()
    expect(a.hasStore).toBe(false)
    expect(b.hasStore).toBe(false)
    expect(a).toEqual(b)
  })
})

/* ================================================================== */
/* 8. auto-trigger gate orthogonal to the store slot                   */
/* ================================================================== */

describe("ADR-0414 e2e — auto-trigger gate is orthogonal to the store", () => {
  test("QUANTA_MEMORY_AUTO=off ⇒ store stays ON and the factory shape has no auto slot (ADR-0556)", () => {
    // ADR-0557: the store under test is the durable default (temp home).
    const { slot, cleanup } = buildDefault(env({ QUANTA_MEMORY_AUTO: "off" }), "auto-off")
    expect(slot.store).toBeInstanceOf(SqliteStore)
    expect(slot.config).toBeDefined()
    expect(Object.keys(slot).sort()).toEqual(["config", "kind", "store", "storePath"])
    cleanup()
  })

  test("sqlite path with a NON-EXISTENT parent directory ⇒ the parent is CREATED and the store opens (ADR-0557)", () => {
    // ADR-0557 flips the old pinned contract ("bun:sqlite cannot create the
    // parent ⇒ deterministic THROW"): `SqliteStore` now mkdir -p's the parent
    // before opening, because the default path lives under `~/.quanta/memory/`
    // which need not exist on a fresh machine. A store that still threw here
    // would crash session boot — that is the regression this now catches.
    const { dir, cleanup } = mkTmp("missing-parent")
    try {
      const nestedPath = join(dir, "does", "not", "exist", "memory.sqlite")
      const slot = buildMemoryForSession(
        env({ QUANTA_MEMORY: "sqlite", QUANTA_MEMORY_PATH: nestedPath }),
        { homeDir: dir, cwd: dir },
      )
      expect(slot.store).toBeInstanceOf(SqliteStore)
      expect(slot.kind).toBe("sqlite")
      expect(slot.storePath).toBe(nestedPath)
      expect(existsSync(nestedPath)).toBe(true)
      if (slot.store instanceof SqliteStore) slot.store.close()
    } finally {
      cleanup()
    }
  })
})
