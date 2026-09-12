/**
 * ADR-0555 HELLGATE — memory store TRUTH + dotenv-sourced embedder EGRESS opt-in.
 *
 * Two lies this battery pins shut:
 *
 *  M4 (truth) — the CLI seeds `QUANTA_MEMORY=1`, which (pre-ADR-0557) resolved
 *  to the VOLATILE `InMemoryStore`. Nothing told the operator: the banner
 *  printed `kind=1` (the raw env token) and was OMITTED entirely in the
 *  default/unset case; `/memory stats` never said the store evaporates at exit.
 *    T1 — `buildMemoryForSession(...)` reports the RESOLVED `kind`.
 *    T2 — the REAL `buildTooling` banner prints the RESOLVED kind for BOTH the
 *         unset default AND the seeded `"1"` (never the raw token). ADR-0557
 *         made that resolved default `sqlite` (home-scoped); `HOME` is pointed
 *         at a temp dir per case so the real `~/.quanta/` is never touched.
 *    T3 — `/memory stats` prints a `Store:` line that says `volatile`.
 *
 *  M5 (egress) — `loadEnvFiles` pulls `OPENAI_API_KEY` from a repo's `.env*` into
 *  `process.env`; the embedder (knob default-ON) then silently arms and POSTs
 *  memory text to `${OPENAI_BASE_URL ?? api.openai.com}/embeddings`.
 *    E1 — provenance: which KEYS came from which FILE (never values).
 *    E2 — a dotenv-sourced key arms the embedder ONLY with an explicit
 *         `QUANTA_MEMORY_EMBED=1`; a real-env key is byte-identical to today.
 *    E3 — PAIRED CONTROL: no `.env`, no key ⇒ embedder undefined, `embed=off`.
 *
 * Every `process.env` mutation is snapshot/restored; `process.chdir` is
 * try/finally-restored; provenance is reset per case.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { InMemoryStore, SqliteStore } from "@/memory"
import { StructuredLogger } from "@/observability"
import { buildMemoryForSession } from "@/runner/assemble"
import { __resetRuntimeConfig, __resetTerminalIo, setTerminalIo } from "@/shared"
import {
  __resetEnvFileProvenanceForTest,
  envFileProvenance,
  envFileSourceOf,
  loadEnvFiles,
} from "@/shared/env-files"
import { buildEmbedder, buildTooling } from "../../../../src/apps/cli/internal"
import type { MemorySlashState } from "../../../../src/apps/cli/memory-cmd"
import { runSlashCommand, type SlashContext } from "../../../../src/apps/cli/slash-commands"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const FAKE_KEY = "sk-test-not-real"
const DRIVEN = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "QUANTA_MEMORY",
  "QUANTA_MEMORY_PATH",
  "QUANTA_MEMORY_EMBED",
  "QUANTA_MEMORY_EMBED_MODEL",
  "QUANTA_SUBAGENT",
  "QUANTA_LOG_LEVEL",
  // ADR-0557 + the sep-13 relocation: the durable default resolves under the
  // QUANTA home, not `$HOME`. `HOME` is still driven for the dotenv-provenance
  // cases, and `QUANTA_HOME` is what actually moves the store — see beforeEach.
  "HOME",
  "QUANTA_HOME",
  "QUANTA_CONFIG_DIR",
] as const
const saved: Record<string, string | undefined> = {}
let tmp: string
let stderr = ""

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Keep the real `buildTooling` assembly light (no subagent block); the banner
  // rides `logger.info`, so pin the threshold so a stricter ambient level cannot
  // hide the line under test.
  process.env.QUANTA_SUBAGENT = "0"
  process.env.QUANTA_LOG_LEVEL = "info"
  __resetRuntimeConfig()
  __resetEnvFileProvenanceForTest()
  stderr = ""
  setTerminalIo({
    stdout: () => undefined,
    stderr: (chunk) => {
      stderr += chunk
    },
  })
  // realpath: macOS `/tmp` is a symlink and `process.cwd()` reports the resolved
  // path, so provenance (resolved against cwd) must be compared realpath-to-realpath.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "memory-truth-egress-")))
  // Redirect the durable default's home to the temp dir.
  //
  // SETTING `HOME` IS NOT ENOUGH, and this file measured it: the store path now
  // resolves through `quantaHomeDirFrom(env)` —
  // `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? join(homedir(), ".quanta")` — the same
  // resolver sessions and knobs use, so memory stopped being the one plane a
  // relocated home did not move. `homedir()` does NOT honour a mutated
  // `process.env.HOME` here, so with only `HOME` set this suite resolved to
  // `/Users/<me>/.quanta/memory/memory.sqlite` and `buildTooling` OPENED THE
  // DEVELOPER'S REAL STORE. `QUANTA_HOME` is the supported relocation knob, and
  // it is pointed at `<tmp>/.quanta` so the asserted path shape is the real
  // default layout rather than a bare temp dir.
  process.env.HOME = tmp
  process.env.QUANTA_HOME = join(tmp, ".quanta")
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
  __resetEnvFileProvenanceForTest()
  __resetTerminalIo()
  rmSync(tmp, { recursive: true, force: true })
})

/** Run `loadEnvFiles(files)` with `process.cwd()` temporarily moved to `dir`
 *  (the loader resolves against the LAUNCH cwd — that is the hazard under test).
 *  Returns the absolute path the loader resolved for `files[0]`. */
const loadFromCwd = (dir: string, files: string[]): string => {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    loadEnvFiles(files)
    return resolve(process.cwd(), files[0] as string)
  } finally {
    process.chdir(prev)
  }
}

const writeDotenv = (dir: string, name: string, body: string): void =>
  writeFileSync(join(dir, name), body)

const slog = new StructuredLogger({ sink: () => undefined })

/** The REAL CLI tooling assembly (`bootstrap-session` calls this exact shim
 *  with empty opt-in arrays); the banner lands on stderr via `logger.info`. */
const realTooling = () => buildTooling([], [], [], [], [], slog)

const bannerLine = (): string | undefined =>
  stderr.split("\n").find((l) => l.includes("memory on ("))

const captureCtx = (memory?: MemorySlashState): { ctx: SlashContext; out: () => string } => {
  let out = ""
  const ctx: SlashContext = {
    out: (s) => {
      out += s
    },
    err: () => undefined,
    cwd: tmp,
    ...(memory !== undefined ? { memory } : {}),
  }
  return { ctx, out: () => out }
}

/* ------------------------------------------------------------------ */
/* T1 — factory reports the RESOLVED kind                              */
/* ------------------------------------------------------------------ */

describe("T1 — buildMemoryForSession reports the resolved store kind", () => {
  // ADR-0557: the seed / unset default resolved to "memory" (volatile) before;
  // it is now the durable home-scoped "sqlite". The truth contract (resolved
  // kind, never the raw token) is unchanged — only the resolved value moved.
  // (A synthetic env carries no `HOME`, so the temp home is injected via the
  // factory's `override.homeDir` seam — the real `~/.quanta/` is never opened.)
  test("QUANTA_MEMORY=1 (the CLI seed) ⇒ kind === 'sqlite' (ADR-0557 durable default)", () => {
    const slot = buildMemoryForSession({ QUANTA_MEMORY: "1" } as NodeJS.ProcessEnv, {
      homeDir: tmp,
      cwd: tmp,
    })
    expect(slot.kind).toBe("sqlite")
  })

  test("unset (default-ON) ⇒ kind === 'sqlite' at <quanta-home>/memory/memory.sqlite", () => {
    // `override.homeDir` is the QUANTA home, not the OS home — that is the point of
    // the relocation (memory follows QUANTA_HOME / QUANTA_CONFIG_DIR like sessions
    // and knobs). So the injected root is `<tmp>/.quanta` and the file lands one
    // level under it. This previously injected a bare `tmp` and asserted
    // `<tmp>/.quanta/memory/...`, which only held while the seam meant the OS home.
    const home = join(tmp, ".quanta")
    const slot = buildMemoryForSession({} as NodeJS.ProcessEnv, { homeDir: home, cwd: tmp })
    expect(slot.kind).toBe("sqlite")
    expect(slot.storePath).toBe(join(home, "memory", "memory.sqlite"))
  })

  test("the resolved store NEVER escapes the scratch home", () => {
    // The arm that would have caught the regression this file just recorded. With
    // only `HOME` redirected, `buildTooling` resolved the developer's REAL
    // `~/.quanta/memory/memory.sqlite` and every assertion about `kind` still
    // passed — a suite writing to the real store while reporting green.
    for (const env of [{}, { QUANTA_MEMORY: "1" }, { QUANTA_MEMORY: "sqlite" }]) {
      const slot = buildMemoryForSession(env as NodeJS.ProcessEnv, {
        homeDir: join(tmp, ".quanta"),
        cwd: tmp,
      })
      expect(
        slot.storePath ?? tmp,
        `escaped the scratch home for ${JSON.stringify(env)}`,
      ).toContain(tmp)
    }
    const t = realTooling()
    expect(t.memoryStorePath ?? tmp, "buildTooling escaped the scratch home").toContain(tmp)
  })

  test("QUANTA_MEMORY=sqlite + path ⇒ kind === 'sqlite' AND the resolved path is carried", () => {
    const path = join(tmp, "m.sqlite")
    const slot = buildMemoryForSession({
      QUANTA_MEMORY: "sqlite",
      QUANTA_MEMORY_PATH: path,
    } as NodeJS.ProcessEnv)
    expect(slot.kind).toBe("sqlite")
    expect(slot.storePath).toBe(path)
    expect(slot.store).toBeInstanceOf(SqliteStore)
  })

  test("QUANTA_MEMORY=off ⇒ no kind (the whole bundle is {})", () => {
    const slot = buildMemoryForSession({ QUANTA_MEMORY: "off" } as NodeJS.ProcessEnv)
    expect(slot.kind).toBeUndefined()
    expect(slot.store).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* T2 — the REAL banner prints the resolved kind, incl. the default    */
/* ------------------------------------------------------------------ */

describe("T2 — buildTooling banner tells the truth about the store kind", () => {
  // ADR-0557: these two cases said `kind=memory (volatile)`; the default is now
  // the durable sqlite store, so the SAME banner path must print `kind=sqlite`
  // and thread the home-scoped path. The volatile label is pinned by the
  // explicit `QUANTA_MEMORY=memory` case below.
  test("QUANTA_MEMORY unset (default-ON) ⇒ banner IS printed and says kind=sqlite (ADR-0557 durable default)", () => {
    const t = realTooling()
    expect(t.store).toBeInstanceOf(SqliteStore)
    const line = bannerLine()
    expect(line).toBeDefined()
    expect(line).toContain("kind=sqlite")
    expect(line).not.toContain("volatile")
    expect(line).toContain("embed=off")
    expect(t.memoryKind).toBe("sqlite")
    // `<tmp>/.quanta` is QUANTA_HOME (set in beforeEach), so the file is one level
    // under it. Asserted as an absolute path, not a suffix, so an escape to the
    // real `~/.quanta` cannot satisfy it.
    expect(t.memoryStorePath).toBe(join(tmp, ".quanta", "memory", "memory.sqlite"))
  })

  test("QUANTA_MEMORY=1 (the CLI seed) ⇒ kind=sqlite, NEVER the raw token kind=1", () => {
    process.env.QUANTA_MEMORY = "1"
    realTooling()
    const line = bannerLine()
    expect(line).toBeDefined()
    expect(line).toContain("kind=sqlite")
    expect(line).not.toContain("kind=1")
  })

  test("QUANTA_MEMORY=memory (explicit volatile) ⇒ kind=memory (volatile) still printed", () => {
    process.env.QUANTA_MEMORY = "memory"
    const t = realTooling()
    expect(t.store).toBeInstanceOf(InMemoryStore)
    expect(bannerLine()).toContain("kind=memory (volatile)")
  })

  test("QUANTA_MEMORY=sqlite ⇒ kind=sqlite (no volatile tag) and the path is threaded", () => {
    process.env.QUANTA_MEMORY = "sqlite"
    process.env.QUANTA_MEMORY_PATH = join(tmp, "banner.sqlite")
    const t = realTooling()
    const line = bannerLine()
    expect(line).toContain("kind=sqlite")
    expect(line).not.toContain("volatile")
    expect(t.memoryKind).toBe("sqlite")
    expect(t.memoryStorePath).toBe(join(tmp, "banner.sqlite"))
  })
})

/* ------------------------------------------------------------------ */
/* T3 — /memory stats names the store kind + volatility                */
/* ------------------------------------------------------------------ */

describe("T3 — /memory stats prints a Store: line", () => {
  test("in-memory store ⇒ 'volatile' + the opt-in hint (kind threaded)", async () => {
    const { ctx, out } = captureCtx({ store: new InMemoryStore(), kind: "memory", env: {} })
    expect(await runSlashCommand("/memory stats", ctx)).toBe(0)
    expect(out()).toContain("Store:      in-memory (volatile")
    expect(out()).toContain("QUANTA_MEMORY=sqlite")
  })

  test("in-memory store ⇒ 'volatile' even when the surface did NOT thread kind (instance truth)", async () => {
    const { ctx, out } = captureCtx({ store: new InMemoryStore(), env: {} })
    expect(await runSlashCommand("/memory stats", ctx)).toBe(0)
    expect(out()).toContain("volatile")
  })

  test("sqlite store ⇒ 'Store: sqlite (<path>)' and NO volatile claim", async () => {
    const path = join(tmp, "stats.sqlite")
    const { ctx, out } = captureCtx({
      store: new SqliteStore(path),
      kind: "sqlite",
      storePath: path,
      env: {},
    })
    expect(await runSlashCommand("/memory stats", ctx)).toBe(0)
    expect(out()).toContain(`Store:      sqlite (${path})`)
    expect(out()).not.toContain("volatile")
  })
})

/* ------------------------------------------------------------------ */
/* E1 — dotenv provenance: KEYS → FILE, never values                   */
/* ------------------------------------------------------------------ */

describe("E1 — loadEnvFiles records key provenance", () => {
  test("a key supplied by .env is attributed to THAT file (absolute path); the value is never stored", () => {
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\nOTHER=x\n`)
    const file = loadFromCwd(tmp, [".env"])
    expect(process.env.OPENAI_API_KEY).toBe(FAKE_KEY)
    const prov = envFileProvenance()
    expect(prov.get("OPENAI_API_KEY")).toBe(file)
    expect(prov.get("OTHER")).toBe(file)
    expect(envFileSourceOf("OPENAI_API_KEY")).toBe(file)
    for (const v of prov.values()) expect(v).not.toContain(FAKE_KEY)
  })

  test("a key ALREADY in the real env is NOT attributed to the file (first-wins ⇒ provenance 'env')", () => {
    process.env.OPENAI_API_KEY = "sk-real-env-not-real"
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    loadFromCwd(tmp, [".env"])
    expect(process.env.OPENAI_API_KEY).toBe("sk-real-env-not-real")
    expect(envFileSourceOf("OPENAI_API_KEY")).toBeUndefined()
  })

  test("first file wins across files, and provenance names the FIRST file", () => {
    writeDotenv(tmp, ".env.dev", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=other\nOPENAI_BASE_URL=http://127.0.0.1:9\n`)
    const dev = loadFromCwd(tmp, [".env.dev", ".env"])
    expect(envFileSourceOf("OPENAI_API_KEY")).toBe(dev)
    expect(envFileSourceOf("OPENAI_BASE_URL")).toBe(resolve(tmp, ".env"))
  })
})

/* ------------------------------------------------------------------ */
/* E2 — dotenv-sourced key arms the embedder ONLY on explicit opt-in   */
/* ------------------------------------------------------------------ */

describe("E2 — embedder composition honors key provenance", () => {
  test("key from .env + QUANTA_MEMORY_EMBED unset ⇒ embedder NOT armed + one attributed warn line", () => {
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    const file = loadFromCwd(tmp, [".env"])
    const store = new InMemoryStore()
    expect(buildEmbedder(store)).toBeUndefined()
    expect(stderr).toContain("memory embedder NOT armed: OPENAI_API_KEY came from")
    expect(stderr).toContain(file)
    expect(stderr).toContain("QUANTA_MEMORY_EMBED=1")
    expect(stderr).not.toContain(FAKE_KEY)
  })

  test("key from .env + QUANTA_MEMORY_EMBED=1 (explicit) ⇒ armed, banner attributes the key file", () => {
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    const file = loadFromCwd(tmp, [".env"])
    process.env.QUANTA_MEMORY_EMBED = "1"
    expect(buildEmbedder(new InMemoryStore())).toBeDefined()
    const t = realTooling()
    expect(t.embedder).toBeDefined()
    expect(bannerLine()).toContain(`embed=on (key from ${file})`)
    expect(stderr).not.toContain("NOT armed")
  })

  test("key from .env + QUANTA_MEMORY_EMBED='' (presence only) is NOT an opt-in", () => {
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    loadFromCwd(tmp, [".env"])
    process.env.QUANTA_MEMORY_EMBED = ""
    expect(buildEmbedder(new InMemoryStore())).toBeUndefined()
  })

  test("key from the REAL env (set BEFORE loadEnvFiles) + knob unset ⇒ armed, byte-identical to today", () => {
    process.env.OPENAI_API_KEY = FAKE_KEY
    writeDotenv(tmp, ".env", "OPENAI_API_KEY=shadowed\n")
    loadFromCwd(tmp, [".env"])
    expect(envFileSourceOf("OPENAI_API_KEY")).toBeUndefined()
    expect(buildEmbedder(new InMemoryStore())).toBeDefined()
    realTooling()
    const line = bannerLine()
    expect(line).toContain("embed=on")
    expect(line).not.toContain("key from")
    expect(stderr).not.toContain("NOT armed")
  })

  test("OPENAI_BASE_URL from .env is attributed in the banner when the embedder is armed", () => {
    process.env.OPENAI_API_KEY = FAKE_KEY
    writeDotenv(tmp, ".env", "OPENAI_BASE_URL=http://127.0.0.1:9/v1\n")
    const file = loadFromCwd(tmp, [".env"])
    realTooling()
    expect(bannerLine()).toContain(`base_url from ${file}`)
  })

  test("explicit QUANTA_MEMORY_EMBED=0 with a dotenv key ⇒ off AND no 'NOT armed' noise (the kill-switch wins)", () => {
    writeDotenv(tmp, ".env", `OPENAI_API_KEY=${FAKE_KEY}\n`)
    loadFromCwd(tmp, [".env"])
    process.env.QUANTA_MEMORY_EMBED = "0"
    expect(buildEmbedder(new InMemoryStore())).toBeUndefined()
    expect(stderr).not.toContain("NOT armed")
  })
})

/* ------------------------------------------------------------------ */
/* E3 — PAIRED CONTROL: nothing configured ⇒ byte-identical off path    */
/* ------------------------------------------------------------------ */

describe("E3 — paired control: no .env, no key", () => {
  test("embedder undefined, banner embed=off, no provenance text, no warn", () => {
    expect(envFileProvenance().size).toBe(0)
    expect(buildEmbedder(new InMemoryStore())).toBeUndefined()
    const t = realTooling()
    expect(t.embedder).toBeUndefined()
    const line = bannerLine()
    expect(line).toContain("embed=off")
    expect(line).not.toContain("key from")
    expect(line).not.toContain("base_url from")
    expect(stderr).not.toContain("NOT armed")
  })
})
