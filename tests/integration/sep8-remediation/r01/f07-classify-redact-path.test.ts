/**
 * F-07.4 consumer rail — live bash.classifySource → dispatch tool_result.
 * A synthetic env value that is NOT a format-regex secret must vanish on the
 * model-facing preview. Classifier-only or a source-scan of bash/index.ts is
 * not enough: the declared producer method must be invoked, and dispatch's
 * redactSecrets({ origin: "tool_result", sourceClass }) sink must fire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchTool } from "@/agent/dispatch"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { makeBashTool } from "@/tool/bash"

const SYNTH = "SYNTH_ENV_NOT_A_FORMAT_SECRET_9f3a"
const DUMP = `HOME=/Users/me\nAPI_TOKEN=${SYNTH}\nPATH=/usr/bin`

const BYPASS_COMMANDS = [
  "/bin/bash -c printenv",
  "zsh -c printenv",
  "bash -xc printenv",
  `bash -c "printenv 2>&1"`,
  `bash -c "printenv | cat"`,
  `node -e 'console.log(process["env"])'`,
  "eval printenv",
  `ruby -e "p ENV"`,
  "$(printenv)",
  `perl -e "print %ENV"`,
  `php -r "print_r(\$_ENV)"`,
  `deno eval "Deno.env.toObject()"`,
] as const

const bashProducer = makeBashTool()

/** Real classifySource / extractShellCommand; execute yields the dump without spawning. */
const stubBash: Tool = {
  ...bashProducer,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: DUMP } }
  },
}

const perm: PermissionContext = { mode: "bypass" }

const config = (): AgentConfig =>
  ({
    registry: new ToolRegistry([stubBash]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
  }) as AgentConfig

const call = (command: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "bash",
  input: { command },
})

let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "f07-perm-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  delete process.env.QUANTA_PERMISSION_STATE
})

describe("F-07.4 live bash.classifySource → dispatch redaction", () => {
  test("bash producer classifySource returns secret for the six audit families", () => {
    expect(typeof bashProducer.classifySource).toBe("function")
    for (const command of BYPASS_COMMANDS) {
      expect(bashProducer.classifySource?.({ command }), command).toBe("secret")
    }
    expect(bashProducer.classifySource?.({ command: "bash -c echo hi" })).toBe("public")
  })

  test("Layer-2 format regex does not catch the synthetic env value", async () => {
    const res = await dispatchTool(call("bash -c echo hi"), config(), perm)
    expect(res.ok).toBe(true)
    expect(res.preview).toContain(SYNTH)
    expect(res.preview).not.toContain("[REDACTED:source_class_secret]")
  })

  test("dispatch tool_result replaces the dump; raw synth is gone from model preview", async () => {
    for (const command of BYPASS_COMMANDS) {
      const res = await dispatchTool(call(command), config(), perm)
      expect(res.ok, command).toBe(true)
      expect(res.preview, command).not.toContain(SYNTH)
      expect(res.preview, command).toContain("[REDACTED:source_class_secret]")
      expect(res.block.content, command).not.toContain(SYNTH)
      expect(
        res.redactionHits?.some((h) => h.kind === "source_class_secret"),
        command,
      ).toBe(true)
    }
  })
})
