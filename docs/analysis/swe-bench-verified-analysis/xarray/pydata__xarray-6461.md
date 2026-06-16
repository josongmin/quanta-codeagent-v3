---
instance_id: pydata__xarray-6461
repo: pydata/xarray
base_commit: 851dadeb0338403e5021c3fbe80cbc9127ee672d
version: "2022.03"
difficulty: "<15 min fix"
created_at: 2022-04-09T03:02:40Z
fail_to_pass: 1
pass_to_pass: 247
gold_files: [xarray/core/computation.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`xr.where(cond, x, y, keep_attrs=True)` 호출 시 `x`(두 번째 인자)가 스칼라이면 `IndexError: list index out of range`로 죽는다. 이슈에 `xr.where(xr.DataArray([1,2,3]) > 0, 1, 0)` 재현 코드와 함께 `keep_attrs = lambda attrs, context: attrs[1]` 라인이 터지는 스택트레이스가 그대로 붙어 있다. 원인은 `attrs[1]`이 "x의 attrs"를 가져오려는 의도지만, 스칼라 인자는 `attrs` 리스트에 항목을 남기지 않아 인덱스 1이 범위를 벗어나기 때문이다. 워크어라운드는 `keep_attrs=False`.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed).** 이슈가 파일·함수·줄·예외까지 전부 지목한다. 스택트레이스가 `computation.py`의 `where()` 안 `keep_attrs = lambda attrs, context: attrs[1]` 한 줄을 핀포인트한다. grep 한 방.
- **S (Repair Strategy) = S1 (+S2).** 결함 클래스가 정형(인덱스 경계/리스트-인덱싱 가정 위반)이라 기계적이지만, 단순히 가드를 추가하는 게 아니라 "x의 attrs"라는 *의도된 의미*를 위치 기반 `attrs[1]` 대신 `getattr(x, "attrs", {})`로 재합성해야 해서 S2 보조가 붙는다. 클로저가 `x`를 캡처하는 게 올바른 일반화다.
- **K (Knowledge) = K-Domain.** `apply_ufunc`의 `keep_attrs` 콜백이 받는 `attrs`가 "DataArray 인자별 attrs의 리스트(스칼라는 제외)"라는 xarray 내부 계약을 알아야 `attrs[1]`이 왜 깨지는지·왜 `x`를 직접 봐야 하는지 판단할 수 있다.
- **Primary = T-DirectMap.** 위치가 명확하고(L0) 픽스가 한 줄 기계적 치환(S1)이라 T-DirectMap. 다만 올바른 표현식 합성에 도메인 이해가 필요해 순수 T-LocTrivial은 아니다. APR 관점: 이슈가 사실상 픽스 지점을 명세하므로 template-match(잘못된 인덱싱 → 안전한 접근)에 가깝고, generate-&-validate 반복이 불필요하다.

## 난이도 티어

**T2 (쉬움).** 구조적 피처: 파일 1개, 실효 변경 1줄(헌크는 빈 줄 정리 포함 ~3줄), localize 직접성 최상(L0, has-repro), 도메인 추론은 가볍다(스칼라 인자가 attrs 리스트에 빠진다는 한 단계). 공식 라벨 `<15 min fix`와 정합한다 — 빠른 개발자 픽스. T1로 더 내리지 않은 이유: 픽스가 단순 `None` 가드나 try/except가 아니라 `attrs[1]`의 *의도*를 이해하고 `getattr(x, ...)`로 치환하는 한 단계 의미 추론이 필요하고, P2P가 247개로 넓어 `where`/`keep_attrs` 전략 회귀를 안 깨야 하는 regression-trap이 약하게 존재하기 때문이다.

## 골드패치 분석

- **파일·함수:** `xarray/core/computation.py`의 `where(cond, x, y, keep_attrs=None)`.
- **근본원인:** `keep_attrs is True` 분기에서 콜백을 `lambda attrs, context: attrs[1]`로 정의한다. 이는 "두 번째 인자(x)의 attrs를 보존"하려는 것이지만, `attrs`는 `apply_ufunc`가 모은 *xarray 객체 인자들의* attrs 리스트라 스칼라 인자(`1`, `0`)는 항목을 만들지 않는다. 따라서 `cond` 하나만 리스트에 들어가 `attrs`의 길이가 1이 되고 `attrs[1]`이 `IndexError`.
- **수정요지:** 위치 기반 인덱싱을 버리고 클로저로 `x`를 직접 캡처: `keep_attrs = lambda attrs, context: getattr(x, "attrs", {})`. `x`가 attrs를 가지면 그 dict를, 스칼라면 `{}`를 반환한다.

## 검증 (test_patch)

FAIL_TO_PASS 1개: `test_where_attrs`. 추가된 단언은 `actual = xr.where(cond, 1, 0, keep_attrs=True)` 후 `actual.attrs == {}`. 베이스에서는 `attrs[1]`이 `IndexError`로 죽어 테스트가 에러로 실패하고, 픽스 후에는 스칼라 `x=1`이 `getattr(1, "attrs", {}) == {}`를 반환해 결과 attrs가 빈 dict가 되어 통과한다. 같은 테스트의 기존 단언(`x`가 DataArray일 때 그 attrs 보존)도 `getattr(x,"attrs",{})`가 `x.attrs`를 그대로 돌려주므로 유지된다 — 즉 한 테스트가 스칼라·객체 두 경로를 모두 잡는다. overfit 관점: 픽스가 테스트의 특정 입력(`1`)이 아니라 "x의 attrs를 안전 추출"이라는 일반 규칙이므로 special-case가 아니다. regression 관점: P2P 247개 중 `test_where`, `test_keep_attrs`, `test_keep_attrs_strategies_*`가 인접 — `attrs[1]`이 우연히 맞던 케이스(둘 다 객체일 때 두 번째가 x)를 `getattr(x,...)`가 동일하게 보존하므로 깨지 않는다.

## 모범답안 (오라클 기반)

1. **localize:** 이슈의 스택트레이스가 `computation.py` `where()`의 `keep_attrs = lambda attrs, context: attrs[1]`를 직접 지목 → 추가 탐색 없이 그 줄로 직행. `IndexError: list index out of range`는 `attrs`가 기대보다 짧다는 신호.
2. **픽스:** 주석("keep the attributes of x, the second parameter")이 *의도*를 명시한다 — 보존 대상은 x의 attrs. 위치 인덱스 `attrs[1]`은 "객체 인자가 cond·x·y 순서로 다 들어온다"는 깨지기 쉬운 가정에 의존하므로, 의도를 직접 표현하는 `getattr(x, "attrs", {})`로 치환한다. 스칼라/배열/Dataset 무관하게 동작하므로 올바른 일반화다(특정 입력 회피 코드 아님).
3. **regression 안전:** `x`가 attrs 있는 DataArray인 기존 케이스에서 `getattr`은 `x.attrs`를 그대로 반환 → `test_where_attrs` 기존 단언과 `test_keep_attrs_strategies_*` 247-P2P 전부 유지. 위치-인덱싱이 우연히 맞던 모든 케이스를 의미-기반 접근이 상위호환한다.
4. **함정 회피:** 오라클 없는 에이전트가 흔히 빠지는 길 — (a) `attrs[1]`을 `attrs[-1]`/`attrs[0]`으로 바꾸거나 `if len(attrs)>1` 가드만 추가하면 스칼라일 때 잘못된 attrs(예: cond의 attrs)를 보존하거나 빈 dict를 못 만들어 *의미*가 틀린다 — 테스트 에러는 막아도 의도 위반. (b) try/except로 IndexError를 삼키면 스칼라일 때 `keep_attrs` 동작이 미정의. 정답은 위치 가정 자체를 폐기하고 `x`를 클로저로 캡처하는 것. 주석을 읽으면 이 결정이 곧장 나온다.
