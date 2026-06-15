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
---

# django__django-14792

## 문제 요약
Django 3.2부터 `Trunc()`/`Extract()` DB 함수에서 `"Etc/GMT-10"` 같은 고정 오프셋 타임존을 쓰면 결과 쿼리의 타임존 방향이 뒤집힌다. 3.1에서는 `_get_timezone_name(pytz.timezone("Etc/GMT-10"))`가 `'+10'`을 반환해 Postgres에서 `AT TIME ZONE '-10'`(UTC 동쪽 10시간)로 올바르게 변환됐지만, 3.2에서는 `'Etc/GMT-10'`을 반환해 `_prepare_tzname_delta()`가 부호를 반전시킨 `'Etc/GMT+10'`(UTC 서쪽 10시간, 정반대)을 만든다. 사용자는 3.1과 동일한 오프셋 변환을 기대했다.

## 유형 분류
- 버그 카테고리: regression (커밋 10d1261984에서 도입)
- 서브시스템: django.utils.timezone 헬퍼 / ORM Trunc·Extract DB 함수
- 증상 타입: silent-wrong (예외 없이 잘못된 SQL 생성 → 시간대 부호 반전)
- 로컬라이제이션 신호: problem_statement가 `timezone._get_timezone_name()`을 명시적으로 지목하고, regression 커밋 해시까지 hints에 포함. `TimezoneMixin.get_tzname()` → `_get_timezone_name()` 호출 체인이 그대로 골드 파일로 직결.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/timezone.py:_get_timezone_name`
- 근본 원인: regression 이전엔 pytz `tzname()`이 고정 오프셋에 대해 `'+10'`을 줬는데, 3.2 리팩터에서 `_get_timezone_name`이 단순히 `str(timezone)`만 반환하도록 바뀌었다. `str(pytz.timezone("Etc/GMT-10"))`는 `'Etc/GMT-10'`이라 오프셋이 아닌 IANA 이름이 흘러가고, 이후 `_prepare_tzname_delta()`가 그 이름 안의 부호를 반전시키며 방향이 뒤집힘.
- 수정 요지: `return str(timezone)` 한 줄을 `return timezone.tzname(None) or str(timezone)`로 교체. 고정 오프셋 타임존은 `tzname(None)`이 `'+10'` 같은 오프셋 문자열을 주므로 그걸 우선 사용하고, `tzname(None)`이 `None`/빈 값인 명명 타임존(`Europe/Madrid` 등)만 기존대로 `str()` 이름으로 폴백.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: 신규 `test_get_timezone_name`이 `_get_timezone_name`의 반환값을 4(또는 zoneinfo 포함 6)가지 케이스로 검증.
- 테스트가 어떻게 픽스를 증명하는지: `datetime.timezone(timedelta(hours=10))` → `'UTC+10:00'`, `name='Etc/GMT-10'` 지정 시 → `'Etc/GMT-10'`, `pytz.timezone('Europe/Madrid')` → `'Europe/Madrid'`(명명), 그리고 핵심인 `pytz.timezone('Etc/GMT-10')` → `'+10'`(고정 오프셋). zoneinfo `Etc/GMT-10`도 `'+10'`. `str()`만 쓰던 구버전이면 `'Etc/GMT-10'`을 돌려줘 마지막 케이스에서 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 함수명과 regression 커밋을 직접 주므로 `django/utils/timezone.py`의 `_get_timezone_name` 단 한 곳. 거의 localization 불필요.
- 함정/난이도 메모: `tzname(None) or str(timezone)`에서 `or` 폴백이 핵심. 명명 타임존(`Europe/Madrid`)은 `tzname(None)`이 DST/시점 의존이라 `None`을 줄 수 있어 `str()` 폴백으로 이름을 보존해야 함 — `tzname(None)`만 쓰면 명명 타임존이 깨진다. 부호 반전 자체는 `_prepare_tzname_delta()`(별도 파일)에 있지만 골드는 그걸 건드리지 않고 입력 형식만 3.1과 맞춤(단일 파일 수정).
- 우리 에이전트 관점: 막힐 지점은 두 가지. (1) `_prepare_tzname_delta`의 부호 반전을 "버그"로 오인해 backend 파일을 고치려 들면 멀티 백엔드(Postgres/MySQL/Oracle)로 발산함 — 실제 수정은 입력 정규화 한 곳. (2) `tzname(None)`만 반환하고 `or str(timezone)` 폴백을 빼면 PASS_TO_PASS의 명명 타임존 케이스가 깨진다. regression 임을 인지하고 3.1 동작 복원 관점으로 접근해야 최소 diff에 도달.
