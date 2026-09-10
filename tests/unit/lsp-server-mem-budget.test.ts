/**
 * LSP server MEMORY BUDGET cap (jun-26 OOM finding) — a Node-based language
 * server (pyright-langserver / typescript-language-server) inherits the parent
 * env when spawned and runs with no V8 old-space heap cap. On big repos
 * (django/matplotlib/sklearn) pyright's Node heap balloons; with concurrency=2
 * and warm-pool-retained servers the combined RSS OOM-killed a 64GB bench box
 * (exit 137 from the kernel; earlier conf=4 saw pyright exit 247 = Node OOM).
 *
 * The fix appends `--max-old-space-size=<MB>` to the spawned server's
 * NODE_OPTIONS so V8 caps its own heap (Node servers honor it; non-Node
 * servers — clangd/gopls/rust-analyzer — ignore NODE_OPTIONS, harmless).
 *
 * `buildLspServerEnv` is the pure builder; `resolveLspMemBudgetMb` reads the
 * `QUANTA_LSP_MEM_BUDGET_MB` knob (default-ON 4096, `0`/unset-to-`0` opts out).
 *
 * The wiring proof spawns a REAL child that echoes its inherited NODE_OPTIONS to
 * stderr — base.ts retains a bounded stderr tail, so we can read back the exact
 * env the spawn received without a mock seam.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { LspClient, type LspClientSpec } from "@/lsp/adapters/base"
import { buildLspServerEnv, resolveLspMemBudgetMb } from "@/lsp/server-mem-budget"
import { logger } from "@/shared/logger"

const lang: LspClientSpec["languageIdFor"] = () => "plaintext"

describe("buildLspServerEnv — pure NODE_OPTIONS heap cap builder", () => {
  test("budget 4096 + empty NODE_OPTIONS ⇒ NODE_OPTIONS carries --max-old-space-size=4096", () => {
    const out = buildLspServerEnv({ PATH: "/usr/bin" }, 4096)
    expect(out.NODE_OPTIONS).toContain("--max-old-space-size=4096")
    // Other parent entries are preserved verbatim.
    expect(out.PATH).toBe("/usr/bin")
  })

  test("budget undefined ⇒ env IDENTICAL to parent (no NODE_OPTIONS added)", () => {
    const parent = { PATH: "/usr/bin", FOO: "bar" }
    const out = buildLspServerEnv(parent, undefined)
    expect(out).toEqual(parent)
    expect("NODE_OPTIONS" in out).toBe(false)
  })

  test("budget 0 ⇒ env IDENTICAL to parent (explicit opt-out, byte-identical)", () => {
    const parent = { PATH: "/usr/bin" }
    const out = buildLspServerEnv(parent, 0)
    expect(out).toEqual(parent)
    expect("NODE_OPTIONS" in out).toBe(false)
  })

  test("budget negative ⇒ treated as opt-out (no NODE_OPTIONS added)", () => {
    const parent = { PATH: "/usr/bin" }
    const out = buildLspServerEnv(parent, -1)
    expect(out).toEqual(parent)
  })

  test("existing unrelated NODE_OPTIONS is PRESERVED and the cap APPENDED", () => {
    const out = buildLspServerEnv({ NODE_OPTIONS: "--enable-source-maps" }, 2048)
    expect(out.NODE_OPTIONS).toContain("--enable-source-maps")
    expect(out.NODE_OPTIONS).toContain("--max-old-space-size=2048")
    // Appended after the existing flags (single space-separated string).
    expect(out.NODE_OPTIONS).toBe("--enable-source-maps --max-old-space-size=2048")
  })

  test("CLOBBER DECISION: an existing --max-old-space-size is left UNTOUCHED (operator wins)", () => {
    // If the operator already pinned a heap size in NODE_OPTIONS, respect it —
    // we do NOT append a second (conflicting/duplicate) flag.
    const out = buildLspServerEnv({ NODE_OPTIONS: "--max-old-space-size=512" }, 4096)
    expect(out.NODE_OPTIONS).toBe("--max-old-space-size=512")
    // No duplicate flag appended.
    expect((out.NODE_OPTIONS ?? "").match(/--max-old-space-size/g)?.length).toBe(1)
  })

  test("does not mutate the parent env object (returns a copy when capping)", () => {
    const parent = { PATH: "/usr/bin" }
    buildLspServerEnv(parent, 4096)
    expect("NODE_OPTIONS" in parent).toBe(false)
  })
})

describe("resolveLspMemBudgetMb — QUANTA_LSP_MEM_BUDGET_MB knob", () => {
  test("DEFAULT-ON: unset ⇒ 4096", () => {
    expect(resolveLspMemBudgetMb({})).toBe(4096)
  })

  test("explicit positive int parsed", () => {
    expect(resolveLspMemBudgetMb({ QUANTA_LSP_MEM_BUDGET_MB: "8192" })).toBe(8192)
  })

  test("explicit 0 ⇒ 0 (opt-out, no cap)", () => {
    expect(resolveLspMemBudgetMb({ QUANTA_LSP_MEM_BUDGET_MB: "0" })).toBe(0)
  })

  test("garbage / non-numeric ⇒ falls back to the safe default (never NaN/uncapped)", () => {
    expect(resolveLspMemBudgetMb({ QUANTA_LSP_MEM_BUDGET_MB: "not-a-number" })).toBe(4096)
  })

  test("empty string ⇒ default", () => {
    expect(resolveLspMemBudgetMb({ QUANTA_LSP_MEM_BUDGET_MB: "" })).toBe(4096)
  })

  test("negative ⇒ default (cannot accidentally pass a bogus heap arg)", () => {
    expect(resolveLspMemBudgetMb({ QUANTA_LSP_MEM_BUDGET_MB: "-100" })).toBe(4096)
  })
})

describe("LspClient.start — WIRING PROOF: spawn inherits the budgeted NODE_OPTIONS", () => {
  let client: LspClient | null = null
  const prev = process.env.QUANTA_LSP_MEM_BUDGET_MB
  afterEach(async () => {
    await client?.stop().catch(() => undefined)
    client = null
    if (prev === undefined) delete process.env.QUANTA_LSP_MEM_BUDGET_MB
    else process.env.QUANTA_LSP_MEM_BUDGET_MB = prev
  })

  /** A real child that echoes its INHERITED NODE_OPTIONS to stderr then exits
   *  cleanly. base.ts retains a bounded stderr tail and logs it on exit
   *  (debug for a clean exit 0), so the captured tail proves the exact env the
   *  spawn received — a real-effect wiring proof, no mock seam. */
  const NODE_OPTIONS_ECHO = [
    "/bin/sh",
    "-c",
    'printf "NODE_OPTIONS_SEEN=[%s]\\n" "$NODE_OPTIONS" 1>&2; exit 0',
  ]
  const waitForExitLog = async (seen: () => boolean, timeoutMs = 1_000): Promise<boolean> => {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (seen()) return true
      await Bun.sleep(5)
    }
    return seen()
  }

  test("default-on: the spawned server sees --max-old-space-size=4096 in its NODE_OPTIONS", async () => {
    delete process.env.QUANTA_LSP_MEM_BUDGET_MB // exercise the default
    const debug = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      client = new LspClient(
        { defaultCommand: NODE_OPTIONS_ECHO, languageIdFor: lang },
        { requestTimeoutMs: 400 },
      )
      await client.start().catch(() => undefined)
      expect(
        await waitForExitLog(() =>
          debug.mock.calls.some((c) => String(c[0]).includes("server exited")),
        ),
      ).toBe(true)
      const call = debug.mock.calls.find((c) => String(c[0]).includes("server exited"))
      expect(call).toBeDefined()
      const detail = call?.[1] as { stderrTail: string }
      expect(detail.stderrTail).toContain("--max-old-space-size=4096")
    } finally {
      debug.mockRestore()
    }
  })

  test("opt-out (QUANTA_LSP_MEM_BUDGET_MB=0): the spawned server sees NO heap cap injected", async () => {
    process.env.QUANTA_LSP_MEM_BUDGET_MB = "0"
    const debug = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      client = new LspClient(
        { defaultCommand: NODE_OPTIONS_ECHO, languageIdFor: lang },
        { requestTimeoutMs: 400 },
      )
      await client.start().catch(() => undefined)
      expect(
        await waitForExitLog(() =>
          debug.mock.calls.some((c) => String(c[0]).includes("server exited")),
        ),
      ).toBe(true)
      const call = debug.mock.calls.find((c) => String(c[0]).includes("server exited"))
      expect(call).toBeDefined()
      const detail = call?.[1] as { stderrTail: string }
      expect(detail.stderrTail).not.toContain("--max-old-space-size")
    } finally {
      debug.mockRestore()
    }
  })
})
