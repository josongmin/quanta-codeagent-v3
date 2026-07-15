/**
 * The exec/PTY owner is intentionally split from the six-tool handler facade.
 * These identity checks pin the public API boundary so callers keep one
 * `PtyTable` class and one exec implementation after future decomposition.
 */
import { describe, expect, test } from "bun:test"
import {
  PtyTable as OwnerPtyTable,
  handleExecCommand as ownerHandleExecCommand,
  MAX_PTY as ownerMaxPty,
} from "@/subagent/exec-command"
import {
  PtyTable as FacadePtyTable,
  handleExecCommand as facadeHandleExecCommand,
  MAX_PTY as facadeMaxPty,
} from "@/subagent/handlers-6"

describe("subagent exec-command owner facade", () => {
  test("handlers-6 preserves the established exec and PTY exports", () => {
    expect(facadeHandleExecCommand).toBe(ownerHandleExecCommand)
    expect(FacadePtyTable).toBe(OwnerPtyTable)
    expect(facadeMaxPty).toBe(ownerMaxPty)
  })
})
