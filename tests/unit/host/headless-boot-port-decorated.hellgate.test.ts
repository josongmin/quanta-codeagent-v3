import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { type LLMPort, type StreamEvent, type StreamInput, tryCreateLLM } from "@/llm"
import { decorateSwappableModelPort } from "@/runner/assemble"
import { __resetRuntimeConfig, LLMError } from "@/shared"

/**
 * MR-E5 HELLGATE — the HEADLESS composition root's BOOT port must carry the same
 * always-on safety net as every other port on that root.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 * `buildBaseFromArgs` put the RAW `tryCreateLLM(...)` adapter on `base.llm`,
 * while the CLI wrapped its boot port via `composeLLMCore`. The irony was exact:
 * on that SAME headless root a SWAPPED model IS decorated
 * (`agent-arg-builder/model-switch-wire.ts` calls `decorateSwappableModelPort`
 * for every `modelCandidates` port), so the model you switched TO kept bounded
 * retry / the empty-stream circuit breaker / the progress heartbeat while the
 * DEFAULT model ran bare — a transient 429 was a hard turn failure on
 * `quanta -p`, and on every bench/batch row (`mode-presets/batch.ts` runs each
 * instance on `req.base.llm`).
 *
 * ── What is proven here ──────────────────────────────────────────────────────
 *   A. STRUCTURE (root): `base.llm` is NOT the bare adapter — it is the exact
 *      object shape `decorateSwappableModelPort` produces — and every identity
 *      field the bare adapter carries still forwards through the wrapper.
 *      PAIRED CONTROL: the bare adapter built from the same inputs IS a class
 *      instance with the adapter's own key set.
 *   B. BEHAVIOUR (the wrapper the root installs): a transient failure before the
 *      first event is RETRIED, and `listModels` / `contextWindowKey` / `provider`
 *      survive the wrap. PAIRED CONTROL: the same inner port, undecorated,
 *      throws.
 *
 * Structure alone would pass for a no-op wrapper; behaviour alone would not
 * prove the ROOT installs it. Both together are the gate.
 *
 * MACHINE-INDEPENDENCE: `pickProvider` prefers an on-disk ChatGPT-OAuth token
 * over `OPENAI_API_KEY` (measured), so the provider is pinned and the OAuth /
 * prefs / config homes point at a per-run scratch dir. The developer's real
 * `~/.quanta` is never read or written.
 */

const DRIVEN = [
  "QUANTA_MODEL",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "QUANTA_CONFIG_DIR",
  "QUANTA_PREFS_HOME",
  "CODEX_HOME",
  "QUANTA_MEMORY",
  "QUANTA_SUBAGENT",
  "QUANTA_LLM_STREAM_TRACE_MS",
  "QUANTA_LLM_EMPTY_STREAM_BREAKER_K",
] as const

const saved: Record<string, string | undefined> = {}
let scratch: string

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  scratch = mkdtempSync(join(tmpdir(), "mr-e5-boot-port-"))
  process.env.QUANTA_CONFIG_DIR = join(scratch, "config")
  process.env.QUANTA_PREFS_HOME = join(scratch, "prefs")
  process.env.CODEX_HOME = join(scratch, "codex")
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-mr-e5"
  process.env.QUANTA_MEMORY = "off"
  process.env.QUANTA_SUBAGENT = "0"
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(scratch, { recursive: true, force: true })
  __resetRuntimeConfig()
})

const buildBase = () =>
  buildBaseFromArgs({ mode: "interactive", dials: {} }, undefined, undefined, {
    stickyModelPath: join(scratch, "nonexistent-sticky.json"),
  })

/** The BARE adapter the root would previously have put on `base.llm`, built
 *  from the same provider/model/env inputs. */
const bareAdapter = (): LLMPort => {
  const p = tryCreateLLM("openai", { model: "gpt-5.6-terra" }, process.env)
  if (p === null) throw new Error("test setup: expected an openai adapter")
  return p
}

describe("MR-E5 (A) headless base.llm is DECORATED, not the bare adapter", () => {
  test("base.llm is not a class instance — it is the decorator's plain port object", () => {
    const llm = buildBase().llm
    const bare = bareAdapter()
    // PAIRED CONTROL first: the bare adapter really is a class instance, so the
    // assertion below cannot pass vacuously on a shapeless stub.
    expect(Object.getPrototypeOf(bare)).not.toBe(Object.prototype)
    expect(bare.constructor.name).not.toBe("Object")
    // The decorated port is the object literal `withStreamProgressTrace` returns.
    expect(Object.getPrototypeOf(llm)).toBe(Object.prototype)
  })

  test("base.llm's own-key set is EXACTLY decorateSwappableModelPort's, not the adapter's", () => {
    const llm = buildBase().llm
    const bare = bareAdapter()
    const expected = decorateSwappableModelPort({ inner: bareAdapter() })
    expect(Object.keys(llm).sort()).toEqual(Object.keys(expected).sort())
    // Non-vacuity: the adapter's own-key set is DIFFERENT (it carries the wire
    // config — env / fetchImpl / streamTimeoutMs / reasoning knobs — that the
    // identity forwarder deliberately does not copy).
    expect(Object.keys(llm).sort()).not.toEqual(Object.keys(bare).sort())
  })

  test("every identity field the adapter carries still forwards through the wrapper", () => {
    const llm = buildBase().llm
    const bare = bareAdapter()
    for (const field of ["model", "provider", "surfaceId", "transportId", "authMode"] as const) {
      // Control: the adapter actually HAS this field (else the check is empty).
      expect(bare[field]).toBeDefined()
      expect(llm[field]).toBe(bare[field])
    }
    // `listModels` is the `/model` catalog probe — the field a decorator that
    // rebuilt the port by hand historically ate.
    expect(typeof bare.listModels).toBe("function")
    expect(typeof llm.listModels).toBe("function")
    // `contextWindowKey` is absent on this adapter (it is an Anthropic
    // context-1m signal), so presence must MATCH rather than be asserted — the
    // wrapper must not invent it either. Its positive forwarding is proven in
    // (B) below with an inner port that actually carries one.
    expect("contextWindowKey" in llm).toBe("contextWindowKey" in bare)
  })
})

// ── (B) the wrapper the root installs actually does something ────────────────

/** A port that throws a RETRYABLE error before yielding its first event, for
 *  the first `failures` attempts, then streams one text delta. */
const flakyPort = (failures: number): LLMPort & { attempts: number } => {
  const port = {
    attempts: 0,
    model: "mr-e5-fake",
    provider: "openai" as const,
    contextWindowKey: "mr-e5-window-key",
    listModels: async (): Promise<readonly string[]> => ["mr-e5-a", "mr-e5-b"],
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      port.attempts += 1
      const shouldFail = port.attempts <= failures
      return (async function* (): AsyncIterable<StreamEvent> {
        if (shouldFail) {
          throw new LLMError("rate limited", { kind: "rate_limit", provider: "openai" })
        }
        yield { type: "text_delta", delta: "ok" }
      })()
    },
  }
  return port
}

const drain = async (port: LLMPort): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const e of port.stream({ messages: [], system: "" } as unknown as StreamInput)) {
    out.push(e)
  }
  return out
}

describe("MR-E5 (B) the installed wrapper retries and preserves identity", () => {
  test("PAIRED CONTROL: the UNDECORATED port surfaces the transient failure", async () => {
    const inner = flakyPort(1)
    await expect(drain(inner)).rejects.toThrow(/rate limited/)
    expect(inner.attempts).toBe(1)
  })

  test("decorateSwappableModelPort retries the transient failure to success", async () => {
    const inner = flakyPort(1)
    const events = await drain(decorateSwappableModelPort({ inner }))
    expect(inner.attempts).toBe(2)
    expect(events).toHaveLength(1)
  })

  test("listModels / contextWindowKey / provider survive the wrap", async () => {
    const inner = flakyPort(0)
    const wrapped = decorateSwappableModelPort({ inner })
    expect(wrapped.provider).toBe("openai")
    expect(wrapped.model).toBe("mr-e5-fake")
    expect(wrapped.contextWindowKey).toBe("mr-e5-window-key")
    expect(await wrapped.listModels?.()).toEqual(["mr-e5-a", "mr-e5-b"])
  })
})
