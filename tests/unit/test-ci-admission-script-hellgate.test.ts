// meta-test: package-script contract; it intentionally reads package.json rather than importing src/.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

type PackageJson = { readonly scripts?: Record<string, string> }

/** Anchored on THIS file. `Bun.file("package.json")` resolved against the ambient
 *  cwd, so from anywhere but the repo root the read failed and the whole file
 *  died at module scope — found by the paired control: 4 pass at the root,
 *  0 pass / 1 fail from a foreign working directory. */
const packageJson = (await Bun.file(
  join(import.meta.dir, "..", "..", "package.json"),
).json()) as PackageJson
const shardRunner = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "run-test-shards.ts"),
).text()

describe("test:ci admission gate", () => {
  test("uses the live feature-catalog changed-file authority", () => {
    const script = packageJson.scripts?.["test:admission"]
    expect(script).toBe("bun fc check-changed")
    expect(script).not.toContain("tools/test-admission")
  })

  test("does not retain a sibling script pointing at the removed admission CLI", () => {
    const stale = Object.entries(packageJson.scripts ?? {}).filter(([, script]) =>
      script.includes("tools/test-admission"),
    )
    expect(stale).toEqual([])
  })

  test("gives spawned catalog and subprocess rails a realistic timeout", () => {
    const expectations = {
      "test:ci": "--timeout=15000",
      "test:shard": "--timeout=60000",
    } as const
    for (const [name, timeout] of Object.entries(expectations)) {
      const script = packageJson.scripts?.[name]
      expect(script, name).toContain(timeout)
      expect(script, name).toContain("--parallel=1")
    }
  })

  test("serializes every shared-process test entrypoint", () => {
    const serialScripts = [
      "test",
      "test:unit",
      "test:fast",
      "test:integration",
      "test:shard",
      "test:contract",
      "test:ci",
      "test:cov",
      "test:watch",
    ]
    for (const name of serialScripts) {
      expect(packageJson.scripts?.[name], name).toContain("--parallel=1")
    }
  })

  test("the authoritative full-suite runner bounds a wedged shard worker", () => {
    expect(packageJson.scripts?.test).toContain("tools/dev/run-test-shards.ts")
    expect(shardRunner).toContain("const SHARD_COUNT = 8")
    expect(shardRunner).toContain("const SHARD_TIMEOUT_MS = 5 * 60_000")
    expect(shardRunner).toContain("proc.kill(9)")
    expect(shardRunner).toContain("checkout changed during run")
  })
})
