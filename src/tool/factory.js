import { err, ok } from "@/shared";
/** Build a {@link Tool} from a spec, copying only the optional members that are
 *  actually present so a plain tool stays structurally identical to a literal. */
export const defineTool = (spec) => {
    const tool = {
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        isReadOnly: spec.isReadOnly,
        isConcurrencySafe: spec.isConcurrencySafe,
        execute: spec.execute,
    };
    if (spec.hitlTier !== undefined)
        tool.hitlTier = spec.hitlTier;
    if (spec.extractShellCommand !== undefined)
        tool.extractShellCommand = spec.extractShellCommand;
    if (spec.classifySource !== undefined)
        tool.classifySource = spec.classifySource;
    if (spec.outputSchema !== undefined)
        tool.outputSchema = spec.outputSchema;
    if (spec.toModelOutput !== undefined)
        tool.toModelOutput = spec.toModelOutput;
    if (spec.supportsDeferredResults !== undefined) {
        tool.supportsDeferredResults = spec.supportsDeferredResults;
    }
    if (spec.onInputStart !== undefined)
        tool.onInputStart = spec.onInputStart;
    if (spec.onInputDelta !== undefined)
        tool.onInputDelta = spec.onInputDelta;
    if (spec.onInputAvailable !== undefined)
        tool.onInputAvailable = spec.onInputAvailable;
    return tool;
};
/**
 * Pure helper: validate a structured value against a tool's `outputSchema`.
 * Returns a discriminated {@link Result} — `ok:true` with the parsed value, or
 * `ok:false` with a flattened, model-readable error message. NEVER throws.
 */
export const validateToolOutput = (schema, value) => {
    const parsed = schema.safeParse(value);
    if (parsed.success)
        return ok(parsed.data);
    const issues = parsed.error.issues
        .map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") : "(root)";
        return `${path}: ${i.message}`;
    })
        .join("; ");
    return err(issues === "" ? "output failed schema validation" : issues);
};
/**
 * Dispatch-side helper: given a tool's terminal {@link ToolResult}, apply the
 * tool's `outputSchema` (if any). When validation fails, returns an `ok:false`
 * placeholder result whose `output` instructs the model to retry — this is what
 * the dispatch seam forwards instead of throwing past the loop. When the tool
 * has no `outputSchema`, the result is returned unchanged (byte-identical).
 */
export const enforceOutputSchema = (tool, result) => {
    if (tool.outputSchema === undefined)
        return result;
    // Only validate successful results that actually carry a structured payload.
    if (!result.ok)
        return result;
    const v = validateToolOutput(tool.outputSchema, result.structured);
    if (v.ok)
        return result;
    return {
        ok: false,
        output: `Tool \`${tool.name}\` returned a structured result that failed validation: ${v.error}. ` +
            "Re-issue the call with output that matches the declared schema.",
    };
};
/**
 * Dispatch-side helper: render a result for the MODEL, preferring the tool's
 * compact `toModelOutput` when present and falling back to `result.output`
 * (today's behavior). Pure; never throws.
 */
export const renderModelOutput = (tool, result) => tool.toModelOutput !== undefined ? tool.toModelOutput(result) : result.output;
/**
 * Pure driver that feeds a sequence of streaming-input steps to a tool's
 * optional `onInputStart` / `onInputDelta` / `onInputAvailable` callbacks. A
 * tool that implements none of them is a no-op. Returns the accumulated raw
 * delta string (the partial-JSON buffer the dispatch seam would parse).
 *
 * TODO(absorb #1): wire into streaming-dispatch so live `tool_use_start` /
 * `tool_use_delta` / `tool_use_end` events drive these callbacks directly.
 */
export const driveStreamingInput = (tool, steps) => {
    let buffer = "";
    for (const step of steps) {
        switch (step.type) {
            case "start":
                tool.onInputStart?.();
                break;
            case "delta":
                buffer += step.delta;
                tool.onInputDelta?.(step.delta);
                break;
            case "available":
                tool.onInputAvailable?.(step.input);
                break;
        }
    }
    return buffer;
};
