/**
 * Hellgate — a `/model` pick can be UN-SET (aug-28, finding F7).
 *
 * THE DEFECT THIS CLOSES. The sticky-model store had `get`/`set`/`load`/`peek`
 * and no removal, and every surface above it rejects an empty id (an empty id is
 * what the resolver reads as "no override", so writing one would be a silent
 * no-op). So one `/model gpt-4o` was PERMANENT: it applied to every later session
 * for that provider+mode, and the only escape was hand-editing
 * `~/.quanta/sticky-model.json` or pinning `--model`/`QUANTA_MODEL` on every
 * invocation (which overrides a single run and leaves the stored pick standing).
 * "Go back to the session default" had no front door.
 *
 * WHAT MAKES THIS HARD ENOUGH TO NEED A HELLGATE. A clear has to land in THREE
 * places at once or it lies to the operator:
 *   A. the FILE — the next session must not resurrect the pick;
 *   B. the SESSION CELL (`sessionScopedStickyModelStore`) — the loop reads that,
 *      not the file, so a durable-only removal leaves THIS session on the cleared
 *      model while the file says otherwise;
 *   C. the SYNC display (`ModelAdapter.current()` → the store's `peek`) — a second
 *      cached copy of the pick anywhere here is the exact split-brain that was
 *      just deleted from `model-adapter.ts`.
 * …and it must be SURGICAL: only the key `/model <id>` writes (this provider, this
 * mode), never a sibling mode's or another provider's preference.
 *
 * Every case drives the REAL composition root (`composeSurfaceWires` +
 * `dispatchSlash`, the registered `/model` command, the real fs-backed store
 * under a session-scoped decorator) against a HERMETIC `QUANTA_CONFIG_DIR`, so
 * nothing here reads or writes the developer's `~/.quanta/sticky-model.json`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { effectiveModelOf } from "@/agent/effective-model"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { StickyModelWriteError, sessionScopedStickyModelStore } from "@/agent/sticky-model"
import type { StickyModelStore } from "@/agent/sticky-model/port"
import { stickyModelFilePath } from "@/apps/cli/repl/sticky-model-boot"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import { SURFACE_SLASH_COMMANDS } from "@/apps/cli/slash/registry-surface"
import type { SlashContext } from "@/apps/cli/slash-contract"
import type { LLMPort } from "@/llm"
import { makeFakeLlm, makeFakeSessionSetup } from "../_cli-fakes"

/** Scratch homes this file created, removed in `afterEach` (a leaked dir per case
 *  is what pushed `/private/tmp` past 36k entries and made `ls /tmp` time out). */
const scratchDirs: string[] = []
afterEach(() => {
  while (scratchDirs.length > 0) {
    const d = scratchDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const hermeticHome = (): { readonly dir: string; readonly env: NodeJS.ProcessEnv } => {
  const dir = mkdtempSync(join(tmpdir(), "sticky-clear-"))
  scratchDirs.push(dir)
  return {
    dir,
    // The provider key lets `tryCreateLLM("openai", …)` build a port for a
    // persisted id, so a pick is genuinely runnable here (an unrunnable one is
    // vetted out at boot and would make these cases vacuous).
    env: { QUANTA_CONFIG_DIR: dir, OPENAI_API_KEY: "sk-test-not-used" },
  }
}

/** Write a `{ "<provider>:<mode>" → modelId }` file exactly as the store would. */
const writePicks = (env: NodeJS.ProcessEnv, picks: Record<string, string>): string => {
  const path = stickyModelFilePath(env)
  writeFileSync(path, JSON.stringify(picks), "utf8")
  return path
}

const readFileJson = (env: NodeJS.ProcessEnv): Record<string, string> =>
  JSON.parse(readFileSync(stickyModelFilePath(env), "utf8")) as Record<string, string>

const compose = (env: NodeJS.ProcessEnv) => {
  const llm: LLMPort = makeFakeLlm({ model: "boot-model", provider: "openai" })
  const setup = makeFakeSessionSetup({ llm, model: "boot-model" })
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  const wires = composeSurfaceWires(setup, state, env, {
    convStore: defaultConversationCheckpointStore(),
  })
  /** Drive the REAL dispatcher and capture BOTH streams — a clear that "worked"
   *  while printing an error on stderr is not a working clear. */
  const dispatch = async (line: string): Promise<{ out: string; err: string }> => {
    let out = ""
    let err = ""
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((s: string) => {
      out += String(s)
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((s: string) => {
      err += String(s)
      return true
    }) as typeof process.stderr.write
    try {
      await wires.dispatchSlash(line)
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }
    return { out, err }
  }
  /** `dispatchSlash` returns "was a slash command", not the exit code, so the
   *  EXIT-CODE cases invoke the REGISTERED command over the REAL slash ctx this
   *  composition built (same adapter, same store — only the io is captured). */
  const runCmd = async (
    name: string,
    args: readonly string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    const cmd = SURFACE_SLASH_COMMANDS.find((c) => c.name === name)
    if (cmd === undefined) throw new Error(`${name} not registered`)
    const out: string[] = []
    const errs: string[] = []
    const ctx = {
      ...wires.slashCtx,
      // The `model` slot is installed onto the ctx by the LIVE dispatcher (the
      // composer exposes the very same adapter instance as `wires.modelAdapter`),
      // so a ctx built straight off `slashCtx` would report "not wired". Same
      // adapter, same store — only the io is captured.
      ...(wires.modelAdapter !== undefined ? { model: wires.modelAdapter } : {}),
      out: (s: string) => out.push(s),
      err: (s: string) => errs.push(s),
      // `as unknown as` because the COMPOSED ctx is structurally wider than the
      // published contract in one unrelated slot (`side`); the slots this file
      // exercises (`model`, `stickyModel`) are the real wires either way.
    } as unknown as SlashContext
    const code = await cmd.run([...args], ctx)
    return { code, out: out.join(""), err: errs.join("") }
  }
  return { setup, wires, dispatch, runCmd }
}

/** The loop's own view: the store SLOT (session-scoped cell) + the candidate
 *  ports, exactly as `runAgent` receives them. */
const loopConfig = (wires: ReturnType<typeof compose>["wires"], baseLlm: LLMPort): AgentConfig =>
  ({
    llm: baseLlm,
    stickyModelStore: wires.runtimeFacadeCompose.stickyModelStore,
    modelCandidates: wires.runtimeFacadeCompose.modelCandidates,
  }) as unknown as AgentConfig

describe("`/model --clear` — un-setting a sticky pick (aug-28, F7)", () => {
  test("(a) `/model <id>` then `/model --clear` ⇒ key GONE on disk, loop reads no preference, BOOT port runs", async () => {
    const { env } = hermeticHome()
    // Seeded so a PORT for `gpt-4o` exists in this session (the catalog probe is
    // lazy and the fake port publishes no catalog) — the pick has to be genuinely
    // runnable, or the clear would be undoing something inert.
    writePicks(env, { "openai:default": "gpt-4o" })
    const s = compose(env)
    const base = makeFakeLlm({ model: "boot-model", provider: "openai" })
    const cfg = loopConfig(s.wires, base)

    // ── the pick is LIVE: on disk, in the loop's read, and in the turn's port ──
    await s.dispatch("/model gpt-4o")
    expect(readFileJson(env)).toEqual({ "openai:default": "gpt-4o" })
    expect(await readStickyModelForMode(cfg)).toBe("gpt-4o")
    expect(resolveSkillTurnOverride(cfg, undefined, "gpt-4o").llm.model).toBe("gpt-4o")

    // ── the clear ──
    const cleared = await s.dispatch("/model --clear")
    expect(cleared.err).toBe("")

    // A: the FILE no longer holds the key — and is still a VALID `{}` store, not
    // an unlinked path (a concurrent writer's file must not be taken out, and an
    // operator inspecting the path should see an empty store).
    expect(readFileJson(env)).toEqual({})
    expect(existsSync(stickyModelFilePath(env))).toBe(true)

    // B: the loop's OWN read (through the session cell the decorator owns).
    const sticky = await readStickyModelForMode(cfg)
    expect(sticky).toBeUndefined()

    // …and the turn therefore resolves to the BOOT port, by identity — not a
    // look-alike port that happens to share the id.
    const resolved = resolveSkillTurnOverride(cfg, undefined, sticky)
    expect(resolved.llm).toBe(base)
    expect(resolved.llm.model).toBe("boot-model")
  })

  test("(b) the SYNC `current()` reports the boot model the instant the clear returns (no stale display)", async () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const s = compose(env)
    // Pre-state: the display names the pick (so the assertion below is a change,
    // not a coincidence).
    expect(s.wires.modelAdapter?.current()).toBe("gpt-4o")
    expect(s.wires.runtimeFacadeCompose.stickyModelStore?.effectiveModel?.()).toBe("gpt-4o")

    const cleared = await s.dispatch("/model --clear")
    // The command's OWN report line — what the operator reads.
    expect(cleared.out).toContain("boot-model")
    expect(cleared.out).not.toContain("gpt-4o")
    // The sync accessor four displays share (picker header, status line, banner,
    // `describe().modelSlug`). A second cached copy of the pick anywhere reds here.
    expect(s.wires.modelAdapter?.current()).toBe("boot-model")
    // The AgentConfig SLOT getter every OTHER surface reads through
    // (`effectiveModelOf` → `describe().modelSlug` → attach pill, SDK
    // `session.model`, web `/state`). It must go back to `undefined` — "no
    // preference" — and let `effectiveModelOf` supply the boot fallback; a getter
    // that eagerly answered the boot model would be claiming a preference nobody
    // set.
    const slot = s.wires.runtimeFacadeCompose.stickyModelStore
    expect(slot?.effectiveModel?.()).toBeUndefined()
    expect(
      effectiveModelOf({
        llm: { model: "boot-model" },
        ...(slot !== undefined ? { stickyModelStore: slot } : {}),
      }),
    ).toBe("boot-model")
    // …and the picker's own listing agrees on the very next paint.
    const listed = await s.dispatch("/model")
    expect(listed.out).toContain(" * boot-model")
    expect(listed.out).not.toContain(" * gpt-4o")
    // Discoverability: the footer names the verb that got us here.
    expect(listed.out).toContain("--clear")
  })

  test("(c) clearing with nothing set is an IDEMPOTENT SUCCESS — exit 0, no error, no file conjured", async () => {
    const { env } = hermeticHome()
    const s = compose(env)
    expect(existsSync(stickyModelFilePath(env))).toBe(false)

    const first = await s.runCmd("/model", ["--clear"])
    expect(first.code).toBe(0)
    expect(first.err).toBe("")
    expect(first.out).toContain("boot-model")
    // A no-op removal must not CREATE the store file on a machine that has never
    // had a preference — a clear on a first run leaves the disk as it found it.
    expect(existsSync(stickyModelFilePath(env))).toBe(false)

    // Twice more: still success, still silent, still no file.
    expect((await s.runCmd("/model", ["--clear"])).code).toBe(0)
    const third = await s.runCmd("/model", ["--clear"])
    expect(third.code).toBe(0)
    expect(third.err).toBe("")
    expect(existsSync(stickyModelFilePath(env))).toBe(false)
  })

  test("(d) SURGICAL — a clear touches ONLY this provider+mode; sibling mode and sibling provider survive", async () => {
    const { env } = hermeticHome()
    // Written directly, as a previous session (and another surface) would have.
    writePicks(env, {
      "openai:default": "gpt-4o",
      "openai:plan": "plan-pick",
      "anthropic:default": "claude-sonnet-4-6",
      // The legacy bare-mode key `/sticky-model` writes — also a different key.
      review: "review-pick",
    })
    const s = compose(env) // provider `openai`, mode `default`
    const cleared = await s.dispatch("/model --clear")
    expect(cleared.err).toBe("")
    expect(readFileJson(env)).toEqual({
      "openai:plan": "plan-pick",
      "anthropic:default": "claude-sonnet-4-6",
      review: "review-pick",
    })
  })

  test("(e) PAIRED CONTROL — `/model <id>` still PERSISTS (this file cannot pass by breaking `set`)", async () => {
    const { env } = hermeticHome()
    writePicks(env, { "openai:default": "gpt-4o" })
    const s = compose(env)
    // A DIFFERENT value than the seed, so the assertion proves a write happened
    // rather than re-reading what the fixture put there.
    await s.dispatch("/model boot-model")
    expect(readFileJson(env)).toEqual({ "openai:default": "boot-model" })
    const cfg = loopConfig(s.wires, makeFakeLlm({ model: "other", provider: "openai" }))
    expect(await readStickyModelForMode(cfg)).toBe("boot-model")
    expect(s.wires.modelAdapter?.current()).toBe("boot-model")
  })

  test("(f) a FAILED durable removal leaves the session cell ALONE (the mirror of `set`'s rule)", async () => {
    // The decorator writes THROUGH: only a removal disk accepted may change what
    // this session runs. Clearing the cell on a rejected write would drop this
    // session to the boot model while the file still holds the pick — so the next
    // session would resurrect it, which is the "did my clear work?" ambiguity the
    // decorator exists to remove. The inner store is a double HERE because the
    // point is the failure branch, which a real fs cannot be asked for reliably.
    const refusing: StickyModelStore = {
      get: async () => undefined,
      peek: () => undefined,
      load: async () => ({ ok: true as const, snapshot: {} }),
      set: async () => ({ ok: true as const }),
      unset: async () => ({
        ok: false as const,
        error: new StickyModelWriteError("/tmp/sticky.json", "read-only fs"),
      }),
    }
    const store = sessionScopedStickyModelStore({
      inner: refusing,
      seed: { "openai:default": "gpt-4o" },
    })
    const res = await store.unset({ mode: "default", provider: "openai" })
    expect(res.ok).toBe(false)
    // The pick is STILL this session's truth, in both the async and sync reads.
    expect(await store.get({ mode: "default", provider: "openai" })).toBe("gpt-4o")
    expect(store.peek({ mode: "default", provider: "openai" })).toBe("gpt-4o")

    // PAIRED CONTROL — an ACCEPTED removal does clear the cell.
    const accepting = sessionScopedStickyModelStore({
      inner: { ...refusing, unset: async () => ({ ok: true as const }) },
      seed: { "openai:default": "gpt-4o" },
    })
    expect((await accepting.unset({ mode: "default", provider: "openai" })).ok).toBe(true)
    expect(accepting.peek({ mode: "default", provider: "openai" })).toBeUndefined()
  })

  test("(g) a CORRUPT store file is BACKED UP, then cleared to `{}` (never silently destroyed)", async () => {
    // The unreadable bytes could hold any pick, and the operator asked for "no
    // preference here" — so leaving them would let an unknown model reappear the
    // moment the file parses again. Same `.corrupt.bak` courtesy `set` pays.
    const { env } = hermeticHome()
    const path = stickyModelFilePath(env)
    writeFileSync(path, "{ this is not json ::::", "utf8")
    const s = compose(env)
    const cleared = await s.dispatch("/model --clear")
    expect(cleared.err).toBe("")
    expect(readFileJson(env)).toEqual({})
    expect(readFileSync(`${path}.corrupt.bak`, "utf8")).toBe("{ this is not json ::::")
  })

  test("`/sticky-model <mode> --clear` clears that mode's pick — same key its own `set` writes", async () => {
    const { env } = hermeticHome()
    const s = compose(env)
    // The clear must use the SAME key shape its own `set` does — a clear that
    // guessed a different shape would report success while the pick stayed on disk.
    // aug-28: that shape is now PROVIDER-KEYED for this wire too. It used to write
    // the bare mode while the loop composed `<provider>:<mode>`, so a
    // `/sticky-model` set printed success over an inert write (measured end to end);
    // both halves moved together, and this case pins that they still agree.
    expect((await s.runCmd("/sticky-model", ["plan", "boot-model"])).code).toBe(0)
    expect((await s.runCmd("/sticky-model", ["review", "boot-model"])).code).toBe(0)
    expect(readFileJson(env)).toEqual({
      "openai:plan": "boot-model",
      "openai:review": "boot-model",
    })

    const cleared = await s.runCmd("/sticky-model", ["plan", "--clear"])
    expect(cleared.code).toBe(0)
    expect(cleared.err).toBe("")
    expect(cleared.out).toContain("cleared")
    // SURGICAL: only `plan` went; `review` survives.
    expect(readFileJson(env)).toEqual({ "openai:review": "boot-model" })

    // Idempotent, and an unknown mode is still a typed error (exit 1) — the clear
    // path validates the mode exactly like the set path.
    const again = await s.runCmd("/sticky-model", ["plan", "--clear"])
    expect(again.code).toBe(0)
    expect(again.err).toBe("")
    const bogus = await s.runCmd("/sticky-model", ["turbo", "--clear"])
    expect(bogus.code).toBe(1)
    expect(bogus.err).toContain("unknown mode")
    // …and the failed clear wrote nothing.
    expect(readFileJson(env)).toEqual({ "openai:review": "boot-model" })
  })

  test("the no-arg listings ADVERTISE the clear verb (an undo nobody can find is not a front door)", async () => {
    const { env } = hermeticHome()
    const s = compose(env)
    const model = await s.runCmd("/model", [])
    expect(model.out).toContain("/model --clear")
    const sticky = await s.runCmd("/sticky-model", [])
    expect(sticky.out).toContain("--clear")
    // The command's own describe line (what `/help` renders) says it too.
    const cmd = SURFACE_SLASH_COMMANDS.find((c) => c.name === "/model")
    expect(cmd?.describe).toContain("--clear")
    // …and tab-completion offers it.
    const completeCtx = {
      ...s.wires.slashCtx,
      ...(s.wires.modelAdapter !== undefined ? { model: s.wires.modelAdapter } : {}),
    } as unknown as SlashContext
    const hints = cmd?.complete?.([], "--", completeCtx) ?? []
    expect(hints.map((h) => h.value)).toContain("--clear")
  })
})
