# RFC: code_mode (tools-as-code) — Codex 5059 흡수

> ## ⚠️ 정정 (HEAD 검증 리뷰 2026-07-13, targeted rail 26 pass/0 fail — 본문 상충 시 이 블록 우선)
> LANDED 판정은 맞으나 4곳 보정:
> - **"no console"은 기술적으로 false.** no-op `console` 객체가 존재(log/info/warn/error/debug 정의되나 no-op, `src/codemode/runtime.ts:574`). 정확한 표현 = **"host-observable console output 없음"**.
> - **in-process QuickJS-WASM ≠ 별도-프로세스 sandbox (보안 동급 아님).** JS capability escape는 잘 막지만 QuickJS/WASM/runtime-binding crash는 **agent host와 같은 failure domain**(freed VM 접근 = uncatchable WASM abort, 코드에도 방어 주석). 별도 host = v1 KILL이 맞되 "중복기능"이 아니라 **containment backlog** — 재검토 조건: (a) code_mode default-ON/untrusted workload, 또는 (b) VM crash가 전체 세션을 죽인 실제 trajectory. 학계·업계는 tools-as-code 지지(CodeAct ≤+20% 성공률, Anthropic code-exec) — 단 효과는 workload-dependent.
> - **D1 store/load = 단순 Map 금지, 계약 필요.** session namespace 강제(cross-session 불가)·key수/길이/value·총 bytes quota·JSON-serializable closed type만·write/read 양쪽 redaction·session close 시 deterministic clear·key provenance+categorical audit·`__proto__`/prototype-pollution/reserved-key 방어. **persistence = prompt-injection persistence 경로**(AgentDojo/OWASP → persistent memory는 일반 캐시보다 고위험 취급).
> - **D2 "pricing/usage seam 재사용" 부정확.** BudgetMeter/pricing은 provider 사후보고 usage를 누적할 뿐 arbitrary cell output을 **사전 tokenization하지 않음**(repo 일반 estimator = chars/4). 정확한 `max_output_tokens`엔 active-model별 **TokenCounterPort 필요** — 없으면 pragma를 reject하거나 기존 `max_output_bytes`로 정직 유지(chars/4를 조용히 token limit으로 쓰면 긴 JSON/코드/CJK에서 under-cap). **`text()/exit()`는 v1 true gap 아님**(return이 exit+single output 대체, multi-item 관측될 때만 추가).
> - **권고 순서:** ON/OFF benchmark → bounded session store/load → (exact tokenizer port 있을 때만) max_output_tokens → process isolation은 production activation gate로 보류.

- **상태**: Design / **implementation not started** (이 RFC 범위 한정). 단, ⚠️ **핵심 커널은 이미 LANDED**(§0 참조) — 이 문서는 그 위의 **델타 + 측정** 설계다.
- **날짜**: 2026-07-13
- **Provenance**: Codex build 5059 / codex-rs 0.144.0-alpha.4. 증거 SSOT = `.extracted_source/codex/_codex-bin-symbols.txt`(축자 인용). 라이선스: Codex는 OpenAI 사유 — **코드 복붙 금지, 패턴/설계만**.

> **North-star 제약**: correctness > feature-count. (a) **중복금지** — 우리 보유물 위 델타만; (b) **measure-first** — Codex의 토큰절감은 **우리 워크로드 기준 미측정**(SWE/TB A/B 없음), "Codex가 하니까"는 흡수 명분 아님; (c) **no code copy, 패턴만**; (d) **default-OFF byte-identical**.

---

## 0. 정정 — anti-dup: candidate-1은 TRUE-GAP이 아니다 (VERIFIED IN REPO)

작업명세 `docs/plans/jul-13-codex-5059-absorption.md`의 후보1은 code_mode를 **"TRUE-GAP / isolate·VM 도구실행 없음 / L effort로 처음부터 구축"**으로 분류한다. **이건 틀렸다.** repo grep이 반증한다 — code_mode 커널은 **jun-6 RFC + ADR-0488로 이미 완전 랜딩**돼 있다.

증거(전부 실파일):

- **격리 런타임 존재**: `src/codemode/runtime.ts` — QuickJS-WASM(`quickjs-emscripten`) 셀. `src/codemode/runtime.ts:5-8`이 이미 "`tools` binding + capped `console`, NO `require`, NO `fetch`, 없음(§6.2)"를 명시. `newContext()`로 per-cell 격리(`runtime.ts:148`), `setMemoryLimit`(`runtime.ts:153`), deadline/abort interrupt(`runtime.ts:154`).
- **`tools` 프록시 존재**: `src/codemode/types.ts:99-113` `surfaceTools` — cell의 `tools.<name>` 에 manifest 도구를 bind. Phase-1 3-tool(`read`/`grep`/`write`) → Phase-2 full registered set. non-identifier 이름은 bracket access.
- **보안 바인딩 존재(핵심)**: `src/agent/codemode-wire.ts#buildCodeCellDispatchPort`(`codemode-wire.ts:63-87`). in-cell `tools.X()` 호출 전부를 **동일 `dispatchTool`(정확히는 `resolveDispatchPort(config)`, `codemode-wire.ts:81`)**로 라우팅 — loop의 live `config`/`permission`/`autoClassifier` 그대로. 즉 "code cell = 승인시스템 관점에서 N개 일반 gated tool_call". `@/codemode`는 biome fence로 `dispatchTool` 자체를 import 못 함(IoC가 경계).
- **GATED 툴 존재**: `src/tool/codemode-tool.ts` — `code_cell`(risk:"exec", always-confirm, no-throw typed result).
- **default-OFF knob 존재**: `src/shared/runtime-config.ts:249` `codeMode: gateOnStrict(env, "QUANTA_CODE_MODE")` + cap knobs(`:253` mem, `:257` timeout, `:261` maxCalls) + `:252` `codeModeOnly`(Codex `code_mode_only` analog). 미설정 시 `code_cell` 미등록 + WASM 모듈 lazy-import로 미인스턴스화 → byte-identical(ADR-0488 "Default posture").
- **테스트 10+ 존재**: `tests/unit/code-mode-hellgate.test.ts`, `code-mode-default-off-hellgate.test.ts`, `code-mode-surface-escape-hellgate.test.ts`, `code-mode-phase2-{full-surface,wire}.test.ts`, `code-mode-memory-fault-hellgate.test.ts`, `tests/integration/code-mode-real-quickjs-wire-hellgate.test.ts`, `code-mode-full-surface-e2e.test.ts` 등.
- **ADR**: `docs/decisions/0488-code-mode-js-runtime.md`(Accepted, 2026-06-07). 이전 RFC `docs/plans/jun-6-code-mode.md`(Phase 1+2+3 LIVE).

**작업명세가 재사용 seam으로 든 것들도 정정한다**: 그 문서는 병렬 tool_call(`src/llm/openai-responses-wire.ts`, `src/llm/adapters/openai.ts`)만 언급하며 "한 턴 N tool_call ≠ result-hiding 합성"이라는 핵심 차이를 지적했는데 — **맞다, 그 차이가 정확히 우리가 이미 code_cell로 메운 갭이다.** 참고로 `openai-responses-wire.ts:387`은 `parallel_tool_calls: false`라 병렬 tool_call조차 현재 OFF다. 도구 디스패치 seam(`src/agent/streaming-dispatch.ts`, `src/agent/effect-channel.ts`)은 여전히 SSOT이며 `codemode-wire`가 그 위 `resolveDispatchPort`로 재진입하니 **재구현 없음**이 이미 성립.

**결론**: candidate-1의 스파이크·seam·게이팅·red-on-injection은 **전부 이미 존재**. 이 RFC는 처음부터 짓는 게 아니라 (1) **Codex-5059가 우리 랜딩본 대비 추가로 갖는 델타를 특정**하고, (2) **미측정 상태를 측정 게이트로 닫는다**. 짓기 전에 이미 있는 걸 다시 짓는 게 이 저장소 최대 안티패턴(중복금지 하드룰)이다.

---

## 1. Codex 5059 ↔ 우리 랜딩본 델타 (VERIFIED)

Codex `exec` 계약(축자, `_codex-bin-symbols.txt:44274-44293`):

- "Evaluates the provided JavaScript code in a **fresh V8 isolate** as an async module."
- "All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`."
- "Runs raw JavaScript -- **no Node, no file system, no network access, no console.**"
- "Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences."
- first-line pragma `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- helpers: `exit()`, `text(value)`, `image()`, `store(key, value)`, `load(key)`.

Codex의 격리 = **별도 프로세스** `codex-code-mode-host --jitless`(`_codex-bin-symbols.txt:44257`, `CODEX_CODE_MODE_HOST_PATH`) + IPC 프로토콜(`code-mode-protocol/src/host/codec.rs`, frame limit, `:7243-7384`) + **cell-actor yield/resume**(`code-mode/src/cell_actor/`, `:7205-7302`, `remote_session` 재개·재사용).

| 축 | Codex 5059 | 우리 랜딩본 | 델타? |
|---|---|---|---|
| 격리 | 별도 프로세스 V8 isolate, `--jitless` | in-process QuickJS-WASM(`runtime.ts`) | 아니오(둘 다 "no Node/fs/net/console" 달성; 우리 게 더 가벼움) |
| `tools` 프록시 | global `tools.X()` | `surfaceTools` bind(`types.ts:99`) | 아니오 |
| 보안(게이트 통과) | host가 승인 라우팅 | `dispatchTool` 재진입(`codemode-wire.ts:81`) | 아니오 |
| default-OFF | — | `QUANTA_CODE_MODE`(`runtime-config.ts:249`) | 아니오 |
| 리소스 캡 | frame/토큰 | mem/timeout/maxCalls/outputCap(`types.ts:51-62`) | 아니오 |
| **`store()/load()` 크로스-exec 세션 영속** | 있음 | **없음**(grep=0) | **예 — 델타 D1** |
| **`max_output_tokens` 프래그마(토큰예산)** | 있음 | outputCap은 **bytes**지 토큰 아님(`types.ts:59`) | **예 — 델타 D2** |
| **`text()`/`exit()` 산출 helper** | 있음 | 반환값 JSON-stringify만 | **예(약함) — 델타 D3** |
| **cell-actor yield/resume(`yield_time_ms`)** | 있음(장기 스크립트 부분산출·재개) | **없음**(동기 단발) | **예 — 델타 D4(별도 프로세스+IPC 필요, 무거움)** |
| 별도 host 프로세스(44MB) | 있음 | 없음(in-process) | 델타지만 **의도적 비목표**(§4) |

즉 진짜 흡수각은 **D1~D4 넷**이지 커널 전체가 아니다.

---

## 2. 제안 (phased) — 델타만, 우리 seam 위

작업명세의 3단 스파이크는 **이미 통과된 상태**(격리 실행기=QuickJS-WASM 선정 완료, ADR-0488)이므로 되풀이하지 않는다. 대신 델타를 단계화한다.

### P0 [S] — 측정 하네스 먼저 (착수 전제)
- **아무 델타보다 먼저** default-OFF A/B 레일을 세운다. code_mode ON/OFF로 **tokens-per-task · roundtrip 수 · tool-heavy task 성공률(SWE/TB picks)** 을 뽑는다.
- 근거: 커널이 이미 있으니 "델타를 더 짓기 전에" 커널 자체가 우리 워크로드에서 값을 내는지부터 실측. 안 나오면 D1~D4 전부 스톱(measure-first 하드룰). 이게 이 RFC의 실질 게이트다.

### P1 [S] — D1: `store()/load()` 세션 영속
- 신규 helper 2개를 셀 global에 bind: `store(key, value)` / `load(key)` — 같은 세션의 후속 `code_cell` 호출 간 serializable 값 보존. Codex 계약과 동일 시맨틱.
- **재구현 금지**: 기존 `RunCodeCellOptions`(`types.ts:99`)에 injected `sessionStore: Map`-port 하나 추가, `runtime.ts`의 global 설치부에서 bind. 스토어 소유·budget은 **loop 세션**(host)이 갖고 셀은 port만 봄 — `dispatch` port와 동일 IoC 패턴.
- no-leak: 저장값은 secret redaction 대상(기존 `@/security` 초크포인트 재사용). 스토어 내용은 telemetry에 안 감(categorical만).

### P2 [S] — D2: `max_output_tokens` 프래그마
- first-line pragma `// @exec: {"max_output_tokens": N}` 파싱 → 현 `outputCap`(bytes)을 **토큰예산 우선**으로 승격(bytes cap은 하드 상한으로 유지). tokenizer는 우리 기존 카운터 재사용(`pricing`/usage seam), 자작 추정 금지.
- ⚠️ `yield_time_ms`는 프래그마 스키마엔 있지만 **P2에서 파싱만 하고 no-op**(D4 없이는 무의미) — inert 필드로 정직 라벨, 미구현 forward-seam.

### P3 [S] — D3: `text()`/`exit()` 산출 helper
- `text(v)` = 산출 아이템 append(비문자열 JSON-stringify), `exit()` = top-level early success return. 반환값-only 대비 다중 텍스트 축적을 허용. `image()`/`generatedImage()`는 **비목표**(우리 tool_result 이미지 경로와 중복·저ROI, 기록만).

### KILL / 비착수
- **D4(cell-actor yield/resume + `codex-code-mode-host` IPC)**: v1 **제외**. 별도 프로세스 + IPC codec + 재개 액터가 필요(44MB급, Codex `code-mode/src/{cell_actor,remote_session,remote_session/connection/*}`). 동기 단발 exec로 충분하며, 장기 스크립트 수요가 **실측될 때만** 별도 RFC. 지금 짓는 건 over-engineering.

---

## 3. 보안 (critical) — 이미 성립, 델타가 깨지 않게 핀

code_mode의 make-or-break은 "model-authored 코드가 승인우회가 되면 안 됨"이고 **이미 구조적으로 닫혀 있다**: `tools` 프록시의 모든 호출이 `codemode-wire.ts:81`의 `resolveDispatchPort(config)`로 재진입 → admissibility gate / HARD_DENY / plan-mode / redaction 전부 발화(`codemode-wire.ts` 주석 §6.1, ADR-0488 "Fail-closed"). `autoClassifier` 미주입이라 in-cell read-only도 auto-pass 안 함(strictly-more-restrictive). tool 이름은 `surfaceTools`가 loop 노출분으로 상한(`types.ts:110-113`) — 셀이 자기 표면 못 넓힘. 이 불변식은 `tests/unit/code-mode-surface-escape-hellgate.test.ts`로 이미 red-on-injection.

**이 RFC의 보안 의무 = 델타가 그 경계를 우회 안 하게 핀**:
- D1 `store/load`는 **dispatch가 아님** — 파일/네트워크에 못 닿고 세션 in-memory Map만. red-on-injection: `store`에 넘긴 값이 어떤 tool도 우회해 side-effect 내면 RED.
- D2/D3 helper는 산출 축적일 뿐 host reach 0. 어떤 helper도 `dispatchTool` 외 경로로 host에 못 닿음을 hellgate로 핀(기존 surface-escape 테스트 확장).
- **불변식**: 셀의 유일한 host reach는 여전히 `CodeCellDispatchPort` 하나. 델타 helper는 전부 pure/session-local. 이걸 어기는 helper 추가면 그 자체가 설계 반려.

---

## 4. What NOT to do (명시적 비목표)

- **별도 host 프로세스 + IPC(44MB급) 짓지 마라.** Codex의 `codex-code-mode-host --jitless` + `code-mode-protocol` codec + `remote_session/connection/driver`는 in-process QuickJS-WASM으로 이미 대체됨. 우리 격리는 "no Node/fs/net/console"을 프로세스 분리 없이 달성(`runtime.ts:5-8`).
- **cell-actor yield/resume 짓지 마라(v1).** 실측 수요 전엔 no.
- **디스패치 재구현 금지.** `streaming-dispatch`/`effect-channel`/`resolveDispatchPort`가 SSOT. 델타는 helper·store port만 추가, dispatch 경로 불변.
- **커널 재구축 금지.** `src/codemode/*`·`codemode-wire`·`codemode-tool`은 이미 있다. 이걸 "새로 만든다"고 쓴 어떤 계획도 anti-dup 위반.
- **토큰 추정 자작 금지.** D2는 기존 usage/pricing 카운터 재사용.

---

## 5. 측정 게이트 — 랜딩 조건

default-OFF A/B, 우리 워크로드 실측 없이 **랜딩 금지**(measure-first, 예외 아님):

| 지표 | 방법 | 통과선 |
|---|---|---|
| tokens-per-task | code_mode ON/OFF, SWE/TB picks | ON이 유의하게 ↓(멀티스텝 task) |
| roundtrip 수 | 턴 카운트 | N-tool 시퀀스가 1턴으로 접힘 |
| tool-heavy 성공률 | SWE f2p / TB reward | 무회귀(우선) → 개선(이상적) |
| 보안 | surface-escape hellgate + 델타 red-on-injection | 전부 RED-on-injection |

효능 없거나 회귀면 델타 **삭제**(default-OFF라 byte-identical 원복). Codex 효능은 우리 워크로드 미측정이므로 **측정이 유일 명분**.

## 6. effort / risk / KILL

| 아이템 | effort | risk | KILL 기준 |
|---|---|---|---|
| P0 측정 하네스 | S | 낮음 | — (전제) |
| **커널 자체(기존)** | 0(있음) | — | **P0 A/B가 우리 워크로드서 토큰/성공 무효 → 델타 전부 스톱** |
| D1 store/load | S | 낮음(pure session) | store가 dispatch 우회 side-effect → 설계 반려 |
| D2 max_output_tokens | S | 낮음 | 토큰 추정이 usage 카운터로 안 잡힘 → bytes cap 유지·D2 드롭 |
| D3 text/exit | S | 낮음 | 반환값-only 대비 관측 이득 0 → 드롭 |
| D4 yield/resume + host IPC | L | 높음 | **기본 KILL** — 장기 스크립트 실측 수요 전 착수 금지 |

**전역 KILL 게이트**: P0에서 code_mode 커널이 우리 SWE/TB에서 토큰·roundtrip·성공 어느 것도 못 움직이면, 델타 D1~D4는 물론 code_mode 활성화 자체를 backlog로 내린다(커널은 default-OFF로 잔존, 삭제 안 함).

---

## 요약 (3줄)

- code_mode(tools-as-code) 커널은 **이미 랜딩됨**(ADR-0488, `src/codemode/*` + `codemode-wire.ts:63` 보안바인딩 + `QUANTA_CODE_MODE` default-OFF + 테스트 10+) — 작업명세의 "TRUE-GAP" 분류는 anti-dup 오류로 정정한다.
- Codex 5059 실델타는 **D1 store/load · D2 max_output_tokens · D3 text/exit(약함) · D4 cell-actor yield/resume(무거움, v1 KILL)** 넷뿐이며, 전부 우리 `dispatch`/usage seam 위 얇은 추가로 짓고 dispatch·host-process는 재구현 안 한다.
- 실질 게이트는 **P0 측정 하네스** — 이미 있는 커널이 우리 SWE/TB에서 토큰·roundtrip·성공을 실제로 움직이는지부터 A/B로 확인하고, 안 움직이면 델타 전부 스톱(measure-first).
