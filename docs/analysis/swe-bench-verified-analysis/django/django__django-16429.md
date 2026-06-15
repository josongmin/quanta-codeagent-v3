---
instance_id: django__django-16429
repo: django/django
base_commit: 6c86495bcee22eac19d7fb040b2988b830707cbd
version: 4.2
difficulty: <15 min fix
created_at: 2023-01-05T11:41:37Z
fail_to_pass: 4
pass_to_pass: 21
gold_files: [django/utils/timesince.py]
---

# django__django-16429

## 문제 요약
`USE_TZ=True` 환경에서 한 달 이상 과거의 datetime을 `timesince()`에 넘기면 `TypeError: can't subtract offset-naive and offset-aware datetimes`로 크래시한다. 사용자는 `"1 month"` 같은 정상 문자열을 기대했지만, 1개월 이상 간격일 때만 예외가 발생한다 (커밋 8d67e16에서 들어온 회귀). 원인은 월 단위 보정용 pivot datetime을 만들 때 원본의 tzinfo를 잃어버려 aware-naive 혼합 뺄셈이 일어나기 때문이다.

## 유형 분류
- 버그 카테고리: regression / edge-case (timezone-aware 입력 + ≥1개월 간격)
- 서브시스템: django.utils 시간 포맷팅 (timesince/timeuntil)
- 증상 타입: 예외 (TypeError, 크래시)
- 로컬라이제이션 신호: problem_statement이 정확한 파일/라인(`django/utils/timesince.py` L93-L100)과 회귀 커밋, 그리고 "pivot이 d.tzinfo를 반영 안 한다"는 진단까지 직접 명시 — 거의 핀포인트.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/timesince.py` : `timesince()` 내부 pivot `datetime.datetime(...)` 생성부
- 근본 원인: ≥1개월 차이일 때 코드가 `datetime.datetime(year, month, ..., d.second)`로 pivot을 새로 만드는데 `tzinfo` 인자를 빼먹어 naive datetime이 생성됨. 이후 `remaining_time = (now - pivot).total_seconds()`에서 aware인 `now`와 naive인 `pivot`을 빼다가 TypeError.
- 수정 요지: pivot 생성 인자에 `tzinfo=d.tzinfo` 한 줄을 추가. 이로써 원본 `d`가 aware면 pivot도 동일 tzinfo를 갖는 aware가 되어 뺄셈이 정상 동작. d가 naive면 tzinfo=None이 그대로 전파되어 기존 동작 보존.

## 검증 (test_patch)
- FAIL_TO_PASS: 새 `TZAwareTimesinceTests` 클래스(`@override_settings(USE_TZ=True)` + `@requires_tz_support`)가 기존 `TimesinceTests`를 상속해 모든 케이스를 aware datetime으로 재실행. 그 중 ≥1개월 경로를 타는 `test_depth`, `test_thousand_years_ago`, "Test other units." 등이 픽스 전엔 TypeError로 깨짐.
- 증명 방식: `setUp`에서 `self.t = timezone.make_aware(self.t, ...)`로 베이스 시각을 aware로 바꾼 뒤 그대로 부모 테스트들을 돌림. 또 `test_thousand_years_ago`는 하드코딩 naive 리터럴 대신 `self.t.replace(year=self.t.year - 1000)`로 바꿔 aware를 유지. 픽스 후엔 pivot도 aware라 뺄셈이 성공하고 `"1000 years"` 등 기대 출력이 나옴.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/utils/timesince.py`의 `timesince()` 단일 함수, pivot 분기(months 보정 경로). 문제 설명이 라인까지 줘서 localization은 거의 공짜.
- 함정/난이도: 버그가 ≥1개월 간격에서만 재현됨 — 짧은 간격으로 테스트하면 통과해서 "안 고쳐도 됨"으로 오판하기 쉽다(힌트 스레드에서도 메인테이너가 처음엔 재현 실패). 또 `timeuntil`도 같은 `timesince`를 타므로 별도 수정 불필요. naive 입력 회귀 방지(`tzinfo=None` 전파)를 깨지 않는 게 핵심.
- 우리 에이전트 관점: 한 줄 추가라 구현 난도는 낮지만, "USE_TZ 미설정 시 통과하는 가짜 그린"에 속아 fix를 과하게 키우거나(예: pivot 전체 분기 재작성) timeuntil 쪽까지 손대는 over-edit 위험이 있다. 재현엔 반드시 `override_settings(USE_TZ=True)` + ≥31일 간격이 필요함을 인지해야 함.
