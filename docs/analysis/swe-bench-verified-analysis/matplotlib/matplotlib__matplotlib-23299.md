---
instance_id: matplotlib__matplotlib-23299
repo: matplotlib/matplotlib
base_commit: 3eadeacc06c9f2ddcdac6ae39819faa9fbee9e39
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: "2022-06-18T01:34:39Z"
fail_to_pass: 1
pass_to_pass: 192
gold_files: [lib/matplotlib/__init__.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap, underspecified]
---

## 문제 요약
`matplotlib.get_backend()`를 호출하면, `Gcf.figs`의 *첫* figure가 `rc_context` 안에서 생성된 경우 모든 figure가 `Gcf`에서 사라진다. 결과적으로 `plt.close(fig)`가 동작하지 않는다(`Gcf.destroy_fig()`가 figure를 못 찾음). 이슈 작성자는 lazy backend resolution과 rc_context의 backend 스냅샷/복원 상호작용을 원인으로 추정한다. 재현 스크립트와 정확한 actual/expected 출력이 함께 제공된다.

## 유형 (정형화)
- **L = L1 (Traceable):** 이슈 본문이 `rc_context`·`rcParams['backend']`·sentinel을 직접 지목하고 `lib/matplotlib/__init__.py`의 `rc_context`로 바로 수렴한다. 다만 "어느 줄을 바꿔야 하나"는 backend resolution semantics를 이해해야 나와서 grep 한 방(L0)은 아니다.
- **S = S2 (Constraint-Reasoning):** 고칠 함수는 `rc_context`로 명확하지만, 올바른 픽스는 "backend는 스냅샷/복원 대상에서 제외한다"는 *불변식*을 추론으로 합성해야 한다. 후보를 여러 개 던져 테스트로 거르는 G&V가 아니라, lazy resolution이 `finally`의 `dict.update`로 sentinel을 덮어쓰는 인과를 따져 한 가지 올바른 식을 도출하는 문제다.
- **K = K-Domain:** matplotlib 내부의 backend auto-sentinel + lazy resolution + `Gcf` lifecycle을 알아야 근본원인이 보인다. 일반 파이썬 추론만으로는 "왜 backend만 특별 취급해야 하는지"를 정당화할 수 없다.
- **primary = T-ConstraintReason:** 위치는 거의 주어졌고(L1), 난점은 backend라는 단일 키를 복원 사이클에서 빼는 *조건*을 의미론적으로 정당화하는 데 있다. 그래서 S2가 dominant이고 T-ConstraintReason.

## 난이도 티어
- **tier = T4 (약간 어려움).** 구조적 피처: 파일 1개·실질 +3/-1줄(매우 작음)이고 `has-repro`라 재현은 거의 공짜다. 이 두 신호만 보면 T2~T3로 당길 수 있다.
- T4로 미는 요인: (1) **도메인 추론(K-Domain)** — 패치 자체는 작지만 "왜 backend만 del 해야 하는가"는 lazy backend resolution + sentinel을 모르면 못 푼다. (2) **regression-trap** — PASS_TO_PASS 192개가 `test_rcparams.py` 전체(validator·rc_context fail-revert 포함)라, rc_context의 일반 복원 동작을 깨면 광범위하게 무너진다. 특히 `test_rcparams_reset_after_fail`이 backend 제외 후에도 나머지 키 복원이 정상임을 강제한다.
- 공식 라벨 "15 min - 1 hour"와 일치한다. 개발자에게는 짧지만, 오라클 없는 에이전트에는 backend special-casing을 *추론으로* 정당화하는 부분이 진짜 비용이라 T4가 타당하다.

## 골드패치 분석
- **건드린 파일·함수:** `lib/matplotlib/__init__.py`의 `rc_context` (contextmanager).
- **근본원인:** `rc_context` 진입 시 `orig = rcParams.copy()`로 전체 rcParams를 스냅샷한다. 이때 `rcParams['backend']`는 미해결 상태면 auto-sentinel을 들고 있지만, `.copy()`/getitem 경로에서 backend가 해결될 수 있다. `finally`의 `dict.update(rcParams, orig)`가 이 스냅샷을 되돌리면서 backend 키를 sentinel(또는 stale 상태)로 다시 강제한다. 이후 `get_backend()`가 backend를 재해결(re-resolve)하는데, 이 재해결이 backend 전환으로 간주되어 기존 figure들을 닫아 `Gcf.figs`를 비운다.
- **수정요지:** 스냅샷에서 backend를 아예 제외한다. `orig = dict(rcParams.copy())` 후 `del orig['backend']`. 그러면 `finally`의 복원이 backend 키를 건드리지 않아, context 내부에서 backend가 어떤 상태가 됐든 그 상태가 그대로 유지되고 불필요한 재해결/figure 소거가 사라진다. docstring에도 ":rc:`backend` will not be reset by the context manager." 한 줄을 추가해 계약을 명시한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_no_backend_reset_rccontext`. `rc_context()` 안에서 `mpl.rcParams['backend'] = 'module://aardvark'`로 backend를 바꾼 뒤, context 종료 후에도 `rcParams['backend'] == 'module://aardvark'`임을 단언한다. 즉 "rc_context가 backend를 되돌리지 않는다"는 새 계약을 직접 고정한다.
- **픽스 증명:** 픽스 전에는 `finally`의 `dict.update(..., orig)`가 backend를 context 진입 시점 값으로 되돌려 단언이 깨진다. `del orig['backend']` 후에는 backend가 복원에서 제외되어 context 내 변경이 살아남아 통과한다. 이슈의 실제 증상(figure 소거)도 동일 인과의 다운스트림이라 함께 해소된다.
- **overfit 관점:** FAIL_TO_PASS가 1개라 얇지만, 테스트가 backend 키 자체의 복원 동작을 직접 검사하므로 special-case 우회(예: 증상만 가린 figure 보존 핵)로는 통과하기 어렵다. backend를 복원 사이클에서 빼는 정공법이 사실상 유일 해라 overfit 위험은 낮은 편.
- **regression 관점:** PASS_TO_PASS 192개 중 `test_rcparams_reset_after_fail`이 backend 외 나머지 키들의 복원/예외-안전 복원이 그대로임을 강제한다. backend만 선택적으로 제외했기에 일반 rcParams 복원 의미론은 보존된다.

## 모범답안 (오라클 기반)
1. **localize:** 이슈가 "rc_context에서 만든 첫 figure" + "get_backend()가 figure를 닫음" + hints의 "sentinel을 rc_context가 stash"를 직접 준다. `rc_context`(lib/matplotlib/__init__.py)로 직행하고, `orig = rcParams.copy()` ↔ `finally: dict.update(rcParams, orig)`의 스냅샷/복원 쌍을 backend의 lazy resolution과 연결한다.
2. **픽스와 일반화:** 복원 대상에서 backend 키만 제외(`del orig['backend']`). 이것이 올바른 일반화인 이유 — 근본원인은 "복원이 backend를 stale/sentinel 상태로 되감아 재해결을 유발"하는 것이므로, 재해결 트리거(=복원 자체)를 backend에 대해 제거하는 게 정확한 처방이다. figure 소거를 사후에 막는 식의 핵은 증상만 가린다.
3. **regression 안전:** rc_context의 일반 복원과 예외-안전 복원은 그대로 유지해야 한다(`test_rcparams_reset_after_fail` 외 다수). backend 단일 키만 빼고 `dict.update` 구조를 보존하므로 나머지 동작은 byte-동일하게 남는다.
4. **함정 회피:** (a) figure 소거를 `Gcf`/`get_backend()` 쪽에서 막으려는 시도 — 위치 오판(L1을 L2로 흩뜨림)이자 증상치료다. (b) `orig` 전체에서 backend를 제거하지 않고 `rc_context` 인자 `rc`만 필터링 — context 내부에서 backend가 바뀐 경우를 못 잡는다. (c) docstring 계약(backend는 reset 안 됨) 누락 — 동작은 맞아도 공개 계약 변경을 문서화하지 않으면 의도치 않은 BC 혼란. 정답은 스냅샷 단계에서 backend를 제외하고 docstring으로 계약을 명시하는 것.
