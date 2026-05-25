// package.json script-alias contract — the 5 `agent*` scripts wire to the
// `src/apps/agent/index.ts` entry with the right `--mode` argument, and the
// pre-existing `bench` alias is untouched (legacy direct entry preserved).
// meta-test: lints package.json text; does not import a unit.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PKG = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf8"),
) as { scripts: { [k: string]: string } }

describe("package.json agent script aliases", () => {
  test("agent: bare entry — no --mode (lets cli-args.ts pick a default)", () => {
    expect(PKG.scripts.agent).toBe("bun run src/apps/agent/index.ts")
  })

  test("agent:interactive: --mode interactive", () => {
    expect(PKG.scripts["agent:interactive"]).toBe(
      "bun run src/apps/agent/index.ts --mode interactive",
    )
  })

  test("agent:headless: --mode headless", () => {
    expect(PKG.scripts["agent:headless"]).toBe("bun run src/apps/agent/index.ts --mode headless")
  })

  test("agent:batch: --mode batch", () => {
    expect(PKG.scripts["agent:batch"]).toBe("bun run src/apps/agent/index.ts --mode batch")
  })

  test("agent:ci-bot: --mode ci-bot (points at apps/agent/index.ts)", () => {
    const v = PKG.scripts["agent:ci-bot"]
    expect(v).toBe("bun run src/apps/agent/index.ts --mode ci-bot")
    expect(v).toContain("apps/agent/index.ts")
    expect(v).toContain("--mode ci-bot")
  })

  test("all 5 new agent scripts present and non-empty", () => {
    const keys = ["agent", "agent:interactive", "agent:headless", "agent:batch", "agent:ci-bot"]
    for (const k of keys) {
      const v = PKG.scripts[k]
      expect(typeof v).toBe("string")
      expect(v?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("legacy bench alias unchanged (still bun run src/apps/bench/index.ts)", () => {
    expect(PKG.scripts.bench).toBe("bun run src/apps/bench/index.ts")
  })

  test("legacy start/dev aliases unchanged", () => {
    expect(PKG.scripts.dev).toBe("bun --hot run src/apps/cli/index.ts")
    expect(PKG.scripts.start).toBe("bun run src/apps/cli/index.ts")
  })
})
