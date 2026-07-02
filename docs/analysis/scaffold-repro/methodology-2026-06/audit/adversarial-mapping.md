# 적대 어딧 — methodology-2026-06 "A. 이미 있음" + "C. 착각 정정" 재검증

> 대상: `methodology-2026-06/README.md`의 표 A(이미 있음)·표 C(착각 정정).
> 방법: 각 claim을 `src/` 직접 grep + 원본 스캐폴드 코드(`.extracted_source/`) + SRI blog WebFetch로 ground-truth 재확인.
> 판정 태그: **[OVERCLAIM]** = "이미 있음/완비"가 실제로 inert·미배선·의미 불일치 / **[HOLDS]** = 정정이 근거로 지지됨 / **[NUANCE]** = 대체로 맞으나 문구 정정 필요.

---

## 공격 1 — "regression-veto 완비" (표 A) → **[OVERCLAIM: 완비 아님, 세 겹으로 틀림]**

README 표 A는 `regression-veto | SWT grading.py:220 | regression-oracle.ts:141-147, selection-gates.ts:74 | **완비**`.
SWT `grading.py:205-222`의 실제 veto = `get_resolution_success`:
```python
not_added_x2f = len(pred_p2f.difference(base_p2f)) == 0 and (len(pred_f2f.difference(base_f2f)) == 0)
return added_p2f and not_added_x2f, ...
```
= **GRADING-time hard 곱셈 게이트**: 예측 test transition이 base 대비 NEW pass→fail(P2F)·NEW fail→fail(F2F)를 **0개** 추가해야만 resolved. base-tree 대비 ×→F 를 hard로 거른다.

우리 것과 대조하면 **cited 두 좌표가 둘 다 틀리고, 셋째로 라이브 경로도 동형이 아니다:**

1. **`selection-gates.ts:74`는 veto가 아니다.** 그 라인은 `earlyAcceptable` 안의
   `const executedProof = resolvedKofNPositive(resolved) || entry.hard.regressionGreen === true`
   — `regressionGreen === **true**`를 early-**accept**(positive proof)로 쓰는 자리다. ×→F **reject**가 아니라 그 반대(green을 조기 통과 근거로). 실제 reject는 `:374`/`:419`/`:454`의 `regressionGreen === false`.

2. **그 파일 전체가 `@deprecated`·no-preset.** `selection-gates.ts:2` 헤더:
   `@deprecated jun-27 — the verify-select / best-of-N veto SELECTION plane is retired ... The enabling presets were removed; do NOT enable these knobs.`
   veto 경로는 `driver.ts:5726` `if (args.prepared.posture.verifySelectN !== undefined ...)` 로만 진입하는데, `verifySelectN` default = `undefined`이고 **어떤 preset도 set하지 않는다**(`presets.ts:351-355` "the verify-select/best-of-N veto SELECTION plane is retired"; `bench-c.ts:81` `@deprecated jun-27 — verify-select veto SELECTION plane retired`, `verifySelectRegressionSchema.default = undefined`). → cited veto 경로는 **inert(측정 불가 아님, 도달 불가)**.

3. **라이브 regression 경로는 hard ×→F veto가 아니라 soft min-count 랭킹.** 유일하게 살아있는 regression 신호는 acceptance plane(`QUANTA_BENCH_ACCEPTANCE`, opt-in preset `agentless-v6-oracle`/`-hardened` `presets.ts:288,326`에서만 `acceptance:"1"`)의 `regressionFailuresOnSandbox`(`driver.ts:3480`, `acceptance-selector.ts:34,52`). 이건:
   - **COUNT 비교**(`regressionFailureCount`: pass=0, fail=len(failed), 미실행=+Inf)로 후보들 사이 **min-regression 바**를 세우는 **랭킹 tie-break**(`acceptance-rerank.ts:12-15` tier ladder)이지, "×→F이면 F" **hard reject가 아니다**.
   - base-tree 대비 P2F/F2F **delta**가 아니라 patched-tree에서 owner-near test **absolute 실패수**다(base subtraction 없음).
   - `regressionSet = ownerNearRegressionSet = baseGreenTestPaths`(`driver.ts:5646`)가 **비어 있으면 통째 no-op**(`acceptance-selector.ts:74`, `driver.ts:3480` `regressionSet.length > 0` 가드).
   - `acceptance-selector.ts:15` 주석 자인: "The regression dual-guard half is a **follow-up**."

**결론:** "regression-veto 완비"는 **삼중 오류**. (a) cited `:74`는 accept-proof이지 veto가 아님, (b) cited veto 파일은 deprecated·no-preset로 **도달 불가**, (c) 라이브 대체 경로는 hard ×→F veto가 아니라 base-subtraction 없는 soft min-count 랭킹이며 opt-in·regressionSet-비면-no-op. → 표 A의 `regression-veto | 완비`는 **`부분(opt-in soft, 미측정, SWT grading.py:220과 비동형)`으로 강등**해야 한다. `regression-oracle.ts:141-147`(`toRegressionGreen`)만은 라이브지만 그건 boolean 매퍼 유틸이지 게이트 정책이 아니다.

---

## 공격 2 — "best-of-N by own tests 있음·미측정" (표 A) → **[HOLDS, 단 강도 caveat]**

README/lstar.md: L*Agent (d) "생성한 강한 test로 후보 선택"을 우리 acceptance-select/reproVote에 매핑.
grep로 discriminator 실체 확인:

- `selectByAcceptance`(`acceptance-select.ts:174-204`)는 각 후보를 `reproPass = safeRepro(...)`로 채점 → `rerankSelect`. tier ladder `acceptance-rerank.ts:12-15`: **tier 1 = repro-pass AND min-regression**. 즉 **1순위 판별자가 repro-pass**다.
- `reproPass`의 정체(`acceptance-selector.ts:47,75`): `reproResolvedOnSandbox` = 후보 패치를 apply한 tree에서 **우리 자신이 생성한 reproSources**(agent-side repro scripts)를 돌려 resolved 판정. 즉 **selector의 discriminator = 우리 self-생성 repro test가 맞다**(validator-rank가 아니라).
- 따라서 "picking the best patch using our own tests"와의 **방향 매핑은 정확**하다. **[HOLDS]**

**단 두 caveat(문구 강화 필요):**
- **discriminator 성질 차이.** L*Agent의 test는 post-fix **정답값을 pin하는 강한 assertion**(lstar.md §1(b): `assertOptimizesTo`, `expected.identical`). 우리 discriminator는 **binary resolved/reproduced 다수결 vote**(`vote.ts:49` `voteResolved`)로, "값이 맞나"가 아니라 "reproducing set이 이제 green인가"만 본다. 즉 selector 신호가 L*보다 **약한 결(coarser)**이다 — "같은 축"이되 "같은 강도"는 아님.
- **opt-in.** acceptance discriminator는 `agentless-v6-oracle` 계열 preset에서만 켜지고 default 경로(`agentless-v1` frozen baseline)에선 `undefined` → 레거시 validator-rank. "있음·미측정" 자체는 맞다(코드 랜딩됨·A/B 안 됨).

---

## 공격 3 — abstain 정정(reproduce-alone −13pp, +28pp 전부 abstain) → **[HOLDS, minor NUANCE]**

SRI blog `https://www.sri.inf.ethz.ch/blog/fixedcode` WebFetch 직접 확인:

| 수치 | 모델 | 조건 |
|---|---|---|
| 60.5% | GPT-5.4-mini | Baseline (Fix) |
| 88.5% | GPT-5.4-mini | Reproduce+Fix+**Abstain** |
| 47.5% | GPT-5.4-mini | Reproduce+Fix (**no abstain**) |
| 65.0→80.5% | Sonnet 4.6 | Baseline → Reproduce+Fix+Abstain |
| 65.5% | Sonnet 4.6 | Reproduce+Fix (no abstain, ≈불변) |

- **−13pp 반례 확인**: verbatim "simply asking to 'reproduce before patching' (without the explicit option to abstain) ... actually hurts GPT-5.4 mini, dropping it to **47.5%**" → 60.5→47.5 = **−13pp 정확**. lstar.md §1(e)/README C 항 **[HOLDS]**.
- **abstain 성질 = 벤치 채점 규칙 변경이 아니라 AGENT 행동**: verbatim "It **redefines success to include the possibility of abstaining**" + WebFetch 판정 "agent behavior ... behavioral guidance through prompting, **not a modification to how the benchmark itself evaluates**." → lstar.md가 "abstain을 success로 reframe/재정의"라 쓴 건 **에이전트가 이미-fixed 이슈에 패치를 안 내는 행동을 허용하는 프롬프트 프레이밍**을 의미하며, 이는 blog와 일치. **[HOLDS]**
- **task 확인**: "200 instances from SWE-Bench Verified" **fixed-code(SWE-fix) task** — SWT test-gen 84% lever가 아님. lstar.md 정정 2 **[HOLDS]**.

**NUANCE(문구 정정 2건, 결론 불변):**
1. 모델명이 blog는 **GPT-5.4-mini**인데 lstar.md/README는 "GPT-5-mini"로 표기. minor version 라벨 오기 — 인과 판정엔 영향 없음.
2. "success로 재정의"라는 한국어가 자칫 "grader가 재채점한다"로 오독될 수 있음. blog의 실체는 "**프롬프트가 abstain을 허용**→모델이 no-op 선택"이라는 **에이전트 행동**이므로, README C 항은 "채점 규칙 변경 아님, 에이전트 abstain 행동"임을 명시하면 오독 방지. (lstar.md §1(e) "fix-or-abstain 프레이밍/무행동을 성공으로 재정의"는 이미 이 뜻으로 정확히 씀 — README 요약 문구만 살짝 느슨.)

---

## 공격 4 — "Echo dual-version/graph 공개코드 부재" (표 C) → **[HOLDS, 과소평가 아님]**

원본 `.extracted_source/repro-scaffolds/echo/` 재확인(README badge는 "Neo4j Knowledge Graph"로 대대적 광고, `app/graph/`·`app/neo4j/` 디렉토리 실재 — 여기서 과소평가 의심):

- **graph 엣지 타입 전수**(`app/graph/graph_types.py:126-133` `KnowledgeGraphEdgeType`):
  `parent_of`(ASTNode→ASTNode), `has_file`(dir tree), `has_ast`(File→AST), `has_text`(File→Text), `next_chunk`(Text→Text). **끝.**
  → **CALLS/IMPORTS/REFERENCES 엣지 타입이 enum에 아예 없다.** 살아있는 그래프 = 디렉토리 트리 + 파일별 tree-sitter AST parent-child + 텍스트 청크 체인. **call/import 그래프 0**은 repro-specific.md 주장 그대로. (엄밀히는 "substring 트리"보다 "AST parent-of + text-chunk"가 정확한 서술 — 순수 substring은 아니나 **semantic call/import 엣지가 0**이라는 핵심은 HOLDS.)
- **oracle = LLM-judge, dual-version 아님**(`app/lang_graph/nodes/bug_reproducing_structured_node.py:30-32`): `BugReproducingStructuredNode` verbatim "You are an agent that **verifies if a test properly reproduces** a reported bug" → structured-output(`reproduced_bug: bool`) **LLM 판정**. 실행은 base(버그present) tree 1개(`bug_reproducing_execute_node.py`), gold/patched 둘째 tree 실행 없음. `grep dual/two.version/golden/patched.tree = 0`.
  → **dual-version execution oracle 부재 = 확정**. Echo는 single-version(base) 실행 + LLM judge.

**결론:** repro-specific.md의 두 정정(graph에 call/import 없음 · dual-version oracle 없음 · 실질 lever=few-shot+judge)은 원본 코드로 **완전 지지**. Neo4j 디렉토리 실재에도 **과소평가 아님** — 디렉토리는 있으나 엣지 스키마가 구조-only. **[HOLDS]**

---

## 공격 5 — "TEX 직교 정정: reprovote=N-script×1-tree, C축 격자 없음" (표 C) → **[HOLDS]**

우리 reprovote 코드 재확인:

- `vote.ts:49` `voteResolved(samples)` — `samples`(여러 repro **script**) 순회, 각 script의 outcome(resolved/reproduced) 다수결. 입력이 **한 patched tree에서 실행된 N개 script**다(`vote.ts:5-9` "candidate fix is correct IFF those scripts now resolve on the PATCHED tree"). → **N-test × 1-fix**.
- `repro-vote.ts`(`repair/`)·`resolvedConsensus`(`vote.ts:82`)도 동일: `{votes, k}` = "몇 개 script가 resolved" — **1개 tree에 대한 script 다수결**. fix 다양성(C축) loop 없음.
- grep 재확인: `crossValidat|crossCandidate|peer` in `src/` = **0 hit**(tex-t.md §1 표와 일치). `repair-breadth.ts:291`은 각 fork를 "candidate's **own** tree"로만 검증 = TEX가 "stagnate"라 지목한 self-only.

**결론:** tex-t.md "reprovote는 test 다양성(T축)으로 1-fix 검증 — C축(모든 fix×모든 test) 격자 통째 없음, TEX와 직교(부분집합 아님)"은 코드로 **정확**. **[HOLDS]**

---

## 최종 판정

**표 A "이미 있음" 중 강등 대상:**
- **`regression-veto | 완비` → OVERCLAIM.** cited `selection-gates.ts:74`는 veto 아니라 accept-proof, cited 파일은 deprecated·no-preset로 도달 불가, 라이브 대체(acceptance regression)는 SWT `grading.py:220`의 hard ×→F 곱셈게이트와 **비동형**(base-subtraction 없는 soft min-count 랭킹·opt-in·regressionSet 비면 no-op). → `부분(opt-in soft, 미측정)`으로 정정 필요. (표 B ★★2 "change-coverage ΔC 곱셈게이트 전무" 판정은 이와 정합 — 오히려 표 A가 표 B와 자기모순이었음: 곱셈게이트가 전무면 regression-veto도 "완비"일 수 없다.)
- `best-of-N by own tests | 있음·미측정` → **HOLDS**(discriminator=self-repro 확인). 단 "강한 test"가 아니라 binary resolved-vote라는 **강도 caveat** 병기 권장.

**표 C "착각 정정" 재검증:**
- abstain(−13pp/+28pp-abstain) → **HOLDS**(SRI blog verbatim 확인). 모델명 GPT-5.4-mini 오기·"채점규칙 아닌 에이전트 행동" 명시의 minor 문구 정정만.
- Echo dual-version/graph 부재 → **HOLDS**(enum에 call/import 엣지 0, oracle=LLM-judge, 과소평가 아님).
- TEX 직교(reprovote=N×1, C축 없음) → **HOLDS**(vote.ts 코드 일치).

→ **착각 정정 4건 중 과잉해석으로 재정정할 것 = 0.** 뒤집힌 건 표 A의 "regression-veto 완비" 단 1건(inert/미배선/비동형).
