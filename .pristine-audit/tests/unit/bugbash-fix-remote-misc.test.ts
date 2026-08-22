/**
 * Bugbash (jun-20) — remote-misc group.
 *
 * #25: `defaultAuthFile` must NOT silently root the default credential at the
 * filesystem root (`/.quanta/auth/chatgpt.json`) when HOME is unset. With HOME
 * unset it must resolve a REAL home via `os.homedir()`; with an injected HOME it
 * stays byte-identical to the legacy path.
 */

import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { defaultAuthFile } from "@/apps/bench/auth-pool"

describe("#25 defaultAuthFile — HOME-unset must not root at the filesystem root", () => {
  test("HOME unset ⇒ resolves under os.homedir(), never /.quanta/...", () => {
    // No HOME in the injected env bag — the legacy `env.HOME ?? ""` would yield
    // the absolute, FS-root-rooted `/.quanta/auth/chatgpt.json`.
    const resolved = defaultAuthFile({} as NodeJS.ProcessEnv)
    expect(resolved.startsWith("/.quanta/")).toBe(false)
    expect(resolved).toBe(`${homedir()}/.quanta/auth/chatgpt.json`)
  })

  test("HOME empty-string ⇒ also falls back to os.homedir(), not root", () => {
    const resolved = defaultAuthFile({ HOME: "" } as NodeJS.ProcessEnv)
    expect(resolved.startsWith("/.quanta/")).toBe(false)
    expect(resolved).toBe(`${homedir()}/.quanta/auth/chatgpt.json`)
  })

  test("injected HOME wins ⇒ byte-identical to the legacy path", () => {
    const resolved = defaultAuthFile({ HOME: "/home/u" } as NodeJS.ProcessEnv)
    expect(resolved).toBe("/home/u/.quanta/auth/chatgpt.json")
  })
})
