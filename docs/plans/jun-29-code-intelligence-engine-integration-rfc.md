# jun-29 — Code-Intelligence Engine 통합 RFC (semantica-codegraph를 swappable 백엔드로)

> 날짜: 2026-06-29
> 상태: RFC (구현 전). 추상화 설계 + 단계 + 적대 리스크.
> 엔진 분석 SSOT: [docs/analysis/semantica-codegraph.md](../analysis/semantica-codegraph.md)
> seam 맵: 이 문서 §2 (Explore 검증, file:line 앵커)
> 선행 RFC: [jun-29-repro-gen-grounding-rfc.md](jun-29-repro-gen-grounding-rfc.md) (이 포트의 첫 소비처)

## 0. 한 줄

semantica-codegraph(멀티랭 정적분석+코드그래프+MCP 런타임, 6.3M LOC Rust)를 **quanta가 소유한 `CodeIntelligencePort` 추상화 뒤의 한 어댑터**로 붙인다. quanta는 MCP **클라이언트**로 `cgr/query_quanta`(SearchCode/ExpandNeighbors/TraceDataflow/FetchProof) 소비. **엔진은 교체 가능**(semantica든, 그 retriever 엔진이든, 다른 분석기든 어댑터만 갈아끼움). default-OFF, measure-first, fail-closed.

## 1. 왜 추상화부터 (엔진 직접 호출 금지)

분석 문서가 못박은 2가지 — (a) **실세계 precision 미측정**, (b) **committed baseline stale**(mar-13 포크 이전). 즉 "semantica가 localization 올린다"는 **검증된 사실이 아니라 가설**. 따라서:
- 소비처(repro-gen/localize/acceptance)는 **semantica를 직접 알면 안 됨** — quanta 도메인 언어의 포트만 봄.
- semantica는 그 포트의 한 어댑터. 안 좋으면 lexical 어댑터로 즉시 회귀. measure로 갈림.
- 이게 [[no-heuristics-only-validated]] + [[no-inference-from-insufficient-evidence]] 준수 형태.

## 2. quanta쪽 배선 seam (Explore 검증, file:line)

| seam | 앵커 | 상태 |
|---|---|---|
| MCP 클라이언트 custom 메서드 | `src/mcp/client.ts:404` `requestRaw(method,params)` | ✅ 아웃바운드 `cgr/*` 제약 없음 |
| MCP 서버 설정 | `src/mcp/types.ts:12` `McpServerConfig`(command[]/url) + `.mcp.json` | ✅ 존재 |
| localize 주입포트 | `src/runner/batch/eval/driver.ts:1362` `deps.localize ?? agentlessLocalize` | ✅ 포트 이미 있음 |
| 포트패턴 템플릿 | acceptance: `acceptance-selector.ts:39`(factory)+`knobs-bench.ts`(posture)+`bench-repro.ts`(knob) | ✅ 복제대상 |
| repro-gen exemplar 포트 | `generate.ts` `buildReproTestPrompt` + grounding RFC `retrieveExemplarSkeletons` | ⬜ 미구현(선행 RFC) |
| **cassette 녹음 갭** | `src/llm/replay/recording-llm.ts:40` LLM stream만 녹음, **MCP `requestRaw` 결과 미녹음** | 🔴 **HIGH 블로커** |

## 3. 추상화 — `CodeIntelligencePort` (quanta 도메인 인터페이스)

semantica 표면이 아니라 **quanta가 실제 필요한 것**만:

```ts
interface CodeIntelligencePort {
  // repro-gen exemplar + acceptance regression-set 용
  relatedTests(symbols: IssueSymbol[], repo: RepoRef): Promise<TestRef[]>
  // localize phase 용 (symptom→cause)
  localize(issue: string, repo: RepoRef): Promise<RankedLoc[]>
  // (Phase 2) 증거 — dataflow 경로
  traceDataflow?(from: Loc, to: Loc): Promise<DataflowPath | null>
  readonly backend: "semantica" | "lexical" | "null"
}
```

**어댑터 3개** (전략):
1. `null` — off. 모든 op이 빈결과. **default**. 소비처 byte-identical(=현행).
2. `lexical` — 현행 부품 래핑(LSP nav + BM25 localize + `impacted-test-discovery`). semantica 없을 때 **fail-closed 폴백**.
3. `semantica-mcp` — `requestRaw("cgr/query_quanta", {op})` 호출:
   - `relatedTests` → SearchCode(structural/call-graph) + ExpandNeighbors
   - `localize` → TraceDataflow + call-graph reachability
   - `traceDataflow` → TraceDataflow / FetchProof

**선택**: knob `QUANTA_CODE_INTEL=off|lexical|semantica` (default off). posture 비트 1개. factory가 어댑터 instance 빌드(acceptance 패턴 그대로).

## 4. 소비처 (포트 1개, 소비처 3 — 점진 배선, 각각 A/B)

| 소비처 | 포트 op | seam | 효과 가설 |
|---|---|---|---|
| **repro-gen exemplar**(grounding RFC) | `relatedTests`→skeleton-strip | `generate.ts` `retrieveExemplarSkeletons` | exec_failed 40%↓ |
| **localize phase** | `localize` 신호 추가 | `driver.ts:1362` `deps.localize` 합성 | right-place-wrong-edit↓ |
| **acceptance dual-guard regression-set** | `relatedTests`→실행할 테스트 | `makeAcceptanceSelectCandidates` `regressionSet` | dual-guard FEED(현재 미공급) |

각 소비처는 **독립 knob + 독립 A/B**. 포트는 공유, 배선은 하나씩 켜며 측정.

## 5. 횡단 불변식 (전부 강제)

1. **default-OFF byte-identical** — `QUANTA_CODE_INTEL=off`면 null 어댑터, 소비처 현행과 바이트동일([[jun-24-adr0296-auto-background-and-default-off-invariant]] 하드룰).
2. **언어 게이트** — semantica는 Python/TS/JS 풀깊이, **Go 약함·C++ 없음**(분석 표). task 언어가 약한 레인이면 **자동 lexical 폴백**(capability-blind 금지, [[jun-21-strict-lsp-gate-flake-and-oom-retraction]] task-relevant 게이팅 교훈).
3. **fail-closed 폴백** — semantica 데몬 down/timeout/에러 → lexical 어댑터로 degrade, **벤치 hard-fail 금지**. 폴백 사실은 telemetry로 surface([[feedback-proactive-failure-alert]]).
4. **레이턴시/비용 예산** — semantica 무거움(Z3 빌드 분단위, pta-precise ~134s/2files, **warm-root pool 미구현**). → 데몬 **persistent serve-mcp**(콜드 빌드 1회), per-call **timeout→폴백**, 결과 **캐시**. 핫패스에 uncached 금지.
5. **DETERMINISM (블로커 선결)** — §6.
6. **measure-first** — §7 Phase 0 게이트 통과 전 default 승격 금지. "semantica가 올린다" 주장은 측정 후에만([[no-inference-from-insufficient-evidence]]).
7. **engagement 증명** — "wired≠engages theater" 방지([[jun-19-repro-vote-and-theater-class]]): 포트가 실제 requestRaw 호출+결과 흐름 핀하는 HARD 테스트.
8. **stale baseline 재측정** — semantica 자체 게이트(OWASP 등)를 **HEAD에 재실행** 후에만 신뢰(분석 문서 methodology 경고).

## 6. 🔴 DETERMINISM 블로커 — `McpCallRecorder` (선결 필수)

**문제**(Explore HIGH): `recording-llm.ts`는 LLM stream만 녹음. **MCP `requestRaw`/`callTool` 결과는 ReplayStore에 안 들어감.** → 외부 분석 + cassette replay/spot-resume 같이 쓰면 **replay가 비결정적으로 깨짐**(semantica가 매번 다른 응답/없을 수도).

**해결**: `McpCallRecorder` 포트 — `requestRaw` 래핑, canonical params 해시 키로 결과를 ReplayStore에 append, replay 시 재생. [[jun-27-bench-spot-resume]]의 canonicalizer(휘발성 마스킹) 재사용. **이걸 짓기 전엔 어떤 bench-replay 경로에도 semantica 배선 금지.**

## 7. 단계 (Phase 0가 전체 게이트)

**Phase 0 — 측정 스파이크 (GO/NO-GO 게이트)**
- semantica `codeagent-runtime serve-mcp` 빌드(parser-py/ts/js). 자체 OWASP 게이트 HEAD 재실행(stale 확인).
- `cgr/query_quanta`(TraceDataflow/SearchCode)를 **오프라인 ~10-20 SWE-bench 인스턴스**에 직접 던져 **localization recall@k vs 현행 lexical** 측정.
- **결정**: 측정된 uplift 있을 때만 Phase 1+. 없으면 RFC 보류(엔진 탓 아니라 ROI 게이트).

**Phase 1 — 포트 추상화 + 어댑터 (inert)**
- `CodeIntelligencePort` + null/lexical/semantica-mcp 어댑터. knob `QUANTA_CODE_INTEL` default-off. 순수/inert(소비처 미배선).

**Phase 2 — McpCallRecorder (determinism 선결)** — §6.

**Phase 3 — 소비처 배선 (하나씩, 각 A/B)**
- 3a repro-gen exemplar(grounding RFC 구현 후) → exec_failed율 A/B(A1 telemetry 공짜).
- 3b localize phase → recall@k / resolved A/B.
- 3c acceptance regression-set FEED.

**Phase 4 — 하드닝** — 언어게이트 전수, 폴백 카오스(데몬 kill→degrade 증명), warm 데몬 수명/회전.

## 8. 적대 리스크 (3-round)

**R1 (통합 현실성)**: semantica는 별도 6.3M LOC Rust 레포·무거운 Z3 빌드. → **vendor 금지**, serve-mcp 데몬 외부 프로세스로만. 빌드 실패/부재 시 lexical 폴백(불변식 3). cgr/* custom 메서드 = requestRaw로 OK(블로커 아님, Explore 확인).

**R2 (효능 미검증 over-claim)**: 분석이 precision 미측정·baseline stale 명시. → Phase 0 측정게이트가 default 승격을 막음. 소비처별 독립 A/B. "wired=works" 금지(불변식 6,7). Go 레인 약함 → 언어게이트로 측정오염 차단.

**R3 (결정성/측정구멍)**: MCP 결과 미녹음 = cassette/spot-resume 깨짐(🔴블로커). → McpCallRecorder 선결(Phase 2가 Phase 3 앞). semantica 비결정 응답은 canonicalizer로 마스킹. 폴백 발생을 telemetry surface 안 하면 "semantica가 한 일"로 오귀속 → 폴백 카운터 계측(불변식 3).

## 9. 비스코프
- semantica의 agent-runtime(ApplyFix/RunTests/Bash) 흡수 = 별개(우리가 루프 소유; 분석 §201 hybrid 결정은 후속).
- semantica 자체 개선/Go 레인 uplift = semantica 레포 일.
- 이 RFC = **포트 추상화 + MCP 소비 + 측정게이트**. resolved 상승 주장 = Phase 0/3 측정 후에만.
