---
instance_id: django__django-13363
repo: django/django
base_commit: 76e0151ea0e0f56dca66cee846a78b89346d2c4c
version: 3.2
difficulty: <15 min fix
created_at: 2020-08-29T18:59:41Z
fail_to_pass: 1
pass_to_pass: 76
gold_files: [django/db/models/functions/datetime.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-13363

## 문제 요약
`TruncDate`와 `TruncTime`은 `TimeZone` 믹스인을 포함한 `TruncBase`를 상속하므로 `tzinfo` 인자를 받을 수 있어야 한다. 그러나 두 클래스의 `as_sql()`이 부모를 호출하지 않고 자체 구현하면서, 전달된 `tzinfo`를 무시하고 무조건 `timezone.get_current_timezone_name()`만 사용한다. 그 결과 글로벌 Django 타임존이 아닌 다른 타임존(예: 앱은 UTC, 쿼리는 "America/New_York")으로 날짜 집계가 불가능하다. 사용자는 `TruncDate("start_at", tzinfo=tz)`가 전달한 tz를 반영하길 기대했으나, silent하게 잘못된 집계 결과가 나온다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일·라인(`datetime.py#L295`)과 "기대했던 메서드"(L17의 `get_tzname`)까지 직접 명시한다. "TruncDate inherits from TruncBase / TimeZone mixin", "uses get_current_timezone_name() unconditionally and completely discards the passed in timezone"가 정확히 두 심볼(`TruncDate.as_sql`, `TruncTime.as_sql`)을 지목 — grep 한 방. hints에서도 "TruncDate and TruncTime override as_sql and don't call super"로 근본원인을 못박는다.
- **S (Strategy) = S1 (Direct-Map) +S2 보조**: dominant는 S1 — 픽스가 사실상 명세되어 있다. 하드코딩된 표현식 `timezone.get_current_timezone_name() if settings.USE_TZ else None`을 믹스인이 이미 제공하는 `self.get_tzname()` 호출로 치환하는 기계적 매핑이며, 이슈가 교체 대상 메서드까지 알려준다. S2 보조인 이유: 단순 None-가드/상수변경이 아니라, 교체 대상이 `tzinfo` 우선 + `USE_TZ` 폴백이라는 **불변식을 정확히 보존하는 헬퍼**여야 함을 추론해야 한다(아무 tz 표현식이나 박으면 비-tz 경로가 깨짐). 즉 "올바른 식을 직접 재합성"이 아니라 "올바른 기존 헬퍼를 선택"하는 가벼운 제약추론.
- **K (Knowledge) = K-Domain**: django ORM의 `Trunc`/`Extract` 함수 계층, `TimeZone` 믹스인의 `get_tzname()` 계약, `connection.ops.datetime_cast_date_sql` 경로를 이해해야 한다. 일반 파이썬 추론만으론 "왜 super를 안 부르고도 폴백이 보존되는가"를 판단 불가.
- **primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 치환이므로 T-DirectMap. T-LocTrivial이 아닌 이유는 픽스가 완전 자명한 한 줄 None-가드가 아니라 도메인 헬퍼 선택을 동반(K-Domain)하기 때문이고, T-ConstraintReason이 아닌 이유는 식을 새로 합성하는 게 아니라 기존 헬퍼로 매핑하기 때문이다.

왜 S1인가 (APR 관점): 결함이 정형 클래스 — "서브클래스가 super 우회로 믹스인 계약을 silent하게 무효화" — 에 속하고, 정답 변환이 "하드코딩 분기 → 계약을 캡슐화한 헬퍼 호출"이라는 PAR/TBar식 템플릿(method-substitution)에 정확히 매칭된다. 이슈 본문이 교체 소스(L295)와 타겟(L17 `get_tzname`)을 둘 다 줘서 generate-&-validate 탐색이 거의 불필요하다.

## 난이도 티어
**Tier = T2 (쉬움)**. 공식 라벨도 `<15 min fix`로 일치한다.

이 티어로 미는 구조적 피처:
- **단일 파일, 2헌크, 각 1줄 치환** (`gold_files` = `datetime.py` 한 개). 구조컷상 1파일·극소줄 → solve ~48% 구간.
- **L0 직접 localize**: 이슈가 파일·라인·타겟 메서드를 모두 줌 — localize 실패 위험 거의 0.
- **K-Domain·cross-file-dep**가 T1으로 떨어지는 걸 막는다: 픽스가 같은 파일 상단(L17)의 `TimeZone.get_tzname()` 정의에 의존하므로, 그 헬퍼의 동작(`self.tzinfo` 우선, 없으면 현재 tz, `USE_TZ=False`면 None)을 확인하지 않으면 잘못 재구현할 수 있다. 순수 K-Gen 한 줄짜리(T1)는 아니다.
- **regression-trap (넓은 P2P)**: PASS_TO_PASS 76개 중 다수가 `test_trunc_date_func`, `test_trunc_time_func`, `test_trunc_date_none` 등 **비-tz 경로**다. 치환된 헬퍼가 `USE_TZ=False`/tzinfo 미전달 케이스에서 기존과 동일하게 동작해야 한다. P2P가 두텁다는 점이 T1이 아닌 T2로 올린다.
- `has-repro` 없음(네이티브 스택트레이스 아님, 동작 설명형 이슈)이라 T1 최저점은 아님.

공식 `<15 min fix`와 동일하므로 재조정 없음 — 다만 시간라벨이 못 잡는 regression-trap·cross-file-dep을 명시적으로 반영해 T1이 아닌 T2로 둔다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/functions/datetime.py` — `TruncDate.as_sql`, `TruncTime.as_sql` (각 1줄, 총 2헌크).
- **근본 원인**: 두 `as_sql`이 `tzname = timezone.get_current_timezone_name() if settings.USE_TZ else None`을 하드코딩해, 인스턴스에 저장된 `self.tzinfo`를 전혀 반영하지 않는다. `TruncBase`가 포함한 `TimeZone` 믹스인은 `get_tzname()` 헬퍼로 "`self.tzinfo`가 있으면 그것, 없고 `USE_TZ`면 현재 타임존, 아니면 None"을 이미 캡슐화하는데, 두 서브클래스가 `super().as_sql()`을 호출하지 않고 자체 구현하면서 이 헬퍼를 우회했다(silent contract violation).
- **수정 요지**: 두 곳 모두 하드코딩 표현식을 `tzname = self.get_tzname()` 한 줄로 교체. `USE_TZ` 분기와 현재 타임존 폴백 로직이 믹스인 헬퍼 안으로 통합되고, 전달된 `tzinfo`가 우선 적용된다. 이후 `connection.ops.datetime_cast_date_sql(lhs, tzname)` / `datetime_cast_time_sql(lhs, tzname)` 호출 라인은 그대로 — 변경은 tzname 산출 방식뿐.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_trunc_timezone_applied_before_truncation` (`DateFunctionWithTimeZoneTests`). 기존엔 `TruncYear`만 melb/pacific `tzinfo`로 검증하던 테스트에 `TruncDate`/`TruncTime`을 melb·pacific `tzinfo`로 annotate하는 4개 케이스(`melb_date`, `pacific_date`, `melb_time`, `pacific_time`)가 추가된다.
- **픽스 증명**: 동일 `start_datetime`을 `astimezone(melb)`/`astimezone(pacific)`으로 변환한 뒤 `.date()`/`.time()`을 DB 결과와 직접 비교한다. 패치 전엔 전달 tzinfo가 무시되어 글로벌 tz 기준 값이 나와 `melb_date != pacific_date` 기대가 깨지고, 패치 후엔 각 tz별로 올바른 날짜·시간이 산출되어 통과. 즉 두 tz가 날짜 경계를 다르게 가르는 동일 순간을 골라(melb=다음날, pacific=전날) tzinfo 적용 여부를 분별하는 강한 단언이다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 두 개의 서로 다른 tz(melb/pacific)를 **paired-control**로 비교하고 date·time 양쪽을 보므로, "한 tz로만 우연히 통과"하는 special-case 픽스는 거를 수 있다. `tzname`을 무조건 None으로 두는 식의 우회로는 melb/pacific 차이를 못 내 즉시 실패. overfit-risk 플래그를 달지 않은 근거.
- **regression 관점**: PASS_TO_PASS 76개가 비-tz 경로(`test_trunc_date_func`/`test_trunc_time_func`/`*_none`)와 Extract 계열을 광범위하게 커버. `get_tzname()`이 tzinfo 미전달·`USE_TZ=False`에서 기존과 동일하게 동작하지 않으면 다수 깨지므로, 헬퍼 재사용이 회귀안전을 보장한다(regression-trap 플래그의 실체).

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `datetime.py#L295`와 기대 메서드 `#L17 get_tzname`을 직접 준다. → `django/db/models/functions/datetime.py`를 열어 `class TruncDate(TruncBase)`와 `class TruncTime(TruncBase)`의 `as_sql`을 찾고, 파일 상단의 `TimeZone` 믹스인에서 `get_tzname()` 정의를 확인한다. hints의 "override as_sql and don't call super"가 두 곳 모두 손봐야 함을 못박는다.
2. **픽스와 올바른 일반화**: 두 `as_sql`의 `tzname = timezone.get_current_timezone_name() if settings.USE_TZ else None`을 `tzname = self.get_tzname()`으로 치환. 이게 올바른 일반화인 이유 — `get_tzname()`은 `self.tzinfo` 우선·현재 tz 폴백·비-USE_TZ None을 모두 캡슐화한 **믹스인의 단일 계약**이라, 이걸 호출하면 tzinfo 케이스와 기존 글로벌 케이스가 한 경로로 정확히 통합된다. `as_sql` 안에 `self.tzinfo` 분기를 손으로 재구현하는 건 폴백 로직 중복·드리프트 위험이라 열등하다.
3. **regression 안전**: 비-tz 경로 P2P(`test_trunc_date_func`, `test_trunc_time_func`, `test_trunc_date_none`, `test_trunc_time_none` 등)를 안 깨야 한다. `get_tzname()`은 tzinfo 미전달 시 정확히 종전 표현식과 동치인 값(`USE_TZ`면 현재 tz명, 아니면 None)을 돌려주므로 비-tz 동작이 보존된다 — 그래서 단순 치환이 안전.
4. **함정 회피**: (a) **TruncTime 누락** — `TruncDate`만 고치고 `TruncTime`을 빠뜨리면 FAIL_TO_PASS의 `melb_time`/`pacific_time` 단언이 깨진다. 두 클래스 동시 수정 필수. (b) **헬퍼 미확인 재구현** — `get_tzname()` 존재를 확인 안 하고 `as_sql` 안에 `self.tzinfo or timezone.get_current_timezone_name()`식 분기를 직접 박으면 `USE_TZ=False` 폴백(None)을 빠뜨려 비-tz P2P가 깨진다. (c) **TruncBase as_sql만 손대기** — hints가 경고하듯 두 서브클래스가 super를 안 부르므로 부모만 고치면 무효. 오라클 없는 에이전트는 (a)/(b)에서 가장 잘 틀린다 — 믹스인 헬퍼 재사용 + 두 클래스 동시 치환이 최소·정답 경로다.
