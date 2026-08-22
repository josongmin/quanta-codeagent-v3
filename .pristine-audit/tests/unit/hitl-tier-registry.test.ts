/**
 * ADR-0047 — HITL annotation registry tests.
 *
 * Covers `resolveHitlAnnotation`:
 *   - precedence (baseline < built-in < override, but only when ratchet permits)
 *   - one-way ratchet (escalate only; downgrade refused + warned)
 *   - hand-off-required short-circuit (no override can relax it)
 *   - override file loader: missing file / malformed JSON / unknown tier /
 *     unknown schema fields / wrong version
 *   - commandPrefix matching: exact prefix, malformed input (no `command`
 *     field), input as raw string, no-match falls through
 *   - cache reset seam (`__resetHitlOverrides`)
 *   - runtimeConfig null/undefined path stays silent
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetHitlOverrides,
  builtinAnnotations,
  type HitlAnnotation,
  resolveHitlAnnotation,
} from "@/agent/hitl-tier-registry"
import { __resetRuntimeConfig } from "@/shared"

let tmp: string
let stderrCalls: string[] = []
let originalStderrWrite: typeof process.stderr.write

const captureStderr = (): void => {
  stderrCalls = []
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrCalls.push(typeof chunk === "string" ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write
}

const restoreStderr = (): void => {
  process.stderr.write = originalStderrWrite
}

const writeOverridesFile = (json: string): string => {
  const path = join(tmp, "hitl-overrides.json")
  writeFileSync(path, json, "utf8")
  return path
}

const applyOverridePath = (path: string | undefined): void => {
  if (path === undefined) delete process.env.QUANTA_HITL_OVERRIDES
  else process.env.QUANTA_HITL_OVERRIDES = path
  __resetRuntimeConfig()
  __resetHitlOverrides()
}

beforeEach(() => {
  tmp = join(tmpdir(), `hitl-overrides-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  captureStderr()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.QUANTA_HITL_OVERRIDES
  __resetRuntimeConfig()
  __resetHitlOverrides()
  restoreStderr()
})

describe("built-in table", () => {
  test("ships empty (framework-owned slot reserved; bash classifier already covers cases)", () => {
    expect(builtinAnnotations()).toEqual([])
  })
})

describe("resolveHitlAnnotation — baseline passthrough", () => {
  test("no override file, no built-in match ⇒ returns baseline unchanged", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("read", { path: "x.ts" }, "none")
    expect(r.tier).toBe("none")
    expect(r.matched).toBeUndefined()
  })

  test("baseline already pre-approval-ok stays when no override matches", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("write", { path: "x.ts" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(r.matched).toBeUndefined()
  })

  test("baseline already always-confirm stays without override", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("bash", { command: "git push origin main" }, "always-confirm")
    expect(r.tier).toBe("always-confirm")
    expect(r.matched).toBeUndefined()
  })
})

describe("resolveHitlAnnotation — one-way ratchet", () => {
  test("hand-off-required baseline is preserved even with relaxing override", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "none" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "anything" }, "hand-off-required")
    expect(r.tier).toBe("hand-off-required")
    // `matched` is undefined because the registry short-circuits before
    // reading the override list when baseline is hand-off-required.
    expect(r.matched).toBeUndefined()
  })

  test("override can ESCALATE pre-approval-ok → always-confirm", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [
          {
            tool: "bash",
            commandPrefix: "kubectl apply",
            tier: "always-confirm",
            reason: "k8s cluster mutations",
          },
        ],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation(
      "bash",
      { command: "kubectl apply -f x.yaml" },
      "pre-approval-ok",
    )
    expect(r.tier).toBe("always-confirm")
    expect(r.matched?.reason).toBe("k8s cluster mutations")
  })

  test("override can ESCALATE pre-approval-ok → hand-off-required", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [
          {
            tool: "bash",
            commandPrefix: "terraform apply",
            tier: "hand-off-required",
            reason: "infra change management",
          },
        ],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation(
      "bash",
      { command: "terraform apply -auto-approve" },
      "pre-approval-ok",
    )
    expect(r.tier).toBe("hand-off-required")
    expect(r.matched?.tool).toBe("bash")
  })

  test("override DOWNGRADE refused: always-confirm → none is ignored + warns", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "none", reason: "wrongly relaxed" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "git push" }, "always-confirm")
    expect(r.tier).toBe("always-confirm")
    // matched stays undefined because the override didn't apply.
    expect(r.matched).toBeUndefined()
    expect(stderrCalls.join("")).toContain("downgrade")
  })

  test("override at SAME tier is a no-op (matched stays undefined)", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "pre-approval-ok" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "ls -la" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(r.matched).toBeUndefined()
  })
})

describe("resolveHitlAnnotation — commandPrefix matching", () => {
  test("commandPrefix matches when input.command starts with the prefix", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "kubectl", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "kubectl get pods" }, "pre-approval-ok")
    expect(r.tier).toBe("always-confirm")
  })

  test("commandPrefix does NOT match when input.command differs", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "kubectl", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "ls -la" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(r.matched).toBeUndefined()
  })

  test("commandPrefix matches against raw string input", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "shell", commandPrefix: "sudo", tier: "hand-off-required" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("shell", "sudo systemctl restart x", "pre-approval-ok")
    expect(r.tier).toBe("hand-off-required")
  })

  test("malformed input (no `command` field) skips commandPrefix rules silently", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [
          { tool: "bash", commandPrefix: "kubectl", tier: "always-confirm" },
          { tool: "bash", tier: "pre-approval-ok" },
        ],
      }),
    )
    applyOverridePath(path)
    // Input has no `command` field — prefix rules fall through, tool-only
    // rule matches but is same-tier so no change.
    const r = resolveHitlAnnotation("bash", { foo: "bar" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
  })

  test("null input does not throw", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "kubectl", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", null, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
  })

  test("undefined input does not throw", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("bash", undefined, "none")
    expect(r.tier).toBe("none")
  })

  test("first matching rule wins (insertion order)", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [
          { tool: "bash", commandPrefix: "kubectl apply", tier: "hand-off-required" },
          { tool: "bash", commandPrefix: "kubectl", tier: "always-confirm" },
        ],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation(
      "bash",
      { command: "kubectl apply -f x.yaml" },
      "pre-approval-ok",
    )
    // First match wins → hand-off-required. (Operator is responsible for
    // ordering most-specific first.)
    expect(r.tier).toBe("hand-off-required")
  })
})

describe("override file loader — failure modes", () => {
  test("missing path env ⇒ empty overrides, no warn", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toBe("")
  })

  test("ENOENT (file does not exist) ⇒ silent fallback to built-in", () => {
    applyOverridePath(join(tmp, "missing.json"))
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    // ENOENT is the common case; we deliberately don't warn for it.
    expect(stderrCalls.join("")).not.toContain("missing.json")
  })

  test("malformed JSON ⇒ stderr warn + fall back to built-in", () => {
    const path = writeOverridesFile("{ not json")
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toContain("malformed JSON")
  })

  test("unknown tier value ⇒ stderr warn + fall back to built-in", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "wide-open" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toContain("schema validation failed")
  })

  test("wrong version ⇒ stderr warn + fall back to built-in", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 99,
        annotations: [{ tool: "bash", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toContain("schema validation failed")
  })

  test("unknown extra field ⇒ schema rejects (strict mode) + warn", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "always-confirm", extraField: 42 }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toContain("schema validation")
  })

  test("missing `tool` field ⇒ schema rejects", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toContain("schema validation")
  })

  test("annotations omitted defaults to empty array (file with only version)", () => {
    const path = writeOverridesFile(JSON.stringify({ version: 1 }))
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toBe("")
  })

  test("override path is empty string ⇒ treated as absent (no read attempt)", () => {
    process.env.QUANTA_HITL_OVERRIDES = ""
    __resetRuntimeConfig()
    __resetHitlOverrides()
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("pre-approval-ok")
    expect(stderrCalls.join("")).toBe("")
  })
})

describe("override caching + reset seam", () => {
  test("override list is cached across calls", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "x", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const a = resolveHitlAnnotation("bash", { command: "x stuff" }, "pre-approval-ok")
    // Mutate the file out from under us — cache should hold the original.
    writeFileSync(path, JSON.stringify({ version: 1, annotations: [] }), "utf8")
    const b = resolveHitlAnnotation("bash", { command: "x stuff" }, "pre-approval-ok")
    expect(a.tier).toBe("always-confirm")
    expect(b.tier).toBe("always-confirm")
  })

  test("__resetHitlOverrides forces re-read", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "x", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    expect(resolveHitlAnnotation("bash", { command: "x stuff" }, "pre-approval-ok").tier).toBe(
      "always-confirm",
    )
    writeFileSync(path, JSON.stringify({ version: 1, annotations: [] }), "utf8")
    __resetHitlOverrides()
    expect(resolveHitlAnnotation("bash", { command: "x stuff" }, "pre-approval-ok").tier).toBe(
      "pre-approval-ok",
    )
  })

  test("returned annotation list is frozen (cannot mutate from outside)", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    // Drive a single resolution to populate cache.
    resolveHitlAnnotation("bash", {}, "pre-approval-ok")
    // builtinAnnotations() returns a frozen array — mutation should
    // throw in strict mode. (The override list is private and only
    // touched via `resolveHitlAnnotation`, so we check the public
    // surface that callers actually have access to.)
    expect(() => {
      ;(builtinAnnotations() as HitlAnnotation[]).push({
        tool: "x",
        tier: "always-confirm",
      })
    }).toThrow()
  })
})

describe("hand-off-required preservation invariants", () => {
  test("baseline=hand-off-required with no override ⇒ stays hand-off-required", () => {
    applyOverridePath(undefined)
    const r = resolveHitlAnnotation("bash", { command: "rm -rf /" }, "hand-off-required")
    expect(r.tier).toBe("hand-off-required")
  })

  test("baseline=hand-off-required with tier=none override ⇒ stays hand-off-required", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", tier: "none" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "rm -rf /" }, "hand-off-required")
    expect(r.tier).toBe("hand-off-required")
  })

  test("override tier=hand-off-required + baseline=none ⇒ escalates to hand-off-required", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "read", tier: "hand-off-required", reason: "compliance" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("read", { path: "/etc/secret" }, "none")
    expect(r.tier).toBe("hand-off-required")
    expect(r.matched?.reason).toBe("compliance")
  })
})

describe("optional fields", () => {
  test("annotation without `reason` works", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "bash", commandPrefix: "x", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("bash", { command: "x" }, "pre-approval-ok")
    expect(r.tier).toBe("always-confirm")
    expect(r.matched?.reason).toBeUndefined()
  })

  test("annotation without `commandPrefix` matches every input for that tool", () => {
    const path = writeOverridesFile(
      JSON.stringify({
        version: 1,
        annotations: [{ tool: "write", tier: "always-confirm" }],
      }),
    )
    applyOverridePath(path)
    const r = resolveHitlAnnotation("write", { path: "x", content: "y" }, "pre-approval-ok")
    expect(r.tier).toBe("always-confirm")
  })
})
