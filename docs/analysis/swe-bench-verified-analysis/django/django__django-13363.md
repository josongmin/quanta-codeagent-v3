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
---

# django__django-13363

## 문제 요약
`TruncDate`와 `TruncTime`은 `TimeZone` 믹스인을 포함한 `TruncBase`를 상속하므로 `tzinfo` 인자를 받을 수 있어야 한다. 그러나 두 클래스의 `as_sql()`이 부모를 호출하지 않고 자체 구현하면서, 전달된 `tzinfo`를 무시하고 무조건 `timezone.get_current_timezone_name()`만 사용한다. 그 결과 글로벌 Django 타임존이 아닌 다른 타임존(예: 앱은 UTC, 쿼리는 "America/New_York")으로 날짜 집계가 불가능하다. 사용자는 `TruncDate("start_at", tzinfo=tz)`가 전달한 tz를 반영하길 기대했다.

## 유형 분류
- 버그 카테고리: API-contract (믹스인이 약속한 tzinfo 인자가 서브클래스에서 silent하게 무시됨)
- 서브시스템: django ORM database functions (`db.models.functions.datetime`)
- 증상 타입: silent-wrong (예외 없이 잘못된 날짜/시간 집계 결과)
- 로컬라이제이션 신호: problem_statement가 파일·라인(L295)과 기대 메서드(L17의 `get_tzname`)까지 직접 명시. "TruncDate inherits from TruncBase / TimeZone mixin", "uses get_current_timezone_name() unconditionally"가 정확한 위치를 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/functions/datetime.py` — `TruncDate.as_sql`, `TruncTime.as_sql`
- 근본 원인: 두 `as_sql`이 `tzname = timezone.get_current_timezone_name() if settings.USE_TZ else None`을 하드코딩해, 인스턴스에 저장된 `tzinfo`를 전혀 반영하지 않음. `TimeZone` 믹스인은 `get_tzname()` 헬퍼로 `self.tzinfo` 우선·없으면 현재 타임존으로 폴백하는 로직을 이미 제공하는데 이를 우회함.
- 수정 요지: 두 곳 모두 하드코딩된 표현식을 `tzname = self.get_tzname()` 한 줄로 교체. 이로써 `USE_TZ` 분기와 현재 타임존 폴백이 믹스인 헬퍼 안으로 통합되고, 전달된 `tzinfo`가 우선 적용된다. 이후 `connection.ops.datetime_cast_date_sql` / `datetime_cast_time_sql` 호출은 그대로.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_trunc_timezone_applied_before_truncation` (DateFunctionWithTimeZoneTests). 기존엔 `TruncYear`만 melb/pacific tz로 검증하던 테스트에, `TruncDate`/`TruncTime`을 melb·pacific `tzinfo`로 annotate하는 케이스가 추가됨.
- 증명 방식: 동일 `start_datetime`을 `astimezone(melb)`/`astimezone(pacific)`으로 변환한 뒤 `.date()`/`.time()`과 DB 결과를 비교. 패치 전엔 전달한 tzinfo가 무시되어 글로벌 tz 기준 값이 나와 melb≠pacific 기대가 깨지고, 패치 후엔 각 tz별로 올바른 날짜·시간이 나와 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일·라인·기대 메서드가 다 적혀 있어 거의 공짜. `db/models/functions/datetime.py`에서 `TruncDate`/`TruncTime`의 `as_sql`을 찾고, `TruncBase`/`TimeZone` 믹스인의 `get_tzname` 정의를 확인하면 끝.
- 함정/난이도: 두 클래스를 모두 고쳐야 함(TruncTime을 빠뜨리기 쉬움). 또 `get_tzname()`이 `USE_TZ=False`에서 `None`을 반환하는지 확인해야 회귀(PASS_TO_PASS의 `test_trunc_date_func` 등 비-tz 케이스)가 깨지지 않음 — 믹스인이 이미 처리하므로 단순 치환이 정답.
- 우리 에이전트 관점: 단서가 풍부해 막힐 여지는 적으나, `get_tzname` 헬퍼의 존재를 확인하지 않고 `as_sql` 안에 직접 `self.tzinfo` 분기를 재구현하면 USE_TZ 폴백 로직을 빠뜨려 비-tz 테스트가 깨질 수 있다. 믹스인 헬퍼 재사용이 골드와 일치하는 최소·정답 경로.
