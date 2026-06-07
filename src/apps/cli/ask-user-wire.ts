/**
 * CLI wiring for the `ask_user` tool (ADR-0494).
 *
 * Lives in `src/apps/cli/` (the surface layer) because it OWNS terminal stdio —
 * which `src/host/runtime/` (non-app) is forbidden from doing by the
 * terminal-defaults ratchet. It reuses the SAME interactive prompter the MCP
 * elicitation surface uses (`buildCliElicitationPrompterFactory`, readline-on-
 * stdin / prompt-to-stderr, TTY-gated) so ONE prompter implementation serves
 * both the MCP elicitation path and the agent's `ask_user` tool.
 *
 * `askUserPortFromPrompter` is a PURE adapter (no stdio): it maps an
 * {@link AskUserRequest} onto the matching `ElicitationPrompter` method and
 * normalizes the result. The stdio lives entirely inside the injected prompter.
 *
 * Default-OFF: `buildCliAskUserTool` returns `null` unless `QUANTA_ASK_USER` is
 * on AND stdin is a TTY (a non-TTY / headless run yields no prompter ⇒ no tool ⇒
 * byte-identical menu; the agent simply never sees `ask_user`).
 */

import type { ElicitationPrompter, ElicitationResult } from "@/mcp"
import type {
  IntegerRequest,
  MultiSelectEnumRequest,
  NumberRequest,
  StringRequest,
} from "@/mcp/elicitation"
import { gateOn, omitUndef } from "@/shared"
import type { Tool } from "@/tool"
import {
  type AskUserFailureReason,
  type AskUserPort,
  type AskUserRequest,
  type AskUserResult,
  type AskUserValue,
  askUserTool,
} from "@/tool/ask-user"
import { buildCliElicitationPrompterFactory } from "./mcp-elicitation-prompter"

const mapReason = (r: ElicitationResult<unknown> & { ok: false }): AskUserFailureReason =>
  r.reason === "empty-enum" ? "empty-options" : r.reason

const toResult = <T extends AskUserValue>(r: ElicitationResult<T>): AskUserResult =>
  r.ok ? { ok: true, value: r.value } : { ok: false, reason: mapReason(r) }

const optTitle = (req: { title?: string }): { title?: string } =>
  req.title !== undefined ? { title: req.title } : {}

/** Route one structured request to the matching prompter method. The request
 *  shapes mirror the MCP elicitation schemas 1:1 (omitting undefined optionals
 *  under exactOptionalPropertyTypes; options copied to a mutable array). */
const dispatch = async (
  prompter: ElicitationPrompter,
  req: AskUserRequest,
  signal?: AbortSignal,
): Promise<AskUserResult> => {
  switch (req.kind) {
    case "string":
      return toResult(await prompter.promptString(omitUndef(req) as StringRequest, signal))
    case "boolean":
      return toResult(
        await prompter.promptBoolean({ prompt: req.prompt, ...optTitle(req) }, signal),
      )
    case "number":
      return toResult(await prompter.promptNumber(omitUndef(req) as NumberRequest, signal))
    case "integer":
      return toResult(await prompter.promptInteger(omitUndef(req) as IntegerRequest, signal))
    case "select":
      return toResult(
        await prompter.promptEnum(
          { prompt: req.prompt, options: [...req.options], ...optTitle(req) },
          signal,
        ),
      )
    case "multiselect":
      return toResult(
        await prompter.promptMultiEnum(
          omitUndef({
            prompt: req.prompt,
            options: [...req.options],
            ...optTitle(req),
            ...(req.minSelected !== undefined ? { minSelected: req.minSelected } : {}),
            ...(req.maxSelected !== undefined ? { maxSelected: req.maxSelected } : {}),
          }) as MultiSelectEnumRequest,
          signal,
        ),
      )
  }
}

/** Adapt an {@link ElicitationPrompter} into an {@link AskUserPort}. PURE — no
 *  stdio (the prompter owns it). NO-THROW: the prompter's result union is total;
 *  a thrown prompter is caught by the `ask_user` tool's own guard. */
export const askUserPortFromPrompter = (prompter: ElicitationPrompter): AskUserPort => ({
  ask: (req, signal) => dispatch(prompter, req, signal),
})

/**
 * Build the CLI `ask_user` tool, or `null` when it should not be registered.
 * Returns the tool ONLY when `QUANTA_ASK_USER` is on AND an interactive prompter
 * is available (TTY). Off / headless ⇒ `null` ⇒ the tool is absent (byte-identical
 * menu — the agent never sees `ask_user` where it could not be answered).
 */
export const buildCliAskUserTool = (
  env: Record<string, string | undefined> = process.env,
): Tool | null => {
  if (!gateOn(env, "QUANTA_ASK_USER")) return null
  const factory = buildCliElicitationPrompterFactory()
  if (factory === undefined) return null // non-TTY / headless ⇒ no prompter ⇒ no tool
  return askUserTool(askUserPortFromPrompter(factory("ask_user"))) as Tool
}
