---
instance_id: django__django-14792
repo: django/django
base_commit: d89f976bddb49fb168334960acc8979c3de991fa
version: "4.0"
difficulty: "<15 min fix"
created_at: 2021-08-24T09:25:15Z
fail_to_pass: 2
pass_to_pass: 23
gold_files: [django/utils/timezone.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14792

## 문제 요약
Django 3.2부터 `Trunc()`/`Extract()` DB 함수에서 `"Etc/GMT-10"` 같은 고정 오프셋 타임존을 쓰면 결과 쿼리의 타임존 방향이 뒤집힌다. 3.1에서는 `_get_timezone_name(pytz.timezone("Etc/GMT-10"))`가 `'+10'`을 반환해 Postgres에서 `AT TIME ZONE '-10'`(UTC 동쪽 10시간)로 올바르게 변환됐지만, 3.2에서는 `'Etc/GMT-10'`을 반환해 `_prepare_tzname_delta()`가 부호를 반전시킨 `'Etc/GMT+10'`(UTC 서쪽 10시간, 정반대)을 만든다. 사용자는 3.1과 동일한 오프셋 변환을 기대했고, hints는 regression 커밋(`10d126198434810529e0220b0c6896ed64ca0e88`)까지 지목한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `timezone._get_timezone_name()`을 함수명으로 직접 지목하고, regression 커밋 해시·`TimezoneMixin.get_tzname()` 호출 체인까지 본문에 박혀 있다. grep 한 방으로 `django/utils/timezone.py`의 단일 함수에 도달. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 고칠 지점은 자명하지만(`return str(timezone)` 한 줄), *올바른 식을 추론으로 합성*해야 한다. 단순히 `tzname(None)`만 쓰면 명명 타임존이 깨지고, `str()`만 두면 버그가 그대로다. 정답인 `timezone.tzname(None) or str(timezone)`는 "고정 오프셋은 오프셋 문자열, 명명 타임존은 IANA 이름"이라는 두 케이스를 동시에 만족하는 불변식을 따져 도출해야 한다. 보조로 S5: 무엇이 "올바른 반환값"인지가 코드만으로는 안 나오고, 3.1 동작(`'+10'`)과 다운스트림 `_prepare_tzname_delta()` 계약에서 스펙을 역으로 재구성해야 한다. 후보를 무작정 던지는 G&V가 아니라 의미 추론으로 푸는 문제라 S2가 dominant.
- **K (Knowledge) = K-Domain.** pytz/zoneinfo의 `tzname(None)` 의미론(고정 오프셋엔 `'+10'`, 명명 타임존엔 시점 의존 DST명/`None`)과 django ORM Trunc·`_prepare_tzname_delta`의 부호 반전 계약을 알아야 한다. 일반 파이썬 추론(K-Gen)만으론 왜 `or str()` 폴백이 필요한지 못 짚는다.
- **Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 픽스가 기계적 가드/상수 교체(S1)가 아니라 두 타임존 클래스의 불변식을 만족하는 식을 추론·합성하는 것이라, T-DirectMap이 아닌 T-ConstraintReason. "찾으면 끝"이 아니라 "찾고 나서 올바른 일반화를 생각해내야" 하는 게 본질.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(시간상 T1~T2 prior)지만 구조적 피처로 T3로 올린다.
- T1/T2를 막는 요인: localize는 자명(L0, has-repro)하나 repair가 S1 템플릿이 아니다. `tzname(None) or str(timezone)`의 `or` 폴백을 빼면 명명 타임존이 깨지는 **regression-trap**이 P2P에 박혀 있어, "한 줄 바꾸면 끝"처럼 보이지만 잘못된 한 줄로 가기 쉽다.
- T4 이상은 아닌 이유: 1파일·실질 1줄·헌크 1개, cross-file 조율 없음(부호 반전은 다른 파일이지만 *건드리지 않는다*). P2P 23개가 광범위하나 대부분 인접 timezone 동작이라 정답 식이면 자동 보존됨 — 발산형 trap은 아니다.
- 결론: localize 직접성(L0)·소규모 patch는 쉬움을 가리키지만, S2 추론 요구 + 도메인지식(K-Domain) + 잘못된 부분픽스를 유도하는 함정 때문에 시간라벨보다 한 단계 위인 T3가 방어 가능. 공식 `<15 min`은 *오라클을 본 숙련 django 개발자* 기준이고, 에이전트 관점에선 폴백 추론과 백엔드 오판 회피가 추가 비용.

## 골드패치 분석
- **건드린 파일·함수:** `django/utils/timezone.py` 의 `_get_timezone_name(timezone)` 단일 함수(헌크 1개).
- **근본 원인:** regression 커밋 `10d1261984`의 리팩터에서 `_get_timezone_name`이 `return str(timezone)`로 단순화됐다. 3.1 이전엔 pytz `tzname()` 경로로 고정 오프셋에 대해 `'+10'`을 줬으나, `str(pytz.timezone("Etc/GMT-10"))`는 오프셋이 아닌 IANA 이름 `'Etc/GMT-10'`을 돌려준다. 이 이름이 그대로 Postgres `_prepare_tzname_delta()`로 흘러가 부호가 반전된 `'Etc/GMT+10'`이 되어 변환 방향이 정반대가 됨(MySQL도 `'-10'` vs `'-10:00'`로 영향, #33037).
- **수정 요지:** `return str(timezone)` → `return timezone.tzname(None) or str(timezone)`. 고정 오프셋 타임존은 `tzname(None)`이 `'+10'`/`'UTC+10:00'` 같은 오프셋 문자열을 반환하므로 그걸 우선 사용해 3.1 동작을 복원하고, `tzname(None)`이 `None`/빈 값인 명명 타임존(`Europe/Madrid`)만 `or` 폴백으로 기존 `str()` 이름을 보존. docstring도 "fixed offset이면 offset, 아니면 name"으로 의도를 명시하도록 갱신.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작:** 신규 `test_get_timezone_name`(파싱상 `"The _get_timezone_name() helper must return the offset for fixed offset"` 한 줄로 잡힘)과 회귀로 함께 도는 `test_is_aware`. 신규 테스트는 `_get_timezone_name`을 4가지(zoneinfo 있으면 6가지) 케이스 subTest로 검증한다.
- **픽스 증명:** `datetime.timezone(timedelta(hours=10))` → `'UTC+10:00'`, `name='Etc/GMT-10'` 지정 시 → `'Etc/GMT-10'`(명명), `pytz.timezone('Europe/Madrid')` → `'Europe/Madrid'`(명명), 그리고 핵심인 `pytz.timezone('Etc/GMT-10')` → `'+10'`(고정 오프셋), zoneinfo `Etc/GMT-10` → `'+10'`. 구버전 `return str(timezone)`이면 마지막 고정 오프셋 케이스가 `'Etc/GMT-10'`을 돌려 실패. 정답 식이면 고정 오프셋은 `tzname(None)` 오프셋을, 명명은 `or str()` 폴백 이름을 줘 전 케이스 통과.
- **overfit·regression 관점:** FAIL_TO_PASS가 고정 오프셋 *둘 다*(datetime.timezone + pytz/zoneinfo)와 명명 타임존 *둘 다*를 cover하므로 `tzname(None)`만 쓰는 부분픽스를 명시적으로 배제 — overfit 여유가 좁다. P2P 23개(`test_override_fixed_offset`, `test_fixedoffset_timedelta`, `test_make_aware_*` 등)가 인접 timezone 경로를 지키는 **regression-trap**: 정답 식이면 자동 보존되지만, `tzname(None)` 단독이면 명명 타임존 경로에서 깨진다. overfit-risk는 낮음(테스트가 두 클래스 모두 잡음), regression-trap이 실질 위험.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement가 `timezone._get_timezone_name()`을 명시하고 hints가 regression 커밋(`10d1261984`)을 줌 → `django/utils/timezone.py`의 `_get_timezone_name` 한 함수로 직행. 3.1 vs 3.2 반환값 대비(`'+10'` vs `'Etc/GMT-10'`)가 이미 본문에 있어 diff 지점이 박제됨. backend의 `_prepare_tzname_delta`는 *증상의 하류*일 뿐 수정 대상이 아님을 본문 인과("incorrectly becomes")에서 읽어야 한다.
2. **픽스와 일반화 근거:** `return str(timezone)`를 `return timezone.tzname(None) or str(timezone)`로. 이게 올바른 일반화인 이유 — 고정 오프셋 타임존(`datetime.timezone`, pytz/zoneinfo의 `Etc/GMT-*`)은 `tzname(None)`이 부호 포함 오프셋(`'+10'`)을 안정적으로 주고, 이는 다운스트림 `_prepare_tzname_delta`가 기대하는 3.1 입력 형식과 일치. 명명 타임존은 `tzname(None)`이 시점 의존(DST)이라 `None`을 줄 수 있으므로 `or str()`로 IANA 이름을 폴백 — 두 클래스 모두를 단일 식으로 만족. special-case 분기가 아니라 "오프셋 우선, 이름 폴백" 한 식이라 overfit이 아닌 구조적 일반화.
3. **regression 안전:** P2P의 `test_override_fixed_offset`, `test_fixedoffset_timedelta`, `test_fixedoffset_negative_timedelta`, `test_make_aware_*`(pytz/zoneinfo) 등 인접 timezone 동작을 안 깨야 한다. `or str(timezone)` 폴백이 명명 타임존 이름을 보존하므로 이 경로들이 그대로 통과. 부호 반전 로직을 backend에서 건드리지 않으므로 Postgres/MySQL/Oracle 전 백엔드 회귀를 피한다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 두 지점 — (1) `_prepare_tzname_delta`의 부호 반전을 "버그"로 오인해 backend 파일을 고치면 멀티 백엔드로 발산하고 입력 정규화라는 진짜 원인을 놓침. 본문이 "Django 3.1에선 올바르게 동작"이라 명시하므로 *regression 복원*(입력을 3.1 형식으로) 프레임으로 접근해야 단일 파일에 수렴. (2) `return timezone.tzname(None)`로 폴백을 빼면 명명 타임존(`Europe/Madrid`)이 `None`이 되어 P2P가 깨짐 — `or str()` 폴백이 필수임을 명명/고정 두 케이스 대비로 추론해야 한다.
