---
instance_id: django__django-13670
repo: django/django
base_commit: c448e614c60cc97c6194c62052363f4f501e0953
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-11-12T11:45:51Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [django/utils/dateformat.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, overfit-risk]
---

# django__django-13670

## 문제 요약
`django.utils.dateformat`의 포맷 문자 `"y"`(2자리 연도)가 1000년 미만 연도에서 잘못된 결과를 낸다. `dateformat.format(datetime(123, 4, 5, 6, 7), "y")`가 `'3'`을 반환하는데, 파이썬 `datetime.strftime("%y")`와 PHP `date("y")`는 모두 `'23'`을 반환한다. 사용자는 항상 끝 두 자리 연도가 (필요시 leading zero를 채워) 2자리로 출력되기를 기대한다. 이슈에 직접 실행 가능한 재현 코드와 기대값, 그리고 픽스 PR 링크(#13614)까지 첨부되어 있다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 모듈(`django.utils.dateformat`), 호출(`dateformat.format(..., "y")`), 포맷 문자(`"y"`)를 직접 지목한다. `git grep "def y"`면 `django/utils/dateformat.py`의 `DateFormat.y()` 한 메서드로 단번에 수렴한다. 탐색 노력 사실상 0.
- **S1 (Direct-Map, +S2)** — 정형 결함클래스(잘못된 substring slice → 산술 모듈로 + zero-pad)에 거의 템플릿 매칭된다. "끝 두 자리를 2자리로"라는 의도를 이슈가 strftime/PHP 비교로 사실상 명세하므로 픽스가 기계적이다. 다만 올바른 식 `'%02d' % (year % 100)`을 합성하려면 "왜 `[2:]` 슬라이싱이 4자리에서만 맞는가"를 짚는 약한 constraint 추론(S2)이 보조로 든다 — leading-zero 패딩과 모듈로 둘 다 빠지면 일부 케이스가 깨지므로 순수 S1보다 한 칸 위.
- **K-Gen** — django 도메인 지식 불필요. 문자열 슬라이싱 vs 정수 모듈로/포맷이라는 일반 파이썬 추론으로 충분하다. ORM/migrations/query-compiler 같은 프레임워크 내부지식 의존이 없다.
- **primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 결함클래스 치환(S1)이라 T-DirectMap이 dominant. T-LocTrivial은 아니다(픽스가 "체크 한 줄 추가"가 아니라 추출 로직 자체를 바꿔야 하고, zero-pad/modulo를 동시에 맞춰야 해서 완전 자명하진 않음). T-ConstraintReason도 아니다(추론량이 얕고 정답이 정형 패턴이라 S2가 보조에 그침).

## 난이도 티어

**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **1파일·1메서드·2줄** 수정(`DateFormat.y()` 본문 + docstring). ICLR 2024 구조컷 기준 "1파일·<5줄 ≈ 48% solve" 구간으로 scope가 최소.
- **L0 + has-repro** — 이슈가 실행 가능한 재현 코드와 기대 출력(`'3'` vs `'23'`)을 제공한다. repro는 가장 강한 easiness 신호(해결률 ~87%)이고 localize 노력이 없다.
- **regression-trap 약함** — gold 파일 단일, P2P 17개는 모두 같은 `DateFormatTests` 한 클래스 내 인접 포맷 테스트라 광범위 cross-module 의존이 아니다.
- **K-Gen** — 도메인지식 병목 없음.

T1이 아닌 이유: 픽스가 이슈에 "그대로 적혀" 있지 않고(체크 추가가 아니라 추출식 교체), zero-pad와 modulo를 둘 다 맞춰야 해 한 줄 자명함을 살짝 넘는다. 공식 라벨 "15min-1hour"는 개발자 구현시간 기준인데, 에이전트 관점에서도 localize 직접성·repro·도메인부재가 모두 쉬움 쪽이라 prior와 대체로 일치(T2). overfit-risk 플래그가 있긴 하나(아래), FAIL_TO_PASS 3쌍이 modulo·pad 양쪽을 커버해 실제 함정 비용은 낮아 T3까지 올리지 않는다.

## 골드패치 분석

- **건드린 파일·함수**: `django/utils/dateformat.py` → `DateFormat.y()`
- **근본 원인**: 기존 구현 `return str(self.data.year)[2:]`는 연도를 문자열화한 뒤 인덱스 2부터 슬라이싱한다. 4자리 연도에서는 `'1999'[2:] → '99'`로 우연히 맞지만, 끝 두 자리를 뽑는 의미가 아니라 "앞 두 글자를 버린다"는 위치 기반 연산이다. 그래서 3자리는 `'123'[2:] → '3'`, 2자리는 `'42'[2:] → ''`, 1자리는 `'4'[2:] → ''`로 끝 두 자리도 아니고 leading zero도 없다.
- **수정 요지**: 문자열 슬라이싱을 산술로 교체. `'%02d' % (self.data.year % 100)` — `% 100`이 자리수와 무관하게 끝 두 자리 정수값을 취하고, `%02d`가 항상 2자리(부족하면 0 패딩)를 보장한다. docstring도 `"Year, 2 digits with leading zeros; e.g. '99'."`로 명확화. 바로 아래 `Y()`(4자리)는 손대지 않는다.

## 검증 (test_patch)

- **FAIL_TO_PASS** (1): `test_year_before_1000 (utils_tests.test_dateformat.DateFormatTests)` — 1000년 미만 연도에 대한 `"y"` 포맷 결과를 검증한다.
- **픽스 증명**: `(476, '76')`, `(42, '42')`, `(4, '04')` 3쌍을 `subTest`로 돌린다. `476→76`은 3자리에서 끝 두 자리 추출을, `42→42`는 2자리 그대로를, `4→04`는 1자리에서 leading-zero 패딩을 각각 강제한다. 구버전 슬라이싱 코드는 `476→'6'`, `42→''`, `4→''`로 전부 실패 → 픽스 전후 동작 차이가 테스트로 직접 관찰된다.
- **overfit·regression 관점**: FAIL_TO_PASS가 단 1개 테스트지만 세 케이스가 modulo(끝 두 자리)와 pad(zero-fill) 두 실패모드를 분리 커버해 special-case 우회 여지가 작다. 그럼에도 `overfit-risk` 플래그를 남긴 이유: 누군가 `% 100`을 빼고 `str(year)[-2:]` 같은 다른 추출로만 고치면 `4→'4'`라 `(4,'04')`에서 깨지고, 반대로 pad만 보고 modulo를 놓치면 4자리 경계가 흔들릴 수 있다. P2P 17개(`test_dateformat`, `test_date_formats`, `test_datetime_with_tzinfo` 등)는 4자리 정상 연도 포맷이 유지됨을 보장 — modulo+pad 조합은 `1999%100=99 → '99'`로 기존 동작과 byte-identical이라 regression 안전.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 `dateformat.format(..., "y")` 호출과 `"y"` 포맷 문자가 신호. `dateformat`의 `format()`이 각 포맷 문자를 동명 메서드로 dispatch함을 알면 `django/utils/dateformat.py`에서 `def y` 한 줄로 직행. repro 코드를 그대로 돌려 `'3'` 재현 → `DateFormat.y()`의 `str(self.data.year)[2:]`가 범인임을 확정.
2. **픽스와 일반화 근거**: 슬라이싱은 "끝 두 자리"가 아니라 "앞 두 글자 제거"라는 위치 연산이라 자리수에 의존한다. 올바른 일반화는 자리수 불변 연산 — `self.data.year % 100`(끝 두 자리 정수) + `'%02d'`(항상 2자리, zero-pad). strftime/PHP의 `%y` 계약과 정확히 일치하고, 4자리·3자리·2자리·1자리 모든 입력에서 균일하게 동작하므로 테스트 3쌍을 넘어 일반적으로 옳다(overfit 아님).
3. **regression 안전**: P2P의 4자리 연도 포맷들(`test_dateformat`, `test_date_formats`, `test_datetime_with_tzinfo`, `test_futuredates`, `test_epoch` 등)을 안 깨야 한다. `1999 % 100 = 99`, `'%02d' % 99 = '99'`로 기존 `'1999'[2:]`와 동일 결과라 4자리 경로 무변경 — 인접 포맷 메서드(`Y`, `W`)는 미접촉.
4. **함정 회피**: (a) 바로 아래 `Y()`(4자리)를 건드리지 말 것 — `y`만 대상. (b) `% 100`만 적용하고 `%02d` 패딩을 빼면 `4→'4'`라 `(4,'04')`에서 실패. (c) 거꾸로 슬라이싱을 살린 채 leading zero만 덧대는 어설픈 패치는 끝 두 자리 추출 자체가 틀렸음을 놓쳐 3자리(`476`)에서 깨진다. 정답은 슬라이싱 폐기 후 modulo+2자리 포맷 조합. (d) 음수/0년은 `datetime`이 표현 불가하므로 고려 불필요 — 과잉 일반화로 입력공간을 넓히지 말 것.
