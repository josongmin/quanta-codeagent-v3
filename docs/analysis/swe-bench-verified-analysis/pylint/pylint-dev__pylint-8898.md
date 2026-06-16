---
instance_id: pylint-dev__pylint-8898
repo: pylint-dev/pylint
base_commit: 1f8c4d9eb185c16a2c1d881c054f015e1c2eb334
version: "3.0"
difficulty: 1-4 hours
created_at: 2023-07-29T21:53:59Z
fail_to_pass: 1
pass_to_pass: 18
gold_files: [pylint/config/argument.py, pylint/utils/__init__.py, pylint/utils/utils.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약

`bad-names-rgxs`(및 동류 regex-csv 옵션)는 값을 콤마로 단순 분리해 정규식 리스트로 파싱한다. 그런데 정규식 수량자 `\d{1,2}` / `(foo{1,3})`처럼 정규식 문법 자체가 콤마를 쓰는 경우, 분리가 정규식 내부를 갈라버려 `(foo{1` 같은 깨진 조각이 되고 `re.compile`이 "missing ), unterminated subpattern"으로 즉시 크래시한다. 기대 동작은 임의의 유효 정규식을 이 옵션에 넣을 수 있는 것.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈에 네이티브 스택트레이스가 박혀 있어 `pylint/config/argument.py`의 `_regexp_csv_transfomer`까지 직접 지목된다. 다만 진짜 픽스 지점(콤마-분리 로직 신설)은 `pylint/utils/utils.py`로 한 단계 이동하므로 grep 한 방의 L0는 아님.
- **S2 (+S6)**: 고칠 위치는 명확하나, 핵심은 "수량자 `{m,n}` 안의 콤마는 분리자가 아니다"라는 **불변식을 코드로 합성**하는 것 — `{`에서 True, 열린 상태의 첫 `}`에서 False로 되는 boolean `open_braces` 플래그(중첩 깊이를 세는 카운터가 아님)로 "brace 열림" 여부를 추적하는 상태기계를 추론으로 짜야 한다(Generate-&-Validate로 후보를 던지는 게 아님). 새 헬퍼 `_check_regexp_csv`를 도입하고 transformer가 그것을 경유하게 배선하는 작은 구조 변경이 동반되어 S6 보조.
- **K-Gen**: pylint 도메인 지식이 아니라 정규식 수량자 문법 + 일반 파서 추론으로 충분.
- **primary = T-ConstraintReason**: 위치는 잡히지만 난점이 "올바른 분리 조건식의 합성"에 있다 — `T-DirectMap`(가드/상수)도 `T-DiffuseLoc`(어디 찾기)도 아니다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처: 골드가 3파일을 건드리지만 2개(`utils/__init__.py`의 import/`__all__` 재노출)는 기계적 배선이고 실질 로직은 `utils.py` 단 1함수(~25줄)다 → scope는 작다. `has-repro`(스택트레이스 완비)는 강한 easiness 신호. 그러나 콤마-수량자 분리를 정확히 푸는 brace-state 파싱은 단순 가드보다 추론 부담이 크고(T2/T3 초과), `regexp_csv` 동작을 바꾸므로 인접 csv 파싱 회귀를 안 깨야 한다. 공식 라벨 "1-4 hours"와 일치 — 로직은 작아도 엣지케이스(중첩/미닫힌 brace, 빈 토큰) 추론이 시간을 먹는다.

## 골드패치 분석

- **파일·함수**:
  - `pylint/utils/utils.py`: 신규 `_check_regexp_csv(value) -> Iterable[str]` 추가. `from collections import deque`, `Iterable` import 보강.
  - `pylint/utils/__init__.py`: `_check_regexp_csv`를 import 및 `__all__`에 재노출.
  - `pylint/config/argument.py`: `_regexp_csv_transfomer`가 기존 `_csv_transformer(value)` 대신 `pylint_utils._check_regexp_csv(value)`로 분리하도록 교체.
- **근본원인**: `_regexp_csv_transfomer`가 정규식-무지(naive) CSV 분리(`_csv_transformer`)를 써서 정규식 수량자 내부 콤마까지 토큰 경계로 취급 → 깨진 부분식 생성.
- **수정요지**: `_check_regexp_csv`는 `deque[deque|None]`로 토큰을 모으며 `open_braces` 플래그로 `{`…`}` 구간을 추적, **brace가 열려 있는 동안의 콤마는 분리하지 않는다**. list/tuple 입력은 그대로 `yield from`. 각 토큰은 `.strip()` 후 빈 것 제외하고 산출. 결과는 `_regex_transformer`로 개별 컴파일.

## 검증 (test_patch)

FAIL_TO_PASS는 `test_csv_regex_error` 1개. 이 테스트는 입력을 `(foo{1,} foo{1,3}})`로 바꾸고, 에러 메시지가 잘린 `(foo{1`이 아니라 수량자 콤마를 보존한 `(foo{1,}`을 가리키도록 기대치를 갱신 — 즉 "콤마가 더 이상 수량자를 자르지 않는다"를 음성 케이스로 증명한다. 신규 양성 케이스 `test_csv_regex_comma_in_quantifier`(`foo, bar{1,3}` → `["foo","bar{1,3}"]` 등)는 PASS_TO_PASS에 들어가 정상 분리와 수량자 보존을 함께 못박는다.

- **overfit 관점**: 양성/음성 케이스가 같이 있고(`foo,bar` 분리 + `bar{1,3}` 비분리 + 미닫힌 `(foo{1,}` 에러), special-case 하드코딩으론 통과 불가 → overfit-risk 낮음.
- **regression 관점**: 18개 PASS_TO_PASS 중 다수가 일반 config 파싱 테스트라 `regexp_csv` 변경이 csv 경로를 깨면 잡힌다(`regression-trap`).

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스 마지막 프레임 `argument.py:_regexp_csv_transfomer` → `re.compile`이 깨진 패턴을 받는 원인은 그 위 `_csv_transformer`의 콤마 분리. "정규식을 콤마로 자른다"가 핵심이므로 분리 로직을 정규식-인지(regex-aware)로 교체할 지점을 `utils.py`에 신설하는 것으로 수렴.
2. **픽스와 일반화**: 수량자는 `{m,n}` 형태로만 콤마를 쓴다는 정규식 문법 사실에서 "brace가 열린 동안 콤마는 분리자가 아니다"라는 불변식을 도출. `open_braces` 플래그 + 토큰 누적 deque로 상태기계를 구현하면 `foo, bar{1,3}`도, 미닫힌 `(foo{1,}`도 일관되게 처리 — 입력 특정 문자열이 아니라 brace 깊이라는 구조적 속성에 의존하므로 올바른 일반화.
3. **regression 안전**: list/tuple 입력은 `yield from value`로 기존과 동일하게 흘려보내고, brace 밖 콤마 분리·`.strip()`·빈 토큰 제거는 기존 csv 의미를 보존해야 한다. 그래야 `test_regex_error`/일반 config 파싱 PASS_TO_PASS 18개가 유지된다.
4. **함정 회피**: (a) `argument.py`에서 인라인으로 고치고 `utils` 재노출(`__init__.py` import + `__all__`)을 빠뜨리면 ImportError로 다른 surface가 깨진다 — 3파일 배선이 다 필요. (b) "콤마를 전부 분리 금지"로 과교정하면 `foo,bar` 정상 리스트가 깨져 PASS_TO_PASS 실패. (c) 닫는 `}` 없이 `open_braces`를 영구 true로 두면 그 뒤 모든 콤마를 삼키므로 `}` 매칭으로 닫아야 함. (d) 토큰을 `.strip()` 안 하면 `foo, bar`가 `" bar"`로 남아 패턴 불일치.
