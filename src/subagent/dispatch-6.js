/**
 * Subagent 6-tool dispatch routing (ADR-0041).
 *
 * Single entrypoint that takes a 6-tool name + already-parsed input and
 * routes to the appropriate handler in `./handlers-6`. The router validates
 * input against the frozen contract from `./tools-6`, so callers can pass
 * untrusted `unknown` payloads.
 *
 * Failure shape — every tool returns its discriminated `success|error`
 * union; the router itself NEVER throws. Three meta-error modes:
 *   - unknown tool name      → `{kind:"error", cause:"unknown_tool"}`
 *   - input fails contract   → `{kind:"error", cause:"input_invalid"}`
 *   - missing dep injection  → `{kind:"error", cause:"deps_missing"}`
 */
import { handleCloseAgent, handleExecCommand, handleSendInput, handleSpawnAgent, handleWaitAgent, handleWriteStdin, } from "./handlers-6";
import { CloseAgentInputSchema, ExecCommandInputSchema, SendInputInputSchema, SpawnAgentInputSchema, SUBAGENT_6_TOOL_NAMES, WaitAgentInputSchema, WriteStdinInputSchema, } from "./tools-6";
const metaError = (message, cause) => ({
    kind: "error",
    message,
    cause,
});
/** Narrow string ⇒ Subagent6ToolName when the value is in the frozen set. */
export const isSubagent6Tool = (name) => SUBAGENT_6_TOOL_NAMES.includes(name);
/** Schema table keyed by tool name — flat lookup keeps `parseInput`'s
 *  cognitive complexity below the biome cap (was a 5-level nested ternary). */
const SCHEMA_BY_NAME = {
    exec_command: ExecCommandInputSchema,
    write_stdin: WriteStdinInputSchema,
    spawn_agent: SpawnAgentInputSchema,
    wait_agent: WaitAgentInputSchema,
    close_agent: CloseAgentInputSchema,
    send_input: SendInputInputSchema,
};
/** Validate `raw` against the per-tool input schema. Returns the parsed
 *  value or a structured error so the router can short-circuit. */
const parseInput = (toolName, raw) => {
    const parsed = SCHEMA_BY_NAME[toolName].safeParse(raw);
    if (parsed.success)
        return { kind: "parsed", value: parsed.data };
    const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    return {
        kind: "rejected",
        error: metaError(`Input failed contract validation: ${detail}`, "input_invalid"),
    };
};
const routeExecCommand = (input, deps) => handleExecCommand(input, deps.ptyTable !== undefined ? { ptyTable: deps.ptyTable } : {}, deps.signal);
const routeWriteStdin = async (input, deps) => {
    if (deps.ptyTable === undefined) {
        return metaError("write_stdin requires a ptyTable", "deps_missing");
    }
    return handleWriteStdin(input, {
        ptyTable: deps.ptyTable,
    });
};
const routeSpawnAgent = async (input, deps) => {
    if (deps.runner === undefined || deps.registry === undefined) {
        return metaError("spawn_agent requires a runner + registry", "deps_missing");
    }
    return handleSpawnAgent(input, {
        runner: deps.runner,
        registry: deps.registry,
        ...(deps.maxDepth !== undefined ? { maxDepth: deps.maxDepth } : {}),
        ...(deps.parentDepth !== undefined ? { parentDepth: deps.parentDepth } : {}),
    });
};
const routeWaitAgent = async (input, deps) => {
    if (deps.registry === undefined) {
        return metaError("wait_agent requires a registry", "deps_missing");
    }
    return handleWaitAgent(input, {
        registry: deps.registry,
    });
};
const routeCloseAgent = async (input, deps) => {
    if (deps.registry === undefined) {
        return metaError("close_agent requires a registry", "deps_missing");
    }
    return handleCloseAgent(input, {
        registry: deps.registry,
        ...(deps.ptyTable !== undefined ? { ptyTable: deps.ptyTable } : {}),
        ...(deps.ownerToken !== undefined ? { ownerToken: deps.ownerToken } : {}),
    });
};
const routeSendInput = async (input, deps) => {
    if (deps.registry === undefined) {
        return metaError("send_input requires a registry", "deps_missing");
    }
    return handleSendInput(input, {
        registry: deps.registry,
        ...(deps.inputChannel !== undefined ? { inputChannel: deps.inputChannel } : {}),
    });
};
const ROUTES = {
    exec_command: routeExecCommand,
    write_stdin: routeWriteStdin,
    spawn_agent: routeSpawnAgent,
    wait_agent: routeWaitAgent,
    close_agent: routeCloseAgent,
    send_input: routeSendInput,
};
/**
 * Dispatch a 6-tool call. The output is the tool's own discriminated union
 * (success/error) — callers map it onto the wider tool_result envelope at
 * their own layer.
 *
 * The router checks for the SPECIFIC dependencies a given tool needs and
 * fails fast with `deps_missing` when a required dep is absent — this is
 * the structural signal that "this slice is wired up correctly", not a
 * silent no-op.
 */
export const dispatchSubagent6 = async (toolName, rawInput, deps) => {
    if (!isSubagent6Tool(toolName)) {
        return metaError(`Unknown subagent-6 tool: ${toolName}`, "unknown_tool");
    }
    const parsed = parseInput(toolName, rawInput);
    if (parsed.kind === "rejected")
        return parsed.error;
    return ROUTES[toolName](parsed.value, deps);
};
