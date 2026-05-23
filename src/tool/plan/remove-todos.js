import { planErrorMessage, planFailure } from "./error-mapping";
import { removeTodosSchema } from "./schemas";
export const removeTodosTool = () => ({
    name: "remove_todos",
    description: "Remove one or more todos atomically. Rejects with dependency_unknown if any " +
        "remaining todo still depends on a removed id. Pass expected_version from the last result.",
    inputSchema: removeTodosSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const mutator = ctx.planMutator;
        if (mutator === undefined) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: "remove_todos unavailable: plan-mode is not active.",
                    failure: { mode: "error", modelVisibleError: "plan-mode is not active" },
                },
            };
            return;
        }
        let result;
        try {
            result = mutator.removeTodos(input.ids, input.expected_version);
        }
        catch (e) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `remove_todos failed: ${e.message ?? String(e)}`,
                    failure: { mode: "error", modelVisibleError: "internal mutator error" },
                },
            };
            return;
        }
        if (!result.ok) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `remove_todos rejected (${result.code}): ${planErrorMessage(result.code)}`,
                    failure: planFailure(result.code),
                },
            };
            return;
        }
        yield {
            type: "result",
            result: {
                ok: true,
                output: `Removed ${result.touchedIds.length} todo(s) at v${result.version}.`,
            },
        };
    },
});
