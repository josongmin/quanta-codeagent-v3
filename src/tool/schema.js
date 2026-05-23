const node = (schema) => {
    const def = schema._def;
    const desc = def.description ? { description: def.description } : {};
    switch (def.typeName) {
        case "ZodString":
            return { type: "string", ...desc };
        case "ZodNumber":
            return { type: "number", ...desc };
        case "ZodBoolean":
            return { type: "boolean", ...desc };
        case "ZodEnum":
            return { type: "string", enum: def.values, ...desc };
        case "ZodArray":
            return { type: "array", items: node(def.type), ...desc };
        case "ZodOptional":
        case "ZodDefault":
            return { ...node(def.innerType), ...desc };
        case "ZodObject": {
            const shape = def.shape();
            const properties = {};
            const required = [];
            for (const [key, value] of Object.entries(shape)) {
                properties[key] = node(value);
                const optional = value._def.typeName === "ZodOptional" || value._def.typeName === "ZodDefault";
                if (!optional)
                    required.push(key);
            }
            return { type: "object", properties, required, ...desc };
        }
        case "ZodAny":
        case "ZodUnknown":
            // Intentionally unconstrained: an open schema (no `type`) means "any JSON
            // value", which is the correct mapping for z.any()/z.unknown(). Several
            // tool inputs legitimately use z.any() (e.g. passthrough payloads).
            return { ...desc };
        default:
            // Any other unhandled `typeName` falls back to an open (unconstrained)
            // schema rather than throwing: a tool advertising a permissive schema is
            // a safe degradation, whereas throwing here crashes the whole turn at
            // registry-build time. Tool inputs use only the constructs above + any.
            return { ...desc };
    }
};
export const zodToJsonSchema = (schema) => node(schema);
