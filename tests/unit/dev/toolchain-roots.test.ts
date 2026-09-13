/**
 * The toolchain roots a replaced HOME would hide are LENT, and lending is safe.
 *
 * Every Rust arm of `test:real-toolchain` failed after the test preload moved HOME
 * to scratch: rustup found no toolchain. Pinning `RUSTUP_HOME`/`CARGO_HOME` was
 * tried and measured insufficient — the tool under test spawns cargo through the
 * product's env scrub, which keeps HOME and drops both. These arms hold the three
 * properties the fix rests on.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import ts from "typescript"
import { scrubEnvFrom } from "@/shared/env-scrub"
import {
  lendToolchainRoots,
  TOOLCHAIN_HOME_LEAVES,
  toolchainLinks,
} from "../../../tools/dev/toolchain-roots"
import { runWithCapabilityReceipt } from "../../../tools/dev/with-capability-receipt"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "toolchain-roots-"))
  const real = join(base, "real-home")
  const scratch = join(base, "scratch-home")
  for (const leaf of TOOLCHAIN_HOME_LEAVES) {
    mkdirSync(join(real, leaf, "bin"), { recursive: true })
    writeFileSync(join(real, leaf, "marker"), leaf)
  }
  return { base, real, scratch }
}

describe("lending toolchain roots into a scratch HOME", () => {
  test("a SCRUBBED child reaches the toolchain through HOME alone", () => {
    const { base, real, scratch } = fixture()
    try {
      const created = lendToolchainRoots(
        toolchainLinks({ home: scratch, realHome: real, exists: existsSync }),
      )
      expect(created).toEqual(TOOLCHAIN_HOME_LEAVES.map((leaf) => join(scratch, leaf)))
      // The product's own scrub: HOME and PATH survive, RUSTUP_HOME would not.
      const env = scrubEnvFrom({ HOME: scratch, PATH: process.env.PATH, RUSTUP_HOME: "/nope" })
      expect(env).not.toHaveProperty("RUSTUP_HOME")
      const seen = Bun.spawnSync(["sh", "-c", 'cat "$HOME/.rustup/marker" "$HOME/.cargo/marker"'], {
        env,
      })
      expect(seen.stdout.toString()).toBe(".rustup.cargo")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("removing the scratch HOME removes the links, never the toolchain behind them", () => {
    const { base, real, scratch } = fixture()
    try {
      lendToolchainRoots(toolchainLinks({ home: scratch, realHome: real, exists: existsSync }))
      rmSync(scratch, { recursive: true, force: true })
      for (const leaf of TOOLCHAIN_HOME_LEAVES) {
        expect({ leaf, kept: readFileSync(join(real, leaf, "marker"), "utf8") }).toEqual({
          leaf,
          kept: leaf,
        })
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("PAIRED CONTROLS — an absent root, the same HOME, and an occupied path are left alone", () => {
    const { base, real, scratch } = fixture()
    try {
      rmSync(join(real, ".rustup"), { recursive: true, force: true })
      expect(
        toolchainLinks({ home: scratch, realHome: real, exists: existsSync }).map((l) => l.link),
      ).toEqual([join(scratch, ".cargo")])
      expect(toolchainLinks({ home: real, realHome: real, exists: existsSync })).toEqual([])
      mkdirSync(join(scratch, ".cargo"), { recursive: true })
      writeFileSync(join(scratch, ".cargo", "own"), "a test's own")
      expect(
        lendToolchainRoots(toolchainLinks({ home: scratch, realHome: real, exists: existsSync })),
      ).toEqual([])
      expect(readFileSync(join(scratch, ".cargo", "own"), "utf8")).toBe("a test's own")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("every HOME the rail replaces is lent to", () => {
  test("WIRING — the runner lends into each worker HOME and into the probe HOME", () => {
    const source = readFileSync(join(REPO_ROOT, "tools", "dev", "run-test-shards.ts"), "utf8")
    const tree = ts.createSourceFile(
      "run-test-shards.ts",
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const lent: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "lendToolchainsInto"
      ) {
        lent.push(node.arguments[0]?.getText(tree) ?? "")
      }
      node.forEachChild(walk)
    }
    walk(tree)
    expect(lent.sort()).toEqual(["probeHome", "workerHome"])
  })

  test("BEHAVIOUR — the lane wrapper's child and its probes see the same lent roots", async () => {
    const { base, real } = fixture()
    const probeHomes: string[] = []
    let out = ""
    try {
      const code = await runWithCapabilityReceipt({
        lane: "arm-toolchain-roots",
        cacheRoot: join(base, "cache"),
        cmd: [
          process.execPath,
          "-e",
          'console.log("LENT=" + require("node:fs").readFileSync(process.env.HOME + "/.cargo/marker", "utf8"))',
        ],
        env: { PATH: process.env.PATH ?? "", HOME: real },
        hostHome: real,
        spawn: (argv, env) => {
          probeHomes.push(env.HOME ?? "")
          return {
            exited: Promise.resolve(0),
            stdout: Promise.resolve(`${argv[0] ?? "x"}\n`),
            kill: () => {},
          }
        },
        onStdout: (text) => {
          out += text
        },
      })
      expect(code).toBe(0)
      expect(out).toContain("LENT=.cargo")
      // The probes ran under the lane HOME, which held the same link.
      expect(probeHomes.length).toBeGreaterThan(0)
      expect(probeHomes.every((home) => home !== real)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})
