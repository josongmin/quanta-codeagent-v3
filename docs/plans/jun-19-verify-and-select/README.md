# Verify-and-Select — closure executor authority 교체 (Phase 1)

## 왜 (measured)
jun-19 on-demand wide-12: agentless-v2 + repair executor = resolution **9→7**,
`verify_rounds` 항상 max, `false_red=0`. repro는 **false-NEGATIVE oracle**(correct
fix를 "안 됐다"고 우김). 단일-인스턴스 A/B로 확정: 19495(quanta-only win, mini❌)·23534
모두 executor-OFF서 **그대로 통과 + turns 131→29 / 126→34**. → executor를 agentless-v2에서
제거(커밋 e5b4f7b2 라인). win은 closure GROUNDING 덕분이지 repair 아님.

## 불변식 (정정된 north star)
~~"selection > 반복수리"~~ 가 아니다. 정확히:

> **단일 noisy oracle이 전역 verdict authority를 갖지 않는다.**

- anti-repair 아님. bounded repair는 **후보생성 내부 local search**로 남아도 됨.
- 죽이는 건 **repro 판정이 "너 틀렸어 다시"+전역권한으로 흐르는 sabotage 채널**.
- outer control plane = **verify-and-select-centric**, repair-centric 아님.
- 2026 공개선(Live-SWE-agent / SWE-Replay / Agentic Rubrics / SWE-TRACE)이 agentless냐
  agentic이냐가 아니라 이 불변식으로 수렴.

## 레포 상태 (재설계 아님 — authority 교체)
조각 이미 있음:
- N-best 후보 생성 + verifier 슬롯: `src/agent/branch-search/tool.ts:142`
- typed predicate(baseValidatedRed / issueDeclaredExpected): `src/agent/verification-plan/build.ts:67`
- repro 다수결 (reproduced 쪽만): `src/agent/repro-test/select.ts:244`
- FaultEvidencePacket: `src/runner/batch/eval/fault-evidence.ts:1`
- 🔴 결함: repair loop가 predicate를 **observe-only**로 두고 반복수리 지속:
  `src/runner/batch/eval/repair/index.ts:79`. false-red/false-green 측정은 하나
  **authority는 아님**.

## 아키텍처 (Phase 1 vertical slice 척추)
```
gate(verify) ─► [N-best candidate gen]  (branch_search; bounded repair = inner tactic)
                      │  각 후보마다
                      ▼
              VerificationBundle.scoreCandidate(hard, soft)
                      │  HARD-GATE (AND): baseValidatedRed · patchedResolvedKofN
                      │                   · regressionGreen · applyClean
                      │  SOFT-SCORE (weighted): declaredExpectedMatch · rubric
                      │                   · voterQuorum · minimality · ownerCoverage
                      ▼
              selectBest(admissible) ─► submit  (verdict authority = bundle, NOT repro)
```

## no-leak 규율 (기존 불변식 재사용)
회귀 오라클은 **engine-concept**. 엔진은 `RunImpactedTestsPort`만 알고 PASS_TO_PASS는
**bench adapter가 instantiate**(offline·eval-only, closure-diagnostics가 gold/F2P를
agent loop에 안 흘리는 것과 동일). 벤치 라벨이 엔진 SSOT 되면 = 오라클 누출.

## 시퀀싱 (의존 그래프)
```
T0(계약) ──► TA(bundle core) ─┐
         ──► TB(regression port)├─► TD(selection executor + predicate authority)
         ──► TC(resolved K-of-N)┘
```
- **T0** 먼저(나, 직렬, 작음) — 3 트랙의 합의 계약.
- **TA·TB·TC** 병렬(worktree 격리, 서로 다른 슬라이스라 충돌0, 각자 T0 HEAD에 대고
  + staleness preamble[HEAD vs main+ff]).
- **TD** 통합(나, TA/TB/TC 머지 후).

## 측정 규율
- selection executor = **knob/preset 게이트 뒤 default-OFF**. agentless-v2엔 안 넣음.
- 진단 자동캡처(index.ts closureTelemetryPresent) 재사용 + false_red/false_green이 이제
  **authority 검증**으로 의미.
- on-demand A/B(`QUANTA_FULL_REMOTE_ONDEMAND=1`): selection ON vs 현 single-pass,
  wide-12 + django easy. 측정 전 default-on / 효과 주장 금지.

## Phase 2 (별도 track, 측정 후)
- repro/test 생성 품질: top-K test × N patch × rerank (SWE-Tester/Issue2Test식), K=40 스케일
- execution-free verifier: contextual rubric / patch-reranker (Agentic Rubrics)
- localization retrieve+rerank (SweRank)
- learned verifier/PRM: trajectory + false-red/false-green 라벨 학습 (SWE-Gym/SWE-TRACE)

티켓 상세 → `tickets/00-phase1.md`.
