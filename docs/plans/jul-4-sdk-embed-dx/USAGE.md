# quanta SDK — embed usage

In-process embed of quanta's agent loop as the MAIN loop of your repo-analysis
system. One public door: `quanta-codeagent/sdk`.

## Build the SDK bundle

```sh
bun run build:sdk      # → dist/sdk/index.js (single ESM bundle; @/ aliases inlined)
```

`package.json` exposes it as the `./sdk` subpath:
```jsonc
"exports": { "./sdk": { "import": "./dist/sdk/index.js" } }
```

## Hello, analysis (10 lines)

```ts
import { createAnalysisAgent } from "quanta-codeagent/sdk"

const agent = createAnalysisAgent({
  cwd: "/path/to/repo",
  model: "claude-opus-4-8",     // provider key from env (ANTHROPIC_API_KEY / …)
})

const outcome = await agent.run("Map the dependency graph of the auth module.")
console.log(outcome.reason, outcome.turns)
```

## Inject your own tools + stream events

```ts
import { createAnalysisAgent, defineTool } from "quanta-codeagent/sdk"
import { z } from "zod"

const grep = defineTool({
  name: "repo_grep",
  description: "Search the repo",
  inputSchema: z.object({ pattern: z.string() }),
  isReadOnly: () => true,
  async *execute(input) { yield { type: "result", output: await mySearch(input.pattern) } },
})

const agent = createAnalysisAgent({
  cwd, model: "claude-opus-4-8",
  tools: [grep],              // merged with quanta defaults (includeDefaultTools: true)
  profile: "read-only",       // strips mutating tools; "analysis" (default) allows edits
})

for await (const e of agent.run("Find every call site of `login()`.")) {
  myPipeline.ingest(e)        // or use run(prompt, { onToolCall, onText, onDone })
}
```

## Bring your own LLM

```ts
createAnalysisAgent({ cwd, model: "x", llm: myLLMPort })   // reuse your model stack; env ignored
```

## Deterministic tests (no network)

```ts
import { createAnalysisAgent, fakeLlm, isDone } from "quanta-codeagent/sdk"

const agent = createAnalysisAgent({ cwd, model: "x", llm: fakeLlm([{ text: "done" }]) })
const events = []
for await (const e of agent.run("go")) events.push(e)
expect(events.some(isDone)).toBe(true)
```

## Profiles

| profile | 멀티턴 | 파일 mutate | quanta 자체 네트워크 | 비고 |
|---|---|---|---|---|
| `read-only` | ✅ | ✕ (registry 필터 + deny-default) | denied | 순수 static |
| `analysis`(기본) | ✅ | ✅ (bypass + hitl.autoApprove) | denied | 주입 in-process 툴은 net 자유 |

`net denied`는 quanta의 Bash/web_fetch egress만 막음 — 네가 주입한 in-process 툴은
영향 없음(§04). quanta 자체가 네트워크를 써야 하면 새 matrix 모드 필요(§04-B).
(`full` 프로파일=memory/subagent/MCP는 미구현이라 아직 union에 없음.)

## 안전 posture (autonomous)

`analysis`는 자율(사람 없음)이라 mutating 도구를 자동 승인한다. 다만 blanket-yes가
아니다:
- **HARD_DENY floor**(`rm -rf`, `git push --force`, credential-exfil pipe 등)는
  auto-approve와 무관하게 항상 차단(permission 정책 최상단에서 실행).
- **hand-off-required** tier는 `hitl.autoApprove`가 절대 opt-out하지 않음.
- 단, 일반 `git push`·`npm publish`·`gh pr` 같은 도구를 네가 **직접 주입**하면
  자동 승인된다(기본 도구셋엔 없음). 비가역/민감 작업을 자율 실행시키기 싫으면
  `read-only` 프로파일을 쓰거나 그 도구를 주입하지 마라.

## Remaining

- `.d.ts` 번들: 현재 exports는 runtime(`import`)만. 외부 TS 타입은 dts-bundle 스텝 후 `"types"` 추가 예정.
- `full` 프로파일 wire-slot 조립(memory/subagent/MCP).
