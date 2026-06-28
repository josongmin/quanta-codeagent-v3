# jun-29 — Code-Intelligence Engine 통합 RFC v2 (semantica-codegraph를 swappable 백엔드로)

> 날짜: 2026-06-29 · 상태: RFC v2 (3 적대어딧 + 1 객관어딧 반영) · 구현 전.
> 엔진 분석 SSOT: [docs/analysis/semantica-codegraph.md](../analysis/semantica-codegraph.md)
> 선행: [jun-29-repro-gen-grounding-rfc.md](jun-29-repro-gen-grounding-rfc.md) (첫 소비처)
> v1→v2 변경: §11 어딧 changelog. CRITICAL 3 / HIGH 9 / MED 6 반영.

## 0. 한 줄

semantica-codegraph(멀티랭 정적분석+코드그래프+MCP, 6.3M LOC Rust)를 **quanta 소유 `CodeIntelligencePort` 추상화 뒤의 한 어댑터**로 붙인다. quanta는 MCP **클라이언트**(`requestRaw`로 `cgr/*`). **엔진 교체가능**, default-OFF, **measure-first(미검증 가설로 취급)**, fail-closed.

## 1. 왜 추상화 + measure-first부터

분석 문서가 못박음 — **실세계 precision 미측정 + baseline stale(mar-13 포크 이전)**. "semantica가 localization 올린다"는 **검증된 사실 아님, 가설**. 따라서 소비처는 semantica를 모르고(포트만), 안 좋으면 lexical 즉시 회귀. [[no-heuristics-only-validated]] [[no-inference-from-insufficient-evidence]] 준수.

## 2. quanta쪽 seam (Explore 검증, file:line)

| seam | 앵커 | 상태 |
|---|---|---|
| MCP custom 메서드 아웃바운드 | `src/mcp/client.ts:404` `requestRaw` (method allow-list 없음, `request`로 raw 전송, `Promise<unknown>`) | ✅ `cgr/*` 가능, **codec는 어댑터 소유** |
| 🟡 stdio framing | client.ts:89 docstring "newline-delimited" vs 분석문서 semantica "Content-Length" | **Phase 0 1번 체크**; 불일치면 `url`/HTTP carrier(types.ts:26)로 우회 |
| MCP 서버 설정 | `src/mcp/types.ts:12` `McpServerConfig`(command[]/url/env, oauth default-off) | ✅ |
| localize 주입포트 | `src/runner/batch/eval/driver.ts:1362` `deps.localize ?? agentlessLocalize` | ✅ |
| acceptance regression FEED | `driver.ts:3220` `makeAcceptanceSelectCandidates(...regressionSet?)` | ✅ 슬롯 존재(미공급) |
| 포트패턴 템플릿 | acceptance: factory+posture+knob | ✅ 복제 |
| repro-gen exemplar | `generate.ts` `buildReproTestPrompt(issue,mwe,kind)` (exemplar param 없음) | ⬜ 선행 RFC |
| 🔴 cassette MCP 녹음 | `recording-llm.ts:40` LLM stream만; `RecordedInteraction`=StreamInput-shaped; MCP 미녹음 | **§6 블로커** |
| gold=eval-only 경계 | `driver.ts:3336` gold "never reaches src/agent" | 누수 fence 기준선 |

## 3. 추상화 — `CodeIntelligencePort` (quanta 도메인)

```ts
type CiOutcome = "ok" | "empty" | "error" | "timeout" | "fallback-lexical"   // R3#3
interface CiResult<T> { outcome: CiOutcome; backend: "semantica"|"lexical"|"null";
  treeOid: string; results: T; evidence?: ProofRef }   // R3#1b treeOid, OBJ#2 evidence

interface CodeIntelligencePort {
  relatedTests(symbols: IssueSymbol[], repo: RepoRef, opts?: {changedDiff?: string}): Promise<CiResult<TestRef[]>>
  localize(issue: string, repo: RepoRef): Promise<CiResult<RankedLoc[]>>
  traceDataflow?(from: Loc, to: Loc): Promise<CiResult<DataflowPath|null>>
}
```
- **discriminated outcome**(R3#3): consumer는 `empty`(신뢰)와 `error/timeout/fallback`(degraded, 신호로 안 씀)을 **구분**. bare 배열 금지(silent-empty=false-green 방지, [[jun-20-leaderboard-throttle-miss-confound]]).
- **treeOid 필수**(R3#1b): 결과는 질의시점 트리에 종속. 키·캐시·replay 모두 treeOid 포함.
- **evidence 승격**(OBJ#2): FetchProof(zero-FP proof DAG=측정된 최희소강점)를 별도 op로 묻지 말고 결과의 typed 필드로 — oracle-adequacy rail이 proof-backed 신호 요청 가능.
- **change-impact**(OBJ#1): regression-set용 `relatedTests`는 optional `changedDiff` 받아 patch→affected-tests(symptom→tests보다 정밀).

**어댑터 3**: `null`(off, default, 소비처 byte-identical) / `lexical`(현행 LSP+BM25+impacted-discovery, **fail-closed 폴백**) / `semantica-mcp`(`requestRaw("cgr/query_quanta",…)`). knob `QUANTA_CODE_INTEL=off|lexical|semantica`.

⚠️ **§3의 cgr 서브op 요청/응답 스키마는 `[미검증-가설]`**(R1#1): 분석문서는 op 이름만(`query_quanta → SearchCode/ExpandNeighbors/TraceDataflow/FetchProof`), wire 스키마·`{op}` 봉투는 출처 없음. **Phase 0서 실 `tools/list`+round-trip transcript 떠서 fixture로 핀한 뒤 포트 shape 동결**. 동결 전 어댑터 코드 금지.

## 4. 소비처 (포트 1, 소비처 3 — 점진, 각 A/B with control)

| 소비처 | op | seam | 효과 **가설(측정 전·미검증)** |
|---|---|---|---|
| repro-gen exemplar | `relatedTests`→skeleton-strip | `retrieveExemplarSkeletons` | exec_failed **MIGHT↓**(target 40%, 미측정) |
| localize phase | `localize` 신호 머지 | `driver.ts:1362` | right-place-wrong-edit **MIGHT↓** |
| acceptance regression FEED | `relatedTests(changedDiff)` | `driver.ts:3220` `regressionSet` | dual-guard FEED 활성 |

**over-claim 금지**(R2#8): 위 셀은 **가설**. "40%"는 **target**으로만, bare 결과수치 금지.

**A/B control 규율**(R2#4,5 — 소비처 상호의존):
- 3a·3c 둘 다 `relatedTests` 호출, 3b가 3a의 input(issueSymbols→impacted-discovery) 변경 → **factorial**: 한 소비처 A/B 중 나머지 둘은 `null` 고정(불변식).
- 3a exec_failed: **same instances/K/seed/temp**, **per-instance paired delta**(pooled rate 금지, selection-effect 차단), + reproduced율 무저하·no_reproduced 무증가 동반 보고(R2#5).
- 최종 all-three-on은 **독립 arm으로 재측정**(포트 공유라 델타 비가산).

**cross-RFC 소유권**(OBJ#3): `retrieveExemplarSkeletons`는 **`CodeIntelligencePort.relatedTests`의 thin caller**(skeleton-strip은 consumer-side). grounding RFC §5의 "독립 retriever 어댑터 교체" framing은 이 RFC가 **supersede** — swap-point는 `CodeIntelligencePort` 하나.

## 5. 횡단 불변식 (전부 강제)

1. **default-OFF byte-identical** — off=null 어댑터, 현행 바이트동일([[jun-24-adr0296-auto-background-and-default-off-invariant]]).
2. **언어 게이트, gold-free 시그널**(R1#4 — CRITICAL): semantica는 Py/TS/JS 풀깊이·**Go약함·C++없음**. 약한 레인=자동 lexical. **언어판정은 repo-name 맵(`corpus/repo-version-specs.ts`) 또는 file-tree extension census** — **gold-patch 파생 금지**(`driver.ts:5107`식 gold-derived=answer-key 누수, [[no-answer-key-regex-heuristics]]). 불변식: 게이트는 inference-time에 gold 없이 계산가능해야.
3. **fail-closed 폴백 + 구분계측**(R3#3): down/timeout/error→lexical degrade, hard-fail 금지. **empty≠error≠timeout≠fallback** 각각 telemetry 카운트. **fallback-rate 예산**(OBJ#7): 임계 초과(예 >30%)면 arm을 flag/disable(lexical-vs-lexical confound 차단, [[jun-20-leaderboard-throttle-miss-confound]]).
4. **레이턴시/비용 예산**: Z3 빌드 분단위·pta-precise ~134s/2files·**warm-pool 미구현** → persistent 데몬(§7 배치) + per-call timeout→폴백(단 R3#2 결정성 처리 필수) + treeOid 캐시(§6). **+ cost/token 회계**(OBJ#1): MCP 결과가 프롬프트에 주입=LLM 토큰 spend → 기존 `emitUsage` SSOT로 라우팅([[jun-28-cost-cap-activation-and-2-system-reconcile]]).
5. **determinism** — §6.
6. **measure-first** — §7 Phase 0 게이트 전 default 승격 금지.
7. **engagement 증명**(R3#3): "wired≠engages" 방지 — HARD 테스트가 known-positive fixture서 **non-empty 실결과** 단언(requestRaw 호출됨만으론 불충분).
8. **build/quality 핀**(R1#5, OBJ#6): semantica **git SHA + cargo feature set**을 어댑터 telemetry에 기록([[feedback-record-winning-config]]); cgr 응답 스키마 **버전 핀 + contract 테스트**(외부 fast-moving 레포 drift 방어). 자체 게이트 **HEAD 재실행은 Phase 0 hard 선결**(stale 0.47 비교 금지).
9. **read-only 표면**(OBJ): `cgr/query_quanta`만 호출, mutation op(ApplyFix/Bash/RunTests) **절대 미호출**(우리가 루프 소유).

## 6. 🔴 DETERMINISM — `McpCallRecorder` (Phase 3 앞 선결)

**문제**(R3 확정): `RecordedInteraction`(`replay/types.ts:22`)은 `StreamInput`+`StreamEvent[]` 하드타입, 해시도 StreamInput 필드만. MCP 호출은 둘 다 아님 → **ReplayStore 드롭인 불가**.

**설계**:
1. **별도 line 스키마**(R3#1a): `McpReplayRecord { key, method, canonicalParams, treeOid, outcome, result }`. JSONL substrate + `stableStringify`(jsonl-store.ts export)만 재사용, `RecordedInteraction`/matcher는 **재사용 안 함**.
2. **🔴 키 = `hash(canonicalParams) + treeOid`**(R3#1b CRITICAL): CI 질의는 `(params, 질의시점 트리)`의 순수함수. 수리루프서 패치로 트리 변함 → params-only 키는 pre-patch 결과를 stale 반환(=confidently-wrong, miss 아님). treeOid=`git rev-parse HEAD`(dirty sandbox면 `git write-tree`). LLM replay가 이 문제 없는 건 파일내용이 프롬프트→해시로 새기 때문; MCP 결과엔 그 leak 없음 → **treeOid는 마스킹 대상 아니라 키에 ADD하는 load-bearing 필드**.
3. **timeout = first-class outcome**(R3#2): 녹음에 `outcome:"timeout"` 저장, replay는 **타이머 재실행 없이 같은 분기 재현**(`recording-llm.ts:92` partial/error first-class 선례 복제). 비결정 degrade가 replay 깨거나 A/B에 lexical 섞는 것 차단.
4. **단일 캐시 SSOT**(R3#5 CRITICAL): in-run 캐시도 **같은 `hash(params)+treeOid` 키**(recorder와 1함수 공유). per-instance/per-process 캐시 금지(패치 후 stale). 패치=새 treeOid=자연 miss=fresh 질의.

**이 4개 완성 전 어떤 bench-replay/spot-resume 경로에도 semantica 배선 금지.** canonicalizer([[jun-27-bench-spot-resume]])는 휘발성 마스킹용으로 재사용(필요), but treeOid 키 추가가 핵심(불충분→필요충분).

## 7. 단계 (Phase −1·0가 cheap-kill + 게이트)

**Phase −1 — 마이크로 프로브 (가장 싼 kill)**(R2#7): semantica 자체 localization/dataflow를 **in-process FluentSDK**(MCP·recorder·배선 0)로 **5 인스턴스**에 돌려, ranked 파일이 gold 파일을 grep보다 자주 포함하나 **eyeball**. dud면 빌드값만 치르고 RFC 폐기.

**Phase 0 — 측정 게이트 (GO/NO-GO, 정량)**:
- 선결: serve-mcp 빌드 + **자체 OWASP 게이트 HEAD 재실행**(stale 확인, 불변식8) + **실 transcript로 cgr 스키마 핀**(§3) + **stdio framing 체크**(§2).
- **recall@k 오라클 = gold-touched 파일, SCORER-SIDE ONLY**(R2#1 CRITICAL): `gradeBreakdown`/report 층에서만 계산, **fence 테스트가 gold file-set이 `localize`·candidate population·에이전트 replay cassette에 안 들어감 단언**(grounding RFC R1 fence + `withCandidatePatch` 격리 재사용). §7에 명문: "recall@k oracle=gold-touched, scorer-side, src/agent 도달불가 단언".
- **n ≥ 50**(R2#2, Verified 슬라이스), **per-instance bootstrap CI**.
- **임계 정의**(R2#3): GO = recall@10 **CI 하한 ≥ lexical 점추정 +5pp** AND **어느 언어 stratum도 lexical CI 미만 회귀 없음**. 미달=NO-GO/hold. primary metric=recall@10(고정).
- **언어 stratify**(R2#6): A/B는 **언어별** 보고·게이트. 폴백 인스턴스는 semantica arm 분자서 제외. GO는 **full-depth 레인(py/ts/js) stratum에서만** 평가.
- **op 정렬**(OBJ#4): Phase 0가 `localize` recall만 재고 3a는 `relatedTests` ship → **Phase 0에 `relatedTests` 측정도 포함**하거나, free A1 readout 있는 exemplar A/B를 첫 롤아웃으로.

**Phase 1 — 포트+어댑터(inert)**: `CodeIntelligencePort`+null/lexical/semantica-mcp, knob default-off, 순수.
**Phase 2 — McpCallRecorder**(§6, determinism 선결).
**Phase 3 — 소비처 배선(하나씩, §4 control)**: 3a exemplar → 3b localize → 3c regression FEED.
**Phase 4 — 하드닝**: 언어게이트 전수, **데몬 배치 확정**(R1#2/R3#4: **box 이미지에 prebuilt 바이너리 bake**=per-run 빌드 0·cross-host hop 0, box-local 데몬 bootstrap 기동/종료. sidecar 택시 `url`/HTTP+BENCH_SSH_SAFE_OPTS급 하드닝+box-loss와 구분되는 health gate), 폴백 카오스(데몬 kill→degrade 증명), warm 수명/회전.

## 8. 적대 리스크 (요약, 상세는 §11)
- **R1 통합현실**: 6.3M Rust·Z3 빌드 → vendor 금지, **이미지 prebuilt bake**(ephemeral 박스서 per-run 빌드 불가). cgr 스키마 미검증=Phase 0 transcript 핀. stdio framing 미확인=HTTP 우회 가능.
- **R2 측정무효**: 오라클 미정의(gold-leak)·n 과소·threshold 부재·소비처 상호의존·selection-effect·언어 blend → §7이 전부 명문화(오라클 scorer-side+fence, n≥50+CI+5pp, factorial+paired, stratify).
- **R3 결정성**: treeOid 누락(CRITICAL)·캐시 scope·timeout 비결정·empty/error 혼동 → §6(treeOid 키, 별도 store, timeout first-class, 단일캐시) + 불변식3(구분 outcome).

## 9. 비스코프
- semantica agent-runtime(ApplyFix/RunTests/Bash) 흡수 = 별개(우리가 루프 소유; hybrid 결정 후속).
- semantica 자체 개선/Go uplift = semantica 레포.
- 이 RFC = 포트 추상화+MCP 소비+측정게이트. resolved 상승 주장 = Phase 0/3 측정 후에만.

## 10. 보존할 sound 코어 (객관어딧 확인 — 재작성서 유지)
포트-뒤-추상화(소비처가 엔진 직접 안 봄, lexical 즉시회귀) · **McpCallRecorder를 Phase 3 앞 하드블로커로 시퀀싱**(가장 놓치기 쉬운 정확한 콜) · measure-first NO-GO kill-switch(진성) · 언어게이트가 분석문서 Go/C++ 약점 정직흡수 · default-OFF null 어댑터 · 비스코프 규율(resolved 미주장·loop-ownership 보류) · 3-op granularity(군더더기 op 없음).

## 11. 어딧 changelog (v1→v2)
- **3 적대(통합현실/측정validity/결정성) + 1 객관, 독립 병렬, 전부 primary-source 그라운딩.**
- CRITICAL 3: ① treeOid 키(R3#1b) ② 단일캐시 scope(R3#5) ③ Phase0 recall 오라클 no-leak(R2#1).
- HIGH 9: 데몬 ephemeral배치(R1#2)·언어시그널 gold-free(R1#4)·McpReplayStore 별도스키마(R3#1a)·timeout first-class(R3#2)·outcome 구분(R3#3)·n≥50(R2#2)·threshold(R2#3)·소비처 factorial(R2#4)·exec_failed paired(R2#5)·언어 stratify(R2#6).
- MED 6: cgr 스키마 미검증 핀(R1#1)·over-claim 재라벨(R2#8)·micro-probe(R2#7)·evidence 승격(OBJ#2)·cost 회계(OBJ#1)·cross-RFC 소유권(OBJ#3)·스키마 버전핀(OBJ#6)·op 정렬(OBJ#4).
- 객관이 sound 7개 확인(§10) → 보존.
