# jul-4 — quanta SDK embed DX

목표: 외부(별도 레포)의 repo-분석 시스템이 quanta 에이전트를 **메인 에이전트 루프**로
`import` 한 줄로 붙일 수 있는 얇은 공개 SDK 표면(`quanta-codeagent/sdk`)을 구조적으로 확립한다.

- 소비 형태: in-process 라이브러리 임베드 (SDK 형태)
- 에이전트 역할: quanta `runAgent`가 분석 세션의 메인 루프 (툴콜·멀티턴·verify)
- 코어(`runAgent`) 불변, 전부 additive.

## 문서

- [00-MASTER-PLAN.md](00-MASTER-PLAN.md) — 최종 어딧 + 전체 계획 + 의존 그래프 + 검증 프로토콜
- [01-package-boundary.md](01-package-boundary.md) — Phase 1: 공개 경계 (토대, BLOCKER)
- [02-facade-core.md](02-facade-core.md) — Phase 2: `createAnalysisAgent` façade
- [03-event-ergonomics.md](03-event-ergonomics.md) — Phase 3: async-iterable + 축약 콜백 (체감 DX 본체)
- [04-capability-profiles.md](04-capability-profiles.md) — Phase 4: read-only/analysis/full 프로파일
- [05-tool-authoring.md](05-tool-authoring.md) — Phase 5: defineTool 재수출 + 레퍼런스 툴
- [06-test-harness.md](06-test-harness.md) — Phase 6: FakeLlm/RecordingStream 결정론 하네스
- [07-error-contract.md](07-error-contract.md) — Phase 7: 에러 taxonomy + outcome 재수출
- [08-stability-docs.md](08-stability-docs.md) — Phase 8: API snapshot 게이트 + 문서 + e2e

## 상태

- [x] Phase 0 스펙 고정 (실독 완료 — MASTER §A/B/C)
- [x] Phase 1 공개 경계 — 배럴 + `@/sdk` path + fence(green) + **package.exports `./sdk` + build:sdk(bun build, 2267모듈→13.5MB 단일 ESM, `@/` 미해결 0)**. 남음: `.d.ts` 번들(types).
- [x] Phase 2 façade — `createAnalysisAgent`, **런타임 검증**(실 `runAgent` 완주).
- [x] Phase 3 이벤트 — async-iterable + RunHooks + narrowing, 런타임 검증(`for await` done 관측).
- [x] Phase 4 프로파일 — **결정: Option A**(전부 batch; net-denied는 quanta egress만 막고 주입 in-process 툴 무영향, 실독 확인). read-only=registry 필터(런타임 검증). 남음: `full` wire-slot 조립(후속).
- [x] Phase 5 툴 — `defineTool`+`defineToolAsync` 재수출 + 레퍼런스 예제([examples/dep-graph-tool.ts](examples/dep-graph-tool.ts)).
- [x] Phase 6 테스트 하네스 — `fakeLlm`/`RecordingStream` fence-legal 공개.
- [x] Phase 7 에러 — taxonomy + NoCredential 런타임 검증.
- [x] Phase 8 — public-surface snapshot 게이트(green) + `version` + [USAGE.md](USAGE.md). 남음: 별도 e2e 파일(현 embed.test가 공개문-only 계약 커버).

검증: **정적**(tsc src 0 err, biome clean, sdk fence green) + **런타임**(20 유닛 pass, 실 `runAgent` 완주) + **외부번들**(dist/sdk import→run `reason=completed`).

**적대어딧 3R 완료** (R1 셀프 + R2·R3 독립 서브에이전트):
- **R2**가 CRITICAL 1 + HIGH 2 + MED 1 적발 → 전부 수정 + 회귀테스트:
  - F1(CRITICAL): `permission:{mode:"default"}`가 analysis 프로파일의 mutating 도구를 침묵 거부 → `bypass`+`hitl.autoApprove`로 수정, 회귀테스트로 mutating 실행 증명.
  - F2(HIGH): provider가 `apiKey` 무시 → `provider?` 옵션 추가.
  - F3(HIGH): `ToolRegistrationError`가 dead(dup 침묵 shadowing) → dup 검출+throw+override 규칙, 회귀테스트.
  - F4(HIGH): 공유 controller가 concurrent abort 깨뜨림 → per-run `Set<AbortController>`.
  - run.ts: single-consumer 가드 + hooks-only onError dispatch + fail() closed-guard.
- **R3**가 HIGH 1 + MED 2 + LOW 2 적발 → 수정:
  - auto-approve가 sensitive floor 무력화(HIGH) → blanket `onConfirm` 폐기, `bypass`+`hitl.autoApprove`(HARD_DENY floor 존속 + hand-off-required 거부 보존) 실측 확정.
  - fakeLlm 소진 런어웨이(MED) → 소진 시 terminal end_turn.
  - dead `AgentAbortedError`(LOW) 제거, `full` 침묵 별칭 trap(LOW) → union서 제거.
  - bash/HARD_DENY floor 경계는 USAGE에 명시.

**미완(정직):** `.d.ts` 번들(dts 툴 install 막힘 — runtime `import`만 노출), `full` 프로파일 wire-slot, 커밋(유저 확인 대기).

## 확정 필요 (구현 전 1개)

`analysis` 프로파일 레버 조합 — §04 참조: (1) 파일 mutate 허용 vs read-only, (2) network open vs denied.
기본 제안: `analysis` = verdict(멀티턴) + acceptEdits + network open + gitWrite snapshot-only.
