import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildOwnershipPolicy,
  checkWriteEffects,
  consultOwnershipPolicy,
  isPathAllowed,
} from "@/agent/ownership-policy"
import { extractWriteEffects } from "@/permission"

// §20.4 / ticket-12 — subagent FS owned/forbidden ENFORCEMENT (was advisory
// prompt-text only). The agent MUST be hard-blocked at the tool layer from
// writing outside its owned surfaces / inside its forbidden surfaces — including
// `..` traversal, symlink escape, and bash `sed -i`/redirect circumvention.
// Default-OFF (enforced:false ⇒ advisory legacy, byte-identical).

// ── pure matcher (canonical absolute paths in) ───────────────────────────────
describe("isPathAllowed — pure subtree matcher", () => {
  const policy = (over: object = {}) => ({
    owned: ["/repo/src"],
    forbidden: ["/repo/src/secrets"],
    enforced: true,
    ...over,
  })

  test("DEFAULT-OFF: enforced:false ⇒ everything allowed (advisory legacy)", () => {
    expect(isPathAllowed("/anywhere/x", { owned: ["/repo/src"], enforced: false }).allowed).toBe(
      true,
    )
    expect(isPathAllowed("/anywhere/x", undefined).allowed).toBe(true)
  })
  test("owned subtree (file inside) ⇒ allowed", () => {
    expect(isPathAllowed("/repo/src/main.ts", policy()).allowed).toBe(true)
    expect(isPathAllowed("/repo/src", policy()).allowed).toBe(true) // the dir itself
  })
  test("outside owned ⇒ DENIED (not_owned)", () => {
    const v = isPathAllowed("/repo/docs/readme.md", policy())
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe("not_owned")
  })
  test("forbidden subtree ⇒ DENIED even when also inside owned (forbidden wins)", () => {
    const v = isPathAllowed("/repo/src/secrets/key.txt", policy())
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe("forbidden")
  })
  test("empty owned + forbidden set ⇒ allow-all-except-forbidden", () => {
    expect(isPathAllowed("/anywhere/x", { forbidden: ["/etc"], enforced: true }).allowed).toBe(true)
    expect(isPathAllowed("/etc/passwd", { forbidden: ["/etc"], enforced: true }).allowed).toBe(
      false,
    )
  })
})

// ── gate over extracted write-effects (canonical) ────────────────────────────
describe("consultOwnershipPolicy — gate over write-effects", () => {
  const policy = buildOwnershipPolicy({
    owned: ["/repo/src"],
    forbidden: [],
    cwd: "/repo",
    enforced: true,
  })

  test("all effects owned ⇒ allowed", () => {
    expect(consultOwnershipPolicy([{ path: "/repo/src/a.ts" }], policy).allowed).toBe(true)
  })
  test("any effect outside owned ⇒ DENIED with the offending path", () => {
    const v = consultOwnershipPolicy(
      [{ path: "/repo/src/a.ts" }, { path: "/repo/docs/b.md" }],
      policy,
    )
    expect(v.allowed).toBe(false)
    if (!v.allowed) expect(v.path).toBe("/repo/docs/b.md")
  })
  test("no effects (read-only) ⇒ allowed", () => {
    expect(consultOwnershipPolicy([], policy).allowed).toBe(true)
  })
  test("enforced:false ⇒ allowed regardless", () => {
    const off = buildOwnershipPolicy({ owned: ["/repo/src"], cwd: "/repo", enforced: false })
    expect(consultOwnershipPolicy([{ path: "/anywhere" }], off).allowed).toBe(true)
  })
})

// ── buildOwnershipPolicy — canonicalize + relative resolution ─────────────────
describe("buildOwnershipPolicy", () => {
  test("resolves relative owned/forbidden against cwd; undefined when both empty", () => {
    expect(buildOwnershipPolicy({ cwd: "/repo", enforced: true })).toBeUndefined()
    const p = buildOwnershipPolicy({ owned: ["src", "test"], cwd: "/repo", enforced: true })
    expect(p?.owned).toEqual(["/repo/src", "/repo/test"])
    expect(p?.enforced).toBe(true)
  })
})

// ── E2E: real escapes (symlink / `..`) + bash circumvention are DENIED ────────
describe("§20.4 E2E — canonical escapes + bash circumvention are blocked", () => {
  test("`..` traversal out of owned ⇒ DENIED (canonical)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "own-"))
    try {
      const policy = buildOwnershipPolicy({
        owned: ["src"],
        forbidden: [],
        cwd: tmp,
        enforced: true,
      })
      // a write to src/../secret/key resolves to <tmp>/secret/key — outside owned.
      const effects = extractWriteEffects("write", { path: "src/../secret/key" }, null, tmp, false)
      const v = checkWriteEffects(effects, policy) // re-canonicalizes consistently
      expect(v.allowed).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("symlink escape out of owned ⇒ DENIED (symlink-resolved canonical)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "own-"))
    try {
      // owned = <tmp>/src ; a symlink <tmp>/src/out → <tmp>/secret
      const fs = require("node:fs")
      fs.mkdirSync(join(tmp, "src"), { recursive: true })
      fs.mkdirSync(join(tmp, "secret"), { recursive: true })
      symlinkSync(join(tmp, "secret"), join(tmp, "src", "out"))
      writeFileSync(join(tmp, "secret", "k"), "x")
      const policy = buildOwnershipPolicy({
        owned: ["src"],
        forbidden: [],
        cwd: tmp,
        enforced: true,
      })
      // write to src/out/k → resolves through the symlink to secret/k (outside owned).
      // checkWriteEffects symlink-resolves the effect (circumvention's is lexical).
      const effects = extractWriteEffects("write", { path: "src/out/k" }, null, tmp, false)
      const v = checkWriteEffects(effects, policy)
      expect(v.allowed).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("bash `sed -i` writing a forbidden file ⇒ DENIED (circumvention extractor)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "own-"))
    try {
      const policy = buildOwnershipPolicy({
        owned: [],
        forbidden: ["secret"],
        cwd: tmp,
        enforced: true,
      })
      const cmd = `sed -i 's/a/b/' ${join(tmp, "secret", "config.txt")}`
      const effects = extractWriteEffects("bash", { command: cmd }, cmd, tmp, false)
      const v = checkWriteEffects(effects, policy)
      expect(v.allowed).toBe(false)
      if (!v.allowed) expect(v.reason).toBe("forbidden")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
