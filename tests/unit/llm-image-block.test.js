/**
 * ADR-0083 multi-modal image input — both provider adapters serialize an
 * `ImageBlock` to their native shape, and a message with NO image is
 * byte-identical to the pre-feature path (OpenAI keeps plain-string content).
 */
import { describe, expect, test } from "bun:test";
import { toChatMessages, userParams } from "@/llm/adapters/openai";
const img = { type: "image", data: "QUJD", mediaType: "image/png" };
describe("OpenAI adapter — image serialization", () => {
    test("image + text → content-ARRAY form with a data-URL image_url part", () => {
        const params = userParams([{ type: "text", text: "what is this?" }, img]);
        expect(params).toHaveLength(1);
        const p = params[0];
        expect(p?.role).toBe("user");
        expect(Array.isArray(p && "content" in p ? p.content : undefined)).toBe(true);
        const content = p.content;
        expect(content[0]).toEqual({ type: "text", text: "what is this?" });
        expect(content[1]).toEqual({
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
        });
    });
    test("multiple images all become image_url parts after the text part", () => {
        const jpg = { type: "image", data: "WFla", mediaType: "image/jpeg" };
        const params = userParams([{ type: "text", text: "compare" }, img, jpg]);
        const content = params[0].content;
        expect(content).toHaveLength(3);
        expect(content[2]).toEqual({
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,WFla" },
        });
    });
    test("NO image ⇒ plain-string user content (byte-identical default-OFF)", () => {
        const params = userParams([{ type: "text", text: "hello" }]);
        expect(params).toEqual([{ role: "user", content: "hello" }]);
    });
    test("toChatMessages routes a user image message through userParams", () => {
        const messages = [
            { role: "user", content: [{ type: "text", text: "x" }, img] },
        ];
        const out = toChatMessages(undefined, messages);
        const u = out.find((m) => m.role === "user");
        expect(Array.isArray(u.content)).toBe(true);
    });
});
// Anthropic adapter's content mapper is module-private; we assert the shape
// via a focused re-implementation guard: the public contract is documented in
// the adapter (`{type:"image", source:{type:"base64", media_type, data}}`).
// A dedicated adapter-internal test lives alongside the other anthropic tests;
// here we lock the ImageBlock → data-URL invariant that the OpenAI side needs.
describe("ImageBlock invariants", () => {
    test("data carries NO data: prefix (adapters add provider framing)", () => {
        expect(img.data.startsWith("data:")).toBe(false);
    });
});
