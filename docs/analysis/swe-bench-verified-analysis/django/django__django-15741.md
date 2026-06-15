---
instance_id: django__django-15741
repo: django/django
base_commit: 8c0886b068ba4e224dd78104b93c9638b860b398
version: 4.2
difficulty: <15 min fix
created_at: 2022-05-28T09:52:42Z
fail_to_pass: 2
pass_to_pass: 104
gold_files: [django/utils/formats.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15741

## 문제 요약
`django.utils.formats.get_format`이 lazy string(예: `gettext_lazy("DATE_FORMAT")`, 템플릿의 `some_date|date:_('Y-m-d')`)을 `format_type`으로 받으면 `TypeError: getattr(): attribute name must be string`로 죽는다. lazy 번역 객체(`__proxy__`)는 str의 subclass가 아니므로 `getattr(module, format_type)`의 attribute name 타입 검사에 걸린다. 이전 커밋 659d2421c7adb(#20296 수정)이 format_type 정규화 경로를 없애면서 발생한 회귀다. 사용자는 lazy 문자열도 일반 str처럼 동작하길 기대한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `django.utils.formats.get_format`을 모듈경로까지 명시하고, 회귀 유발 커밋 해시(#20296)와 `getattr()` TypeError 메시지를 직접 지목한다. grep 한 방으로 `formats.py:get_format`에 도달. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조)**: 결함클래스가 "lazy proxy를 str로 강제하지 않음"이라는 정형 패턴(타입강제/coercion)에 템플릿 매칭된다. 픽스는 `format_type = str(format_type)` 한 줄 추가 — 기계적이다. 다만 *어느 라인에* 넣느냐(cache_key 생성 *전*)는 캐시 일관성 불변식을 따져야 해서 순수 기계적이지 않고 약한 제약추론(S2)이 섞인다. getattr 직전에만 넣으면 cache_key에 lazy 객체가 남아 캐시 일치 의미가 깨질 수 있으므로, dominant는 S1이되 올바른 삽입 위치 판단은 S2 성격.
- **K (Knowledge) = K-Domain**: django i18n의 lazy/`__proxy__`(`gettext_lazy` 지연평가) 메커니즘과 `get_format`이 cache_key + `getattr(module, ...)` 두 군데서 format_type을 쓴다는 내부 구조 지식이 병목. 일반 파이썬 추론만으론 "왜 str()을 cache_key 앞에" 결론을 못 낸다.
- **primary type = T-DirectMap**: 위치가 L0로 명확하고 픽스가 S1 타입강제(coercion guard)라 정의에 정확히 부합. T-LocTrivial이 아닌 이유는 K-Domain 의존(lazy 개념)이 자명함을 약간 깎기 때문. T-ConstraintReason도 아님 — 추론이 식 합성이 아니라 삽입 위치 한정.

## 난이도 티어
**T2 (쉬움)**. 이 티어로 미는 구조적 피처:
- 파일 1개(`django/utils/formats.py`), 함수 1개(`get_format`), 순수 추가 +1줄. ICLR 2024 컷에서 1파일·<5줄은 ≈48% solve 구간 → 하단 난이도.
- **has-repro**: 네이티브 TypeError 메시지 + 정확한 모듈경로 + 회귀 커밋 해시까지 명시 → 가장 강한 easiness 신호(repro 동반 해결률 ~87%).
- L0 + S1로 localize·픽스 모두 직접적.
- T1로 내리지 않는 이유: (a) lazy/`__proxy__` 도메인 개념 이해가 필요(K-Domain), (b) 삽입 위치를 cache_key 앞으로 정확히 잡아야 하는 약한 제약(S2), (c) **regression-trap** — PASS_TO_PASS 104개가 i18n/formats/date-filter 인접 동작을 광범위하게 커버하므로 비-lazy 경로를 한 글자도 안 깨야 함. 이 P2P 폭이 "픽스가 기존 일반 str 경로에 부작용 없음"을 강제한다.
- 공식 라벨 `<15 min fix`와 일치(개발자 구현시간 기준). 에이전트 관점에서도 L0·has-repro라 T2로 수렴 — 라벨과 어긋나지 않음. 단 공식 시간라벨이 못 잡는 regression-trap(P2P 104)이 있어 T1까진 내리지 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/utils/formats.py` 의 `get_format(format_type, lang=None, use_l10n=None)`.
- **근본 원인**: `get_format`은 `format_type`을 (1) `cache_key = (format_type, lang)` 캐시 키와 (2) 하위 `getattr(module, format_type)` locale 모듈 속성 조회에 사용한다. lazy 번역 객체(`__proxy__`)는 str이 아니므로 `getattr`의 attribute name 타입 검사에서 `TypeError: getattr(): attribute name must be string`을 던진다. #20296(659d2421c7adb) 수정 과정에서 format_type을 str로 정규화하던 경로가 사라져 lazy 입력이 그대로 흘러들어가는 회귀가 생겼다.
- **수정 요지**: `use_l10n`/`lang` 결정 직후, `cache_key` 생성 *직전*에
  ```python
  format_type = str(format_type)  # format_type may be lazy.
  ```
  한 줄을 추가. lazy proxy를 즉시 평가·문자열화하여 이후 cache_key와 getattr가 모두 정상 str을 받게 한다. cache_key 앞에 두는 것이 핵심 — 캐시 키도 정규화된 str로 일관되게 만들어 동일 포맷에 대한 캐시 hit이 깨지지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개) 동작**:
  - `i18n.tests.FormattingTests.test_get_format_lazy_format`: `get_format(gettext_lazy("DATE_FORMAT"))`이 `"N j, Y"`를 반환해야 함. lazy 객체를 직접 인자로 — 재현 입력.
  - `template_tests.filter_tests.test_date.DateTests.test_date_lazy`: 템플릿 `{{ t|date:_("H:i") }}`가 `time(0,0)`에 대해 `"00:00"`을 출력. date 필터를 경유한 lazy 포맷 경로.
- **픽스 증명**: 두 테스트 모두 픽스 전이면 `str()` 변환이 없어 `get_format` 내부 `getattr`에서 TypeError로 죽는다. `str(format_type)` 추가 후 lazy proxy가 `"DATE_FORMAT"`/`"H:i"`로 평가되어 정상 locale 조회 → 기대 출력(`"N j, Y"`, `"00:00"`)이 나온다. 한 테스트는 API 직접 호출, 다른 하나는 템플릿 필터 end-to-end라 두 진입점을 모두 커버.
- **overfit 관점**: `str(format_type)`는 special-case가 아니라 모든 입력에 대한 보편적 정규화 — lazy뿐 아니라 어떤 비-str 인자도 안전하게 흡수하므로 FAIL_TO_PASS 2개에 과적합되지 않는 올바른 일반화. 픽스가 입력 도메인 전체를 덮는다.
- **regression 관점**: 일반 str `format_type`에 `str(s)`는 항등(동일 str 반환)이라 기존 비-lazy 경로는 byte-identical. PASS_TO_PASS 104개(i18n 포맷팅·언어해석·date 필터 test_date01~09·`test_all_format_strings` 등)가 이를 보증한다. cache_key를 정규화 *후* 만드므로 캐시 동작도 불변.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `TypeError: getattr(): attribute name must be string in django.utils.formats.get_format`을 명시 → 곧장 `django/utils/formats.py`의 `get_format`을 연다. 증상이 `date` 템플릿 필터에서 보인다는 미끼에 끌려 `template/defaultfilters.py`로 가지 말 것 — 스택의 실제 throw 지점은 그 아래 `get_format`이다. `getattr(module, format_type)` 라인이 범인.
2. **픽스와 일반화 정당성**: `format_type`이 lazy proxy일 수 있음을 인지하고 `str(format_type)`로 강제 평가. 이는 lazy에만 듣는 hack이 아니라 "format_type은 str이어야 한다"는 사전조건을 진입부에서 보편적으로 보장하는 정규화라 overfit이 아니다. 삽입 위치는 `cache_key = (format_type, lang)` *직전* — 그래야 캐시 키까지 정규화되어 같은 포맷의 lazy/eager 호출이 동일 캐시 엔트리를 공유한다.
3. **regression 안전**: PASS_TO_PASS 104개가 비-lazy str 포맷 조회 전반(`test_get_custom_format`, `test_all_format_strings`, date 필터 01~09 등)을 덮는다. `str(이미_str)`은 항등이므로 이 경로들은 불변이어야 하고 실제로 불변. cache_key를 변환 후 생성하므로 캐시 hit/miss 의미도 보존 — 변환을 getattr 직전으로 미루면 cache_key에 lazy 객체가 남아 캐시 일관성 회귀 위험.
4. **함정 회피**: 오라클 없는 에이전트의 전형 오류 — (a) date 필터에서 증상이 보인다고 필터 파서를 고치는 헛다리, (b) `str()`를 `getattr` 한 줄 직전에만 넣어 cache_key 정규화를 빠뜨림(미묘한 캐시 키 불일치 잔존), (c) `isinstance(format_type, Promise)` 같은 과한 lazy 특수분기 도입(불필요·취약; `str()` 한 방이면 충분). 핵심은 lazy/`__proxy__` 개념을 이해하고 *진입부 보편 정규화*로 근본을 잡는 것.
