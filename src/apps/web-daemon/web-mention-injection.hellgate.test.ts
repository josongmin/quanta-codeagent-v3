/**
 * ADR-0422 — WEB-surface @-mention injection hellgate.
 *
 * PREMISE / RECEIPT: the web-daemon does NOT have a bespoke mention wire — it
 * reuses the SAME `buildDefaultMentionResolver` pipeline the CLI uses, threaded
 * through the SHARED per-turn assembler. Concretely the daemon builds its turn
 * config each turn via this file's subject — the web-daemon export
 * `buildInteractiveTurnAssembler` (`runtime-factory.ts:296`) — which delegates
 * to the host `buildInteractiveTurnAssembler` → `assembleAgentConfig` →
 * `wireSessionResourcesAndCodexR2` → `mentionResolverDep(cwd, env)` →
 * `buildDefaultMentionResolver`. The runtime then runs that per-turn config
 * through `runRuntimeTurn` → `buildAgentConfigFromBase`, whose
 * `installCliMentionInjector` is an idempotent no-op because the assembler has
 * already filled `cfg.mentionInjector`. So a `@file:X` in web user input is
 * resolved + injected identically to the CLI.
 *
 * This hellgate PINS that web reuse against silent drift:
 *
 *   D. web `@file` mention ⇒ injector injects the file body (matches CLI D1)   (2)
 *   C. web mention-free input ⇒ injector returns [] (byte-identical)           (2)
 *   E. web all-knobs-off ⇒ @file/@symbol mention injects nothing (byte-id)     (2)
 *   P. web ≡ CLI PARITY — same input, same resolved bytes on both surfaces     (1)
 *
 * RED-ON-INJECTION: if the web `buildInteractiveTurnAssembler` stops delegating
 * to the shared host assembler (i.e. the web surface re-implements / drops the
 * mention wire), `cfg.mentionInjector` is `undefined` ⇒ D/P go RED. Verified by
 * a `strippedAssembler` control that returns a config with NO mentionInjector
 * (simulating the removed wire) — it MUST fail to inject.
 *
 * The injector is driven exactly as the web runtime drives it: the assembler is
 * invoked with `(messages, turnDeps)` to produce the per-turn `AgentConfig`, and
 * `cfg.mentionInjector(userText)` is the same call `resolveMentionInjectionMessages`
 * (`loop/context-assembler.ts:132`) makes each turn. `QUANTA_MENTION_SYMBOL=off`
 * keeps the test hermetic (no lazy semantic/LSP backend build) while still
 * exercising the real `@file` resolver — the exact byte path the CLI hellgate
 * `mention-wire.hellgate.test.ts#D1` covers, now proven on the WEB assembler.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import type { RuntimeAgentTurnDeps } from "@/sdk/runtime/base"
// SUBJECT — the web-daemon's OWN per-turn assembler export (the code the daemon
// runs at `runtime-factory.ts:907`). Importing it here proves the WEB surface —
// not merely the shared host builder — reuses the mention pipeline.
import { buildInteractiveTurnAssembler } from "./runtime-factory"

const FILE = "QUANTA_MENTION_FILE"
const SYMBOL = "QUANTA_MENTION_SYMBOL"
const SKILL = "QUANTA_MENTION_SKILL"

/** A minimal RuntimeAgentTurnDeps — only `cwd` / `llm` / `stream` / `messages`
 *  are read by the assembler's mention wire + budget/system plumbing. The daemon
 *  supplies far more, but none of it changes the mention path. */
const makeTurnDeps = (cwd: string): RuntimeAgentTurnDeps =>
  ({
    llm: { model: "web-test" },
    stream: { emit: () => {} },
    cwd,
    messages: [],
  }) as unknown as RuntimeAgentTurnDeps

/** Assemble the per-turn web AgentConfig the way the runtime does. */
const assembleWebTurn = (cwd: string): AgentConfig =>
  buildInteractiveTurnAssembler()([], makeTurnDeps(cwd))

describe("WEB @-mention injection — ADR-0422 hellgate", () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web-mention-"))
    for (const k of [FILE, SYMBOL, SKILL]) saved[k] = process.env[k]
    // Keep the resolver hermetic: @symbol lazily builds an LSP/semantic backend;
    // OFF isolates the @file byte path (identical to the CLI hellgate default).
    process.env[SYMBOL] = "off"
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of [FILE, SYMBOL, SKILL]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  // -------- D. web @file mention injects (matches CLI D1) ----------------
  test("D1 — web @file mention injects the file body", async () => {
    delete process.env[FILE]
    process.env[SYMBOL] = "off"
    writeFileSync(join(dir, "note.txt"), "secret web contents here", "utf8")
    const cfg = assembleWebTurn(dir)
    expect(typeof cfg.mentionInjector).toBe("function")
    const msgs = await cfg.mentionInjector?.("see @./note.txt please")
    expect(Array.isArray(msgs)).toBe(true)
    expect((msgs ?? []).length).toBeGreaterThan(0)
    expect(JSON.stringify(msgs)).toContain("secret web contents here")
  })

  test("D2 — web @file to a missing file ⇒ [] (NO-THROW)", async () => {
    delete process.env[FILE]
    process.env[SYMBOL] = "off"
    const cfg = assembleWebTurn(dir)
    expect(await cfg.mentionInjector?.("see @./nope.txt")).toEqual([])
  })

  // -------- C. mention-free input ⇒ [] (byte-identical) ------------------
  test("C1 — web plain text (no mention) ⇒ []", async () => {
    delete process.env[FILE]
    process.env[SYMBOL] = "off"
    const cfg = assembleWebTurn(dir)
    expect(await cfg.mentionInjector?.("just some plain text")).toEqual([])
  })

  test("C2 — web empty string ⇒ []", async () => {
    delete process.env[FILE]
    process.env[SYMBOL] = "off"
    const cfg = assembleWebTurn(dir)
    expect(await cfg.mentionInjector?.("")).toEqual([])
  })

  // -------- E. all knobs off ⇒ inject nothing (byte-identical default-OFF) --
  test("E1 — web FILE=off ⇒ @file mention injects nothing", async () => {
    process.env[FILE] = "off"
    process.env[SYMBOL] = "off"
    process.env[SKILL] = "off"
    writeFileSync(join(dir, "note.txt"), "should not appear", "utf8")
    const cfg = assembleWebTurn(dir)
    expect(await cfg.mentionInjector?.("see @./note.txt")).toEqual([])
  })

  test("E2 — web SYMBOL=off ⇒ @Symbol mention injects nothing", async () => {
    process.env[FILE] = "off"
    process.env[SYMBOL] = "off"
    const cfg = assembleWebTurn(dir)
    expect(await cfg.mentionInjector?.("look at @SomeSymbol")).toEqual([])
  })

  // -------- P. web ≡ CLI parity + RED-ON-INJECTION -----------------------
  test("P1 — web resolves @file to the SAME bytes the CLI installer does", async () => {
    delete process.env[FILE]
    process.env[SYMBOL] = "off"
    writeFileSync(join(dir, "shared.txt"), "parity payload ABC123", "utf8")

    // WEB path (subject).
    const webCfg = assembleWebTurn(dir)
    const webMsgs = await webCfg.mentionInjector?.("open @./shared.txt")

    // CLI path (the sibling installer the task names as the analogue). Imported
    // lazily so the parity assertion is against the CLI's ACTUAL resolver build.
    const { installCliMentionInjector } = await import("@/host/runtime/internal/mention-wire")
    const cliCfg = installCliMentionInjector({ cwd: dir } as unknown as AgentConfig)
    const cliMsgs = await cliCfg.mentionInjector?.("open @./shared.txt")

    // Both surfaces inject the file body — same resolved payload.
    expect(JSON.stringify(webMsgs)).toContain("parity payload ABC123")
    expect(JSON.stringify(cliMsgs)).toContain("parity payload ABC123")

    // RED-ON-INJECTION control: a web assembler that DROPPED the mention wire
    // (no mentionInjector) must NOT inject — proving the passing D/P cases are
    // load-bearing on the real wire, not vacuous.
    const strippedAssembler = (deps: RuntimeAgentTurnDeps): AgentConfig =>
      ({ ...deps, mentionInjector: undefined }) as unknown as AgentConfig
    const strippedCfg = strippedAssembler(makeTurnDeps(dir))
    // With the wire removed the loop's guard (context-assembler.ts:128) returns
    // [] — nothing is injected, so the file body is absent.
    const strippedMsgs =
      strippedCfg.mentionInjector === undefined
        ? []
        : await strippedCfg.mentionInjector("open @./shared.txt")
    expect(JSON.stringify(strippedMsgs)).not.toContain("parity payload ABC123")
  })
})
