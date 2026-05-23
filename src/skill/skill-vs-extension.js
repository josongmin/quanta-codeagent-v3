/** Pure dispatch on `category`. Extensions are always non-user-invocable
 *  (slash-commands route through Skills only — see ADR-0040 §결정). */
export const classify = (fm) => {
    if (fm.category === "skill")
        return { kind: "skill", userInvocable: fm.userInvocable };
    if (fm.category === "extension") {
        if (fm.userInvocable) {
            // Defensive — Zod accepts the combo, but it would silently lie about
            // routability. Catch the contradiction loudly at runtime too.
            throw new ToolNotAllowedBySkillError(`extension '${fm.name}' must not declare userInvocable:true`);
        }
        return { kind: "extension", userInvocable: false };
    }
    // Exhaustiveness — unreachable while the Zod enum stays {skill, extension}.
    throw new ToolNotAllowedBySkillError(`unknown category '${fm.category}'`);
};
export class ToolNotAllowedBySkillError extends Error {
    name = "ToolNotAllowedBySkillError";
}
/** Throws if `toolName` is not in the frontmatter's whitelist. Empty list →
 *  no tool may be used. The host MUST call this before dispatching any tool
 *  invocation while a skill/extension is active. */
export const assertAllowedTool = (fm, toolName) => {
    if (!fm.allowedTools.includes(toolName)) {
        throw new ToolNotAllowedBySkillError(`tool '${toolName}' not permitted by '${fm.name}' (allowedTools=${fm.allowedTools.length === 0 ? "[]" : JSON.stringify(fm.allowedTools)})`);
    }
};
/** Non-throwing companion — useful when the host wants to filter a candidate
 *  tool set down to the permitted subset without try/catch. */
export const isToolAllowed = (fm, toolName) => fm.allowedTools.includes(toolName);
