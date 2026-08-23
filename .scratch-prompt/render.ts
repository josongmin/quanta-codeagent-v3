import { buildSystemPrompt } from "@/agent/prompt"
const variants: Array<[string, any]> = [
  ["DEFAULT bare (interactive CLI)", undefined],
  ["envPosture=default", { envPosture: "default" }],
  ["envPosture=owned", { envPosture: "owned" }],
  ["pack=batch frozen reproduce-first (bench)", { promptPack: "batch", envPosture: "frozen", verifyStrategy: "reproduce-first" }],
  ["pack=batch frozen grader-only", { promptPack: "batch", envPosture: "frozen", verifyStrategy: "grader-only" }],
  ["verify-after-edit", { verifyStrategy: "verify-after-edit" }],
  ["sectioned style", { promptStyle: "sectioned" }],
]
for (const [name, o] of variants) {
  const p = buildSystemPrompt(undefined, o)
  console.error(`## ${name}: BYTES=${Buffer.byteLength(p)} LINES=${p.split("\n").length} ~TOK=${Math.round(Buffer.byteLength(p)/4)}`)
  Bun.write(`.scratch-prompt/${name.replace(/[^a-z0-9]+/gi,"_")}.txt`, p)
}
