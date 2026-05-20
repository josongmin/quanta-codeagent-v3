# ADR-0014: bench 외부 repair 라운드 (continue-from-patched-tree)

- **상태**: Accepted
- **날짜**: 2026-05-20
- **관련**: RFC-0001 §1.1(측정 정직성)·§1.2(SOTA++ 스탠스)·§16(흡수 명세), ADR-0011(Tier 0+1 흡수·동작 보존 패턴), ADR-0013(verify-before-finish 가드 — 보완적 메커니즘)

## 맥락

실측: ADR-0013 verify-before-finish 가드는 실 SWE-bench 런에서 **트립 0회**
로 inert — 가드 자체는 견고하지만 gpt-4o가 이미 verify를 수행하는 인스턴스
에서는 발동 여지가 없다. 값싼 레버(프롬프트 강화·Best-of-N·verify 가드)가
모두 소진된 뒤 SOTA 스캐폴드에 남은 핵심 레버는 **에이전트 외부에서 실패
피드백을 받아 다시 도는 repair 라운드**다.

정직성(RFC §1.1): resolution%는 본 레포가 산출하지 않는다 — 외부 Docker/
Python 채점에서만 나온다. 본 라운드는 "오답서 멈추지 말고 한 번 더 시도"
메커니즘이지 resolution% 보장이 아니다.

## 결정

`RunInstanceDeps.repair?: { maxRounds?, validate?, buildContext? }`를 도입
한다. **부재 시(default)** 러너는 기존 단일패스 경로 그대로 — byte-identical,
custom-corpus·non-swebench 인스턴스 무영향(ADR-0011 동작 보존 패턴).
존재 시 그리고 `instance.swebench`일 때만 활성(`verifyGuard`와 동일 게이팅).

라운드 모양 (`src/apps/bench/repair/index.ts` `runRepairRounds`):

- **round 0**: 기존대로 `runAgent`(seedMsg `undefined`) → 에이전트 자신의
  마지막 verify cmd(`bash` test-like / `test_runner`) 또는 자체 작성한
  repro 스크립트를 `validate`가 patched sandbox에서 재실행.
- **round i ≥ 1 (실패하고 `round < maxRounds`인 경우)**: `buildRepairContext`
  로 seed 메시지 합성 — 헤더 → 원본 problem(verbatim) → 누적 diff →
  failTail → forceful next-step("git checkout/reset/clean/stash로 패치 되돌리지
  마라, 테스트 말고 소스를 고쳐라, 같은 verify cmd를 다시 돌려라") — 같은
  sandbox에 `runAgent` 재실행(**continue-from-patched-tree**). `maxRounds`
  기본 2 ⇒ 최대 3회 에이전트 호출.

러너 측 핵심 (`src/apps/bench/runner.ts` `runRepairPhase`):

- **단일 `withGitSnapshot`가 모든 라운드를 감싼다** — 라운드 사이에 절대
  `git reset/clean/stash`하지 않는다(누적 diff는 끝에 한 번 캡처).
- `LastVerifyCmdTap` 스트림 옵저버가 에이전트의 마지막 verify cmd를 추출해
  validator에 주입.
- 공식 `verify()`는 **루프 종료 후 정확히 1회**, 최종 누적 패치에 대해서만
  호출하며 **절대 에이전트에 피드백되지 않는다**.

## no-leak 불변식 (핵심)

repair 모듈은 SWE-bench hidden 필드(`FAIL_TO_PASS`/`PASS_TO_PASS`/
`test_patch`/공식 `.report.json`)를 **구조적으로** 읽을 수 없다:

1. `repair/types.ts`의 `ValidateArgs`·`BuildRepairContextArgs`·`RunOnceResult`
   계약이 hidden 필드를 노출하지 않는다(에이전트의 cmd / repro path / 누적
   diff / failTail / problem statement만).
2. `repair/{index,validator,context}.ts`의 import allowlist는 **`./types`만**.
   `@/agent`/instance/dataset 모듈 직접 import 금지(인덱스도 마찬가지).
3. 토큰 금지 골든 테스트: `FAIL_TO_PASS`/`PASS_TO_PASS`/`test_patch`/
   `goldPatch`/`.report.json`/`swebench.harness` 문자열이 repair 모듈에
   존재하면 CI 실패(merge-gate-class 불변식).

validator의 신호는 **에이전트 자신의 cmd 또는 자체 작성한 repro 스크립트만**.
이게 벤치 게이밍을 *구조적으로* 불가능하게 만들고, 따라서 본 라운드가 더한
값(있다면)은 *정직한 향상*으로만 측정된다.

## 근거

- 프롬프트·Best-of-N·b1 verify 가드는 실측상 plateau(n=1=n=3=3/5, 가드
  트립 0회). 능력 격차에는 분산 절감(Best-of-N)이 무력하고, 가드는
  "verify 안 한 종료"에만 동작한다.
- repair는 정공법이며 에이전트가 **실패 피드백을 실제로 받는다** — 위
  레버들이 못 닫는 빈자리에 정확히 위치한다.
- 기존 `runAgent` 재호출 + 기존 `withGitSnapshot`를 재사용 — 신규 루프
  경로·신규 npm dep **0**.

## 대안

- **Best-of-N 추가 확장**: 기각 — 분산 문제가 아님(실측), 비용만 ×N.
- **b1 verify 가드만으로 충분**: 기각 — inert(실측 0트립). 가드는 에이전트
  *안*에서 self-verify를 유도하고, repair는 에이전트 *밖*에서 실패 피드백
  라운드를 돌린다 — 보완적이지 대체재가 아니다.
- **더 강한 모델로 교체**: 직교 — repair와 곱셈식으로 결합 가능.
- **공식 grader 결과를 에이전트에 직접 피드백**: 기각 — no-leak 불변식
  위반. resolution%를 자기 보증하는 셈이 되어 RFC §1.1 정직성 붕괴.

## 결과·트레이드오프

- **얻은 것**: 라운드 사이 실패 컨텍스트를 받아 같은 sandbox에서 이어 고치는
  *외부* 피드백 루프. b1 가드와 보완적(가드=에이전트 안 self-verify 유도,
  repair=에이전트 밖 라운드).
- **비용**: 호출 비용 ≈ ×(1+maxRounds), 라운드별 `maxTurns` 합산, 월클럭
  캡 필요. 라운드 사이 sandbox 상태는 유지(reset 안 함) — 디스크 점유는
  단일 패스와 동치.
- **상승 보장 없음**: 가드 라운드를 줘도 모델이 옳은 수정을 못 내면 천장은
  천장이다(ADR-0013과 같은 정직성). no-leak 덕에 *가짜* 향상은 구조적으로
  불가능 → 측정값은 정직하다.

## 한계 (LIMITATIONS)

- **(a) validator는 에이전트 자신의 cmd에 의존**: 에이전트가 verify를 전혀
  하지 않았으면 validator는 degenerate `{ok:false, failTail:""}`를 반환한다
  — 침묵 통과(silent pass)는 아니지만 라운드만 낭비된다. b1 가드와 결합
  사용을 권장(가드가 verify 호출을 강제하고, repair가 실패 피드백을 돌린다).
- **(b) tail bound로 큰 컨텍스트는 잘림**: failTail 기본 2000자 / 시드
  메시지 기본 12000바이트 캡, 초과 시 failTail TAIL → diff 중간 hunk →
  problem HEAD 순으로 절단(절단 마커 남김). 매우 긴 트레이스/diff에서는
  핵심 신호가 잘려나갈 수 있다.
- **(c) resolution% 무관**: 본 라운드 자체는 점수를 올리지 않는다 — 옳은
  수정 생성은 여전히 모델 몫이고 점수는 외부 채점 산출이다(RFC §1.1).
  hidden 필드(`FAIL_TO_PASS`/`test_patch`/공식 report)를 한계로서 *언급*하는
  것은 ADR 텍스트뿐이며, 코드(import 그래프)에서는 어디서도 나타나지 않는다
  — 이게 no-leak의 의미다.
- **(d) Empirical evidence (실측, 2026-05-20, gpt-4o)**: Easy-5 with
  `--repair-rounds 2` 측정 결과 **resolved 2/5 (40%) — 단일패스 baseline
  3/5 (60%) 대비 DOWN**. repair 메커니즘은 end-to-end 정상 동작(rounds 발화,
  no-leak 불변식 실측 유지, 공식 `verify()` 정확히 5회 실행). 그러나
  이전 단일패스에서 PASS이던 인스턴스 `django__django-10914`가 r=2 런에서
  **PASS→FAIL로 회귀** — 에이전트 자신의 pytest 신호가 hidden grader와
  발산한 전형적 over-correction 사례. **Empirical recommendation**:
  b2는 설계대로 default-OFF 유지, 사례별로 (불확실성·복잡 수정 등 케이스가
  iteration을 정당화할 때만) opt-in. 전체 swebench에 일괄
  `QUANTA_REPAIR_ROUNDS=2`는 **권장하지 않음**. 메커니즘은 옳지만 gpt-4o
  capability에서 Easy-django 비용-편익이 현재 negative.
- 참조: Codex App agent loop doc §5.10에서 `should_verify`는 default
  **False** — explicit request 또는 repo-rule required 시에만 발동. v3의
  forced-verify 디폴트와 정반대 방향이며, 본 실측이 그 default-OFF 직관을
  empirically 받쳐줌.

## 변경 이력

- ADR-0013 단일패스(라운드 0뿐) → 본 ADR이 외부 repair 라운드 추가.
- b1 가드와 보완적: **가드 = 에이전트 *안* self-verify 유도** / **repair =
  에이전트 *밖* 실패 피드백 라운드**. 동시 활성 가능(러너에서 직교 게이트).

## 불변식 영향

- **슬라이스 격리 유지**: repair는 `src/apps/bench/repair/**` (앱 내부 모듈).
  `@/agent`/instance/dataset 슬라이스 손도 안 댐 — runner.ts가 유일한 컴포저.
- **RFC/ADR 동기(불변식 #2)**: RFC §16에 1줄 추가, §1.1 정직성 노트 유지.
- **신규 npm dep 0**.
