/**
 * quantaHomeDirFrom(env) — the DI-env twin of `quantaHomeDir()`.
 *
 * Composition-root sites hold an INJECTED `env` (possibly a test fake) and must
 * resolve the SAME unified home root precedence as the global singleton:
 * `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`. Before this, those sites did
 * `env.QUANTA_CONFIG_DIR ?? ~/.quanta` — so a `QUANTA_HOME`-only user got a
 * SPLIT-BRAIN (config readers ignored HOME while state subsystems honored it).
 *
 * This pins the precedence + the byte-identical default, and proves the global
 * `quantaHomeDir()` honors HOME too (the alias).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig, quantaHomeDir, quantaHomeDirFrom } from "@/shared"

describe("quantaHomeDirFrom(env) — DI-env home resolver", () => {
  test("QUANTA_CONFIG_DIR wins over QUANTA_HOME (canonical root)", () => {
    expect(quantaHomeDirFrom({ QUANTA_CONFIG_DIR: "/cfg", QUANTA_HOME: "/home" })).toBe("/cfg")
  })

  test("QUANTA_HOME honored as the alias when CONFIG_DIR is unset", () => {
    expect(quantaHomeDirFrom({ QUANTA_HOME: "/home" })).toBe("/home")
  })

  test("neither set ⇒ ~/.quanta (byte-identical legacy default)", () => {
    expect(quantaHomeDirFrom({})).toBe(join(homedir(), ".quanta"))
    expect(quantaHomeDirFrom({ QUANTA_CONFIG_DIR: "", QUANTA_HOME: "" })).toBe(
      join(homedir(), ".quanta"),
    )
  })

  test("ignores unrelated env keys", () => {
    expect(quantaHomeDirFrom({ HOME: "/x", CODEX_HOME: "/y" })).toBe(join(homedir(), ".quanta"))
  })
})

describe("quantaHomeDir() global singleton honors the HOME alias", () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = ["QUANTA_CONFIG_DIR", "QUANTA_HOME"]
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    __resetRuntimeConfig()
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    __resetRuntimeConfig()
  })

  test("QUANTA_HOME-only ⇒ quantaHomeDir() resolves to HOME (not ~/.quanta)", () => {
    process.env.QUANTA_HOME = "/srv/qhome"
    __resetRuntimeConfig()
    expect(quantaHomeDir()).toBe("/srv/qhome")
  })

  test("QUANTA_CONFIG_DIR wins over QUANTA_HOME in the singleton too", () => {
    process.env.QUANTA_HOME = "/srv/qhome"
    process.env.QUANTA_CONFIG_DIR = "/srv/cfg"
    __resetRuntimeConfig()
    expect(quantaHomeDir()).toBe("/srv/cfg")
  })
})
