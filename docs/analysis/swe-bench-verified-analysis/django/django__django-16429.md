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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-16429

## 문제 요약
`USE_TZ=True` 환경에서 한 달 이상 과거의 datetime을 `timesince()`에 넘기면 `TypeError: can't subtract offset-naive and offset-aware datetimes`로 크래시한다. 사용자는 `"1 month"` 같은 정상 문자열을 기대했지만, 1개월 이상 간격일 때만 예외가 발생한다(커밋 8d67e16에서 들어온 회귀). 근본 원인은 월 단위 보정용 pivot datetime을 새로 만들 때 원본의 `tzinfo`를 잃어버려 aware인 `now`와 naive인 `pivot` 사이의 혼합 뺄셈이 일어나기 때문이다. problem_statement에 정확한 파일/라인(`django/utils/timesince.py` L93–L100), 회귀 커밋 해시, 그리고 "pivot이 `d.tzinfo`를 반영 안 한다 → `0, d.tzinfo`를 추가하면 고쳐진다"는 진단·수정안까지 들어 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — 이슈 본문이 파일·함수·라인 범위(`timesince.py` L93–L100)와 회귀 커밋, 깨지는 표현식(`(now - pivot).total_seconds()`)까지 직접 지목. grep 한 방, 탐색 사실상 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)** — 이슈가 픽스를 사실상 명세한다("`tzinfo` 인자를 빼먹은 생성자에 `tzinfo=d.tzinfo`를 더해라"). 정형 결함클래스(생성자 인자 누락에 의한 tz-naive/aware 불일치)에 템플릿 매칭되는 기계적 한 줄 추가. 식·조건을 추론으로 합성(S2)할 필요 없음 — 누락된 인자가 무엇인지 코드·이슈에서 바로 결정됨.
- **K (Knowledge) = K-Domain** — 한 줄 픽스 자체는 쉬우나, *왜* 깨지는지 이해하려면 django의 timezone 모델(USE_TZ, aware/naive datetime, `timezone.make_aware`)과 `datetime` 생성자가 `tzinfo`를 명시 안 하면 naive가 된다는 도메인 지식이 필요. 일반 파이썬 추론(K-Gen)만으로는 "왜 1개월 이상에서만, 왜 USE_TZ=True에서만"을 못 짚어 over-edit로 빠지기 쉽다.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 인자 추가(S1). T-LocTrivial이 아닌 이유는 도메인 지식(K-Domain)이 진단에 개입하고, 단순 "찾으면 끝"보다 tz 의미를 알아야 올바른 인자(`d.tzinfo`)를 고를 수 있기 때문. 이슈가 픽스를 적어주므로 T-ConstraintReason(S2)은 아니다.

## 난이도 티어
**T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치한다.
- 이 티어로 미는 구조적 피처: **1파일·단일함수·+1줄**(`gold_files` 1개, 헌크 1개) — ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 구간 한가운데. **has-repro** — 이슈에 셸 재현 코드와 네이티브 스택트레이스(L103 `(now - pivot).total_seconds()`)가 있어 가장 강한 easiness 신호. **L0 + S1** — localize·repair 둘 다 거의 공짜.
- T1(존나쉬움)이 아닌 이유: **K-Domain**(USE_TZ/aware-naive 의미)이 끼어 순수 K-Gen 한 방이 아니며, 버그가 `USE_TZ=True` + ≥1개월 간격이라는 **숨은 조건부**에서만 재현돼 순진한 테스트로는 가짜 그린이 나기 쉽다. 즉 "이슈가 픽스를 거의 적어줌"이라는 T1 조건은 만족하지만 도메인·조건부 재현 때문에 한 단계 위로.
- T3 이상이 아닌 이유: 실질적 constraint 추론도, cross-file 조율도, diffuse localize도 없다. **regression-trap**(naive 경로를 깨면 안 됨)은 있으나 P2P가 21개로 광범위하지 않고 픽스가 `tzinfo=None`을 그대로 전파하므로 trap 통과가 구조적으로 보장된다.

## 골드패치 분석
- **건드린 파일·함수:** `django/utils/timesince.py` → `timesince(d, now=None, reversed=False, time_strings=None, depth=2)` 내부, 월 보정용 `pivot = datetime.datetime(...)` 생성부.
- **근본 원인:** ≥1개월 차이일 때 코드가 `datetime.datetime(pivot_year, pivot_month, min(d.day, ...), d.hour, d.minute, d.second)`로 pivot을 **새로** 만드는데 `tzinfo` 인자를 누락 → pivot이 naive로 생성. 직후 `remaining_time = (now - pivot).total_seconds()`에서 aware인 `now`(USE_TZ=True)와 naive인 `pivot`을 빼다가 `TypeError: can't subtract offset-naive and offset-aware datetimes`. 1개월 미만이면 이 pivot 재생성 분기를 안 타고 `pivot = d`(else 가지)라 원본 tz가 보존되므로 크래시가 안 났다 — 그래서 "≥1개월에서만" 재현.
- **수정 요지:** pivot 생성자 인자 목록에 `tzinfo=d.tzinfo,` 한 줄 추가. 원본 `d`가 aware면 pivot도 같은 tzinfo를 갖는 aware가 되어 `now - pivot`이 정상 동작하고, `d`가 naive면 `d.tzinfo`가 `None`이라 기존 naive 동작이 그대로 전파됨. `timeuntil`도 내부적으로 `timesince`를 호출하므로 별도 수정 불필요.

## 검증 (test_patch)
- **FAIL_TO_PASS(4):** `tests/utils_tests/test_timesince.py`에 `@requires_tz_support @override_settings(USE_TZ=True)`로 데코된 `TZAwareTimesinceTests(TimesinceTests)`를 신설, `setUp`에서 `self.t = timezone.make_aware(self.t, timezone.get_default_timezone())`로 베이스 시각을 aware로 만들고 부모의 모든 케이스를 재실행한다. 이 중 ≥1개월 pivot 경로를 타는 `test_depth (...TZAwareTimesinceTests)`, `test_depth_invalid (...TZAwareTimesinceTests)`, `test_thousand_years_ago (...TZAwareTimesinceTests)`, "Test other units."가 픽스 전엔 TypeError로 깨진다.
- **픽스 증명:** 또한 `test_thousand_years_ago`의 하드코딩 naive 리터럴 `datetime.datetime(1007, 8, 14, ...)`을 `self.t.replace(year=self.t.year - 1000)`로 바꿔 aware 상속 클래스에서도 시각이 aware로 유지되게 한다. pivot에 `tzinfo=d.tzinfo`가 들어가면 aware-aware 뺄셈이 성공해 `"1000 years"`, `"1 month"` 등 기대 출력이 나온다.
- **overfit 관점:** 픽스가 입력 `d`의 tzinfo를 그대로 전파하는 **일반 해법**이라 특정 테스트값에 맞춘 special-case가 아니다. FAIL_TO_PASS가 4개로 다소 얇지만, 테스트가 "기존 전체 스위트를 USE_TZ=True로 재실행"하는 형태라 단일 입력 overfit이 구조적으로 어렵다 → overfit-risk 플래그 미부여.
- **regression 관점:** PASS_TO_PASS 21개 중 naive 경로 `TimesinceTests`의 동명 케이스들("Test other units.", `test_thousand_years_ago (...TimesinceTests)`, date 객체 케이스 등)이 그대로 통과해야 한다. `tzinfo=None` 전파로 naive 동작이 byte-identical하게 보존되므로 trap 통과. **regression-trap** 플래그는 "naive를 안 깨야 함"을 명시.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 스택트레이스가 `timesince.py` L103 `(now - pivot).total_seconds()`를 직접 지목 → 그 위에서 `pivot`이 어떻게 생기는지 본다. 1개월 미만은 `pivot = d`(tz 보존), ≥1개월은 `datetime.datetime(...)`로 재생성하는 분기 발견. 에러 메시지("offset-naive and offset-aware")가 곧 "둘 중 하나가 naive"라는 신호 → 재생성된 pivot이 범인. L0이라 탐색 거의 불필요.
2. **픽스(왜 올바른 일반화):** pivot 생성자에 `tzinfo=d.tzinfo` 추가. 입력의 tzinfo를 *그대로* 운반하므로 aware든 naive든 입력과 동일 종류의 pivot이 나온다 — 특정 시각/오프셋에 맞춘 게 아니라 "pivot은 d와 같은 tz 맥락이어야 한다"는 불변식을 복원하는 것이라 일반화가 맞다. `0, d.tzinfo`(positional)도 동작하지만 keyword가 의도가 명확하고 시그니처 안전.
3. **regression 안전:** naive 경로(`TimesinceTests`)의 21개 P2P를 안 깨야 한다. `d.tzinfo`가 `None`이면 `tzinfo=None`이 되어 기존 naive pivot과 동일 → naive 동작 보존. date 객체·서로 다른 timezone·인접 아닌 단위 등 인접 케이스도 pivot의 tz만 바뀌고 산술은 동일하므로 영향 없음.
4. **함정 회피:** (a) **가짜 그린** — `USE_TZ` 미설정 또는 ≤1개월 간격으로 재현 시도하면 통과해버려 "이미 멀쩡"으로 오판(힌트 스레드에서 메인테이너도 처음엔 재현 실패). 반드시 `override_settings(USE_TZ=True)` + `make_aware` + ≥31일 간격이라야 재현됨을 인지. (b) **over-edit** — pivot 분기 전체를 재작성하거나 `now`/`pivot` 둘 다를 강제 aware/naive로 normalize하는 큰 수정을 하면 naive 회귀를 깨거나 다른 tz 케이스를 망친다 — 누락 인자 한 줄만 더하는 게 정답. (c) **timeuntil 별도 수정 시도** — `timeuntil`은 `timesince`를 위임 호출하므로 손대면 중복/오작동. 단일 함수, 한 줄로 끝낸다.
