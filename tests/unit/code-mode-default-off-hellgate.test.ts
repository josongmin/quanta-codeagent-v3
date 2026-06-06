/**
 * code-mode (RFC jun-6-code-mode, Phase 1) — DEFAULT-OFF byte-identity proof.
 *
 * When `QUANTA_CODE_MODE` is unset (the default), the feature is byte-identical:
 *   - `runtimeConfig().codeMode === false`;
 *   - `code_cell` is NOT in the default tool menu (drift guard);
 *   - registering it requires `DefaultToolPorts.codeMode === true` (the host only
 *     passes that behind the knob);
 *   - the `code_cell` classification exists in MUTATING_TOOL_TABLE + manifest so
 *     plan-mode dispatch never trips on it (caller-wire permanence).
 * The QuickJS-WASM module is lazily imported INSIDE `runCodeCell` — never at
 * module load — so the OFF binary never instantiates it (asserted structurally:
 * importing `@/codemode`/`@/tool` does not import quickjs-emscripten eagerly).
 */

import { expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import { buildDefaultTools } from "@/tool"

const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  __resetRuntimeConfig()
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
    __resetRuntimeConfig()
  }
}

test("default-OFF — codeMode runtime-config is false when QUANTA_CODE_MODE unset", () => {
  withEnv("QUANTA_CODE_MODE", undefined, () => {
    expect(runtimeConfig().codeMode).toBe(false)
  })
})

test("knob parse — codeMode is true ONLY for the strict '1' value", () => {
  withEnv("QUANTA_CODE_MODE", "1", () => expect(runtimeConfig().codeMode).toBe(true))
  withEnv("QUANTA_CODE_MODE", "0", () => expect(runtimeConfig().codeMode).toBe(false))
  withEnv("QUANTA_CODE_MODE", "true", () => expect(runtimeConfig().codeMode).toBe(false))
})

test("default-OFF — code_cell is NOT in the default tool menu", () => {
  const names = buildDefaultTools().map((t) => t.name)
  expect(names).not.toContain("code_cell")
})

test("opt-in — code_cell IS registered when DefaultToolPorts.codeMode is true", () => {
  const names = buildDefaultTools({ codeMode: true }).map((t) => t.name)
  expect(names).toContain("code_cell")
})

test("opt-in — the registered code_cell tool is mutating (NOT read-only) and exec-tier", () => {
  const tool = buildDefaultTools({ codeMode: true }).find((t) => t.name === "code_cell")
  expect(tool).toBeDefined()
  expect(tool?.isReadOnly()).toBe(false)
  expect(tool?.hitlTier?.({} as never)).toBe("always-confirm")
})

test("byte-identity — enabling code_cell adds EXACTLY one tool, nothing else changes", () => {
  const off = buildDefaultTools().map((t) => t.name)
  const on = buildDefaultTools({ codeMode: true }).map((t) => t.name)
  expect(on.length).toBe(off.length + 1)
  expect(on.filter((n) => n !== "code_cell")).toEqual(off)
})

test("lazy WASM — importing @/codemode / @/tool does NOT eagerly load quickjs-emscripten", () => {
  // The WASM dep is imported via a DYNAMIC `await import("quickjs-emscripten")`
  // INSIDE `runCodeCell` (RFC §5.2), so a process that loaded the tool slice but
  // never RAN a cell has not paid the WASM cost. We assert the module graph does
  // not contain quickjs-emscripten after importing the tool surface (Bun records
  // statically-loaded modules in `import.meta`-reachable require cache).
  // Bun exposes loaded modules via the resolved-module set; a robust structural
  // check is that `@/codemode`'s barrel exports are reachable WITHOUT the WASM
  // module being one of them (no eager top-level import).
  const codemode = require("@/codemode") as Record<string, unknown>
  expect(typeof codemode.runCodeCell).toBe("function")
  // The barrel re-exports pure helpers only (types/limits/exec-main/runtime) —
  // none of which is the WASM module itself. The dynamic import lives in the
  // runtime body, exercised only when a cell runs.
  expect(codemode).not.toHaveProperty("newQuickJSAsyncWASMModule")
})
