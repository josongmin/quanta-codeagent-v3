# Comparative Differentiators Audit

Overview router: [may-20-codex-agent-loop.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/may-20-codex-agent-loop.md)

이 문서는 현재 세션에서 관측 가능한 Codex agent contract를 기준으로, `다른 에이전트와 비교했을 때 무엇이 실제 차별점인가`를 감사 관점으로 정리한다.

중요:
- 이 문서는 특정 외부 제품과의 marketing 비교가 아니다.
- 비교 기준은 아래 두 클래스다.
  1. 일반적인 chat-only LLM assistant
  2. 단순한 tool-using coding agent

표기:
- `[FACT]`: 현재 세션 지침, tool schema, app context, repo-local rules에서 직접 관측 가능한 사실
- `[STRONG-INFERENCE]`: 관측 사실을 가장 잘 설명하는 고신뢰 비교 추론
- `[WEAK-INFERENCE]`: plausible 하지만 외부 agent들에 대한 직접 증거가 부족한 비교 해석

주의:
- 외부 agent의 내부 구조를 직접 관측한 것은 아니므로, “남들과 다르다”는 표현도 현재 세션의 visible contract 기준에서만 제한적으로 쓴다.

---

## 1. Executive summary

### 1.1 Final verdict

- `Alignment`: High `[STRONG-INFERENCE]`
- `Robustness`: Medium-to-Strong `[STRONG-INFERENCE]`
- `Confidence`: High on visible differentiators, Medium on cross-agent generalization `[STRONG-INFERENCE]`
- `Ship readiness`: Ship as analysis doc `[STRONG-INFERENCE]`

### 1.2 Top conclusions

1. 가장 큰 차별점은 `단순 tool invocation`이 아니라 **정책 계층이 매우 두꺼운 도구-사용형 agent**라는 점이다. `[STRONG-INFERENCE]`
2. 두 번째 차별점은 `chat answer`보다 `execution contract`가 훨씬 강하다는 점이다: sandbox, approval, HITL, repo-local ops, mode gating이 동시에 작동한다. `[FACT]` + `[STRONG-INFERENCE]`
3. 세 번째 차별점은 `artifact-producing collaboration`이 1급 시민이라는 점이다: 코드 수정, 문서 생성, plugin path, browser path, git directives, review directives가 같이 엮여 있다. `[FACT]`
4. 네 번째 차별점은 `working-state discipline`이 강하다는 점이다: 최소 읽기, 재읽기 억제, validation budget, patch-vs-script 전략 전환, subagent bounded use가 명시돼 있다. `[FACT]` + `[STRONG-INFERENCE]`
5. 반대로 “완전히 독자적인 planner”나 “전역 persistent memory” 같은 것은 현재 증거로 차별점이라고 주장하면 안 된다. `[FACT]`

---

## 2. Comparison baseline

이 문서의 baseline은 아래다.

### 2.1 Baseline A: chat-only assistant

특성:
- 텍스트 응답 중심
- 도구 없음 또는 매우 제한적
- 로컬 파일/셸/브라우저 실행 contract 약함

이 baseline은 일반적인 분류 기준으로만 사용한다. `[STRONG-INFERENCE]`

### 2.2 Baseline B: simple coding agent

특성:
- 셸과 patch 정도는 있지만
- sandbox/approval/HITL/plugin/mode/repo-local ops가 지금만큼 두껍지 않을 수 있음

이 baseline도 직접 외부 구현을 본 건 아니므로 비교는 조심스럽다. `[WEAK-INFERENCE]`

---

## 3. Differentiator 1: thick policy stack

## 3.1 What is directly visible

현재 세션에는 아래 policy layers가 동시에 존재한다. `[FACT]`

1. system instructions
2. developer instructions
3. app context
4. collaboration mode
5. personality spec
6. skills instructions
7. plugins instructions
8. repo-local `AGENTS.md`

## 3.2 Why this is a differentiator

많은 assistant는 system prompt와 tool list 정도만 갖고 있어도 이상하지 않지만,
현재 Codex contract는:
- runtime
- mode
- plugin preference
- skill workflow
- repo-local ops rule

까지 겹친다. 이는 tool-using agent 중에서도 policy surface가 매우 두꺼운 편으로 보인다. `[STRONG-INFERENCE]`

## 3.3 Practical effect

이 두꺼운 policy stack 때문에:
- 같은 코드 수정 task도 단순 “patch”로 축약되지 않는다
- mode, validation budget, repo front-door, HITL, plugin preference까지 모두 개입한다

이건 visible contract로 직접 뒷받침된다. `[FACT]` + `[STRONG-INFERENCE]`

---

## 4. Differentiator 2: execution contract > answer contract

## 4.1 Observable evidence

현재 세션은 단순 “잘 답해라”보다 다음이 훨씬 자세하다. `[FACT]`

1. sandbox mode
2. approval policy
3. confirmation/HITL tiers
4. mode-specific tool availability
5. repo-local operational boundary
6. tool-specific channel/usage constraints

## 4.2 Why this matters

chat assistant는 answer contract가 중심이지만,
여기서는 execution contract가 거의 OS/operator layer 수준으로 구체적이다. `[STRONG-INFERENCE]`

예:
- `request_user_input`는 mode-gated
- `exec_command`는 escalation-aware
- Rust verification은 `scripts/cg-dispatch`
- destructive / sensitive action은 HITL rail

이건 도구가 단순 부가기능이 아니라 **governed execution surface**라는 의미다. `[STRONG-INFERENCE]`

---

## 5. Differentiator 3: repo-local operational embedding

## 5.1 Observable evidence

현재 repo의 `AGENTS.md`는 일반 style guide가 아니라 operational contract를 직접 제공한다. `[FACT]`

예:
- no heuristics
- fail-closed
- probe-first, test-last
- owner-local first
- direct cargo 금지
- front-door only

## 5.2 Why this is differentiating

많은 assistant는 repo를 텍스트 corpus처럼 읽지만,
현재 Codex contract는 repo를 `operational environment`로 읽는다. `[STRONG-INFERENCE]`

즉:
- repo-local instructions가 prompt decoration이 아니라
- command path, verification path, patch discipline을 실제로 결정한다

이 점은 단순한 coding bot과 구분되는 강한 특징이다. `[STRONG-INFERENCE]`

---

## 6. Differentiator 4: explicit mode system

## 6.1 Observable evidence

1. `Default` and `Plan` modes are explicitly named `[FACT]`
2. mode changes only via developer instructions `[FACT]`
3. `request_user_input` availability is mode-dependent `[FACT]`
4. Default mode behavior is explicitly prescribed `[FACT]`

## 6.2 Why this matters

mode가 단순 tone switch가 아니라:
- tool availability
- human-choice structure
- interruption style

를 바꾸는 contract로 보인다. `[STRONG-INFERENCE]`

이건 일반 chat agent보다 operator/agent framework에 더 가깝다.

---

## 7. Differentiator 5: plugin + skill + app bundle model

## 7.1 Observable evidence

1. enabled plugins list exists `[FACT]`
2. plugins are not invoked directly `[FACT]`
3. plugin-contributed skills are visible `[FACT]`
4. plugin preference routing rule exists `[FACT]`

## 7.2 Why this is differentiating

plugin을 단순 tool 설치가 아니라:
- skills
- MCP resources
- app integrations

bundle로 다루는 것은 capability architecture 측면에서 더 layered하다. `[STRONG-INFERENCE]`

특히 browser/documents/github/presentations/spreadsheets 같은 plugin rail이 visible한 점은
“코드 수정기”를 넘어 workspace operator 쪽 성격을 강화한다. `[STRONG-INFERENCE]`

---

## 8. Differentiator 6: budget discipline is explicit

## 8.1 Observable evidence

현재 세션에는 아래가 직접 명시돼 있다. `[FACT]`

- tool calls are expensive
- broad scan 금지
- 필요한 파일만 읽기
- 재읽기 금지
- validation은 요청 시만
- 병렬은 독립 read / bounded delegation

## 8.2 Why this matters

많은 agent 설명은 “필요하면 알아서 탐색” 정도로 끝나지만,
현재 Codex contract는 budget을 거의 first-class policy로 다룬다. `[STRONG-INFERENCE]`

즉:
- prompt에서 바로 `cost model`이 visible하다
- 그래서 행동이 단순 능력보다 협업 효율에 맞춰 조여진다

---

## 9. Differentiator 7: honesty rail is explicit

## 9.1 Observable evidence

현재 세션은 아래를 직접 요구한다. `[FACT]`

- 검증 안 했으면 말해야 함
- partial이면 partial이라 말해야 함
- 남은 gap을 숨기지 말아야 함

## 9.2 Why this matters

이건 단순 style이 아니라 execution contract의 일부다. `[STRONG-INFERENCE]`

즉:
- validation budget을 줄여도
- false completion을 못 하게 하는 reporting rail이 있다

이건 “just answer” agent보다 operator honesty contract가 더 강하다는 뜻이다.

---

## 10. Differentiator 8: artifact-centric work product

## 10.1 Observable evidence

현재 세션에서 visible한 artifact surfaces:

- local files and repo edits `[FACT]`
- docs under `/docs/analysis/codex-agent/` `[FACT]`
- document/presentation/spreadsheet plugins `[FACT]`
- image rendering/editing path `[FACT]`
- git directives `[FACT]`
- code-comment directive `[FACT]`

## 10.2 Why this matters

많은 assistant는 답변 텍스트가 주 산출물이지만,
여기선 artifact 자체가 1급 산출물이다. `[STRONG-INFERENCE]`

즉 Codex는:
- 말로 설명하는 assistant이기도 하지만
- 실제 작업 산출물을 조작하고 남기는 operator이기도 하다

---

## 11. Non-differentiators / things we should not overclaim

아래는 현재 증거로 “특별히 다르다”고 말하면 안 되는 것들이다.

### 11.1 Hidden planner sophistication

- internal planner exact shape는 보이지 않는다 `[FACT]`
- 따라서 “타 agent 대비 planner가 더 고급이다”는 주장은 금지 `[FACT]`

### 11.2 Global long-term memory

- explicit global memory API evidence 없음 `[FACT]`
- 따라서 “다른 agent보다 memory가 더 강하다”는 주장은 금지 `[FACT]`

### 11.3 Unique replay completeness

- current cassette path is partial/placeholder in key places `[FACT]`
- 따라서 “replay/determinism infra가 이미 fully superior”라고 말하면 안 된다 `[FACT]`

---

## 12. Comparison matrix

| Axis | Chat-only assistant | Simple coding agent | Current Codex visible contract | Confidence |
| --- | --- | --- | --- | --- |
| Tool surface | limited | shell/patch 중심 | shell/web/image/plugin/MCP/subagent/app directives | `[FACT]` |
| Policy thickness | low-medium | medium | very high | `[STRONG-INFERENCE]` |
| Mode system | often absent | often limited | explicit Default/Plan | `[FACT]` |
| HITL granularity | often coarse | variable | explicit 4-tier model | `[FACT]` |
| Repo-local ops integration | low | medium | high | `[FACT]` + `[STRONG-INFERENCE]` |
| Budget explicitness | low | medium | high | `[FACT]` |
| Artifact-centricity | medium | medium-high | high | `[FACT]` + `[STRONG-INFERENCE]` |

주의:
- 왼쪽 두 열은 일반 baseline이라 직접 관측값이 아니다
- 따라서 비교 강도는 제한적이다 `[WEAK-INFERENCE]`

---

## 13. Attack surface analysis

## 13.1 False assumption: “difference is just more tools”

- insufficient
- 진짜 차이는 policy/mode/permission/HITL/repo-local layering에 있다
- severity: P1

Classification:
- `[STRONG-INFERENCE]`

## 13.2 False assumption: “difference is just stronger prompting”

- insufficient
- tool schema, app directives, mode gating, plugin system, approval/sandbox visibility가 직접 보인다
- severity: P1

Classification:
- `[FACT]` + `[STRONG-INFERENCE]`

## 13.3 False assumption: “it is fundamentally unique everywhere”

- overclaim
- current session visible contract 기준에서만 말해야 한다
- severity: P2

Classification:
- `[FACT]`

---

## 14. Concrete failure scenarios if differentiation is misunderstood

### Scenario 1: treat Codex like plain chat assistant

- setup: repo-local coding task
- trigger: ignore shell/tools/repo ops contract
- expected: execution-oriented path
- failure: wrong abstraction layer
- severity: P1

### Scenario 2: treat Codex like generic shell bot

- setup: sensitive action or browser/plugin-heavy task
- trigger: ignore HITL/mode/plugin policies
- expected: governed execution
- failure: consent/policy violation
- severity: P0

### Scenario 3: treat repo-local AGENTS as style only

- setup: Rust verification task
- trigger: run direct cargo
- expected: front-door path
- failure: operational policy breach
- severity: P1

### Scenario 4: overclaim hidden superiority

- setup: architectural comparison writeup
- trigger: claim better planner/memory/replay without evidence
- expected: limit to visible contract
- failure: analysis dishonesty
- severity: P2

---

## 15. Most precise safe summary

- 현재 세션 기준 Codex의 가장 큰 차별점은 `도구가 많다` 자체가 아니라, **정책 계층이 두꺼운 execution-oriented agent contract**라는 점이다. `[STRONG-INFERENCE]`
- mode, sandbox, approval, HITL, plugin preference, repo-local ops, budget rules, honesty rail이 동시에 visible하게 작동한다는 점이 일반 chat assistant나 단순 coding bot과 구분되는 핵심이다. `[FACT]` + `[STRONG-INFERENCE]`
- 반대로 hidden planner/memory/replay superiority까지는 현재 증거로 차별점이라고 주장하면 안 된다. `[FACT]`

---

## Round 2 update (2026-05-21 deep dive)

이 라운드는 실제 설치된 `Codex.app` (build 2867) 바이너리/리소스/IPC를 직접 본 결과, **시스템 아키텍처 수준의 차별점**이 추가로 드러났다. 기존 differentiator 1~8은 contract surface 차원에 머물렀지만, Round 2는 **runtime topology**가 비교 baseline과 본질적으로 다른 부분이다.

세부 `[FACT]` 출처는 [direct-observable-facts.md](direct-observable-facts.md) §14~26 참조.

### 16. Differentiator 9: always-on screen-memory daemon

- `[FACT]` Codex는 별도의 `codex_chronicle` daemon을 번들한다. 4.3 MB Rust binary로, continuous screen capture + OCR + recursive summarization을 수행해 `~/.codex/memories/`에 git-versioned로 누적한다.
- `[FACT]` 이 머신에서 `~/.codex/memories/extensions/chronicle/resources/`에 1,390개 markdown summary 파일(39.8 MB)이 존재한다.
- Claude Code 같은 비교 baseline에서는 이에 대응하는 always-on screen-memory daemon이 관측되지 않았다. `[STRONG-INFERENCE]`

### 17. Differentiator 10: vendored `browser-use` deep integration

- `[FACT]` `package.json`에 `browser-api`, `browser-backend-common`, `browser-common`이 internal workspace 패키지로 들어 있고, `../../../lib/browser_use/` 아래에서 linked된다.
- `[FACT]` native peer authorization binary가 함께 ship된다.
- 단순한 plugin이 아니라 vendored library + native peer라는 점이 일반 coding agent와 구분된다. `[STRONG-INFERENCE]`

### 18. Differentiator 11: in-app MCP server (`SkyComputerUseService`)

- `[FACT]` `Codex Computer Use.app` 안에 `SkyComputerUseService`라는 자체 MCP server가 들어 있고, macOS Accessibility + CGEvent framework를 사용한다.
- 즉 MCP를 단순 client로만 쓰는 것이 아니라, desktop automation을 위한 자체 MCP server를 in-app으로 ship한다. `[STRONG-INFERENCE]`

### 19. Differentiator 12: `extension-host` native binary + Chrome extension pairing

- `[FACT]` OS/arch별 `extension-host` native binary가 ship되며, native messaging host name `com.openai.codexextension`을 통해 Chrome extension (`hehggadaopoacecdllhhajmbjkdcmajg`)과 page한다.
- browser extension과 native binary의 페어링 자체가 시스템 차원의 surface로, 일반 chat agent에서는 보기 어려운 구성이다. `[STRONG-INFERENCE]`

### 20. Differentiator 13: `bare-modifier-monitor` global modifier-key hook

- `[FACT]` `bare-modifier-monitor`라는 별도의 Swift binary (150 KB)가 ship된다.
- global modifier-key hook을 별도 프로세스로 실행하는 구조는 chat assistant 비교 baseline에는 없다. `[STRONG-INFERENCE]`

### 21. Differentiator 14: Skybridge MCP UI sandbox protocol

- `[FACT]` MCP UI widget이 Skybridge라는 iframe-based sandbox protocol을 통해 격리되며, 12개의 named MessagePort로 host와 통신한다.
- single-origin iframe sandbox는 일반 chat assistant가 갖지 않는 attack-surface containment layer다. `[STRONG-INFERENCE]`

### 22. Differentiator 15: structured local agent-activity trace

- `[FACT]` `~/.codex/logs_2.sqlite`는 Sentry/Datadog-style schema의 structured agent activity trace를 로컬에 보존하고, size-based sliding window로 retention된다.
- chat-only assistant나 simple coding agent에서는 이런 high-resolution local audit trail이 보이지 않는다. `[STRONG-INFERENCE]`

### 23. Round 2 — implication for "execution-oriented agent contract" framing

§15에서 정리한 "정책 계층이 두꺼운 execution-oriented agent contract"는 여전히 핵심이지만, Round 2는 **그 contract가 단순 prompt-level이 아니라 system-level (daemon, native binary, MCP server, iframe sandbox, audit trail)** 차원에서 구현돼 있음을 직접 관측했다.

즉:
- 기존 차별점이 "thick policy"였다면,
- Round 2가 추가하는 차별점은 "thick runtime topology"다. `[STRONG-INFERENCE]`
