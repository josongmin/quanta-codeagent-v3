import { planErrorMessage, planFailure } from "./error-mapping";
import { updatePlanSchema } from "./schemas";
export const updatePlanTool = () => ({
    name: "update_plan",
    description: "Update plan metadata (name, overview, isProject) and/or reorder phases. " +
        "phase_order must list ALL existing phase ids in the new order; partial reorder is rejected. " +
        "Pass expected_version from the last current()/result.",
    inputSchema: updatePlanSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const mutator = ctx.planMutator;
        if (mutator === undefined) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: "update_plan unavailable: plan-mode is not active.",
                    failure: { mode: "error", modelVisibleError: "plan-mode is not active" },
                },
            };
            return;
        }
        let result;
        try {
            const args = {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.overview !== undefined ? { overview: input.overview } : {}),
                ...(input.isProject !== undefined ? { isProject: input.isProject } : {}),
                ...(input.phase_order !== undefined ? { phaseOrder: input.phase_order } : {}),
            };
            result = mutator.updateMeta(args, input.expected_version);
        }
        catch (e) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `update_plan failed: ${e.message ?? String(e)}`,
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
                    output: `update_plan rejected (${result.code}): ${planErrorMessage(result.code)}`,
                    failure: planFailure(result.code),
                },
            };
            return;
        }
        yield {
            type: "result",
            result: { ok: true, output: `Plan meta updated at v${result.version}.` },
        };
    },
});
