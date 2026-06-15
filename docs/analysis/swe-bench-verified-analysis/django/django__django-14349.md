---
instance_id: django__django-14349
repo: django/django
base_commit: a708f39ce67af174df90c5b5e50ad1976cec7cb8
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-05-04T20:10:27Z
fail_to_pass: 1
pass_to_pass: 18
gold_files: [django/core/validators.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-14349

## 문제 요약
`URLValidator`가 LF/CR/Tab 문자를 포함한 URL을 `ValidationError`로 거부하는 동작이, bpo-43882 패치가 적용된 Python(3.9.5+, 3.10.0b1)에서 깨졌다. 기존 Django는 `urlsplit`으로 쪼갠 URL 컴포넌트를 정규식으로 검증해 거부했는데, bpo-43882 픽스가 split 이전에 LF/CR/Tab을 모두 silently strip하면서 이 문자들이 validator의 정규식까지 도달하지 못한다. 그 결과 `http://www.djangoproject.com/\n` 같은 입력이 통과돼버려 `test_validators`가 "ValidationError not raised"로 실패한다. problem_statement에 실패 테스트의 네이티브 스택트레이스와 근본원인(strip-before-split), 두 가지 해법 옵션(early reject vs silent strip)까지 명시돼 있다.

## 유형 (정형화)

3축 점수:

- **L (Localization) = L0 — Pinpointed.** problem_statement이 실패 테스트를 `validators.tests.TestValidators [URLValidator]`로, 클래스명 `URLValidator`를 본문에서 직접 지목한다. `django/core/validators.py`의 `class URLValidator`로 grep 한 방에 직결. 단일 파일·단일 메서드(`__call__`)이며 cross-module 추적 불필요.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference).** 고칠 위치(`URLValidator.__call__`)는 자명하지만, *올바른 픽스를 추론으로 합성*해야 한다. "trailing `\n`만 막으면 되나? 아니다 — 위치 무관(중간/선두 포함)으로 막아야 한다", "정규식을 손대면 되나? 아니다 — strip-before-split 환경에선 그 문자가 정규식에 도달조차 안 하므로 split/regex *이전* 단계에서 raw `value`를 검사해야 한다"는 불변식·실행순서 추론이 픽스의 본질이다. 이건 후보를 마구 시도해 테스트로 거르는 G&V(S3)가 아니라 "생각으로" 푸는 SemFix/Angelix 계열이다. 보조로 **S5**: 의도된 스펙("어떤 문자를, 어디 단계에서 거부해야 하나")을 코드만으로는 결정 못 하고 이슈 본문의 두 옵션 제시에서 "early reject"를 골라 스펙을 재구성해야 한다.
- **K (Knowledge) = K-Domain.** stdlib `urlsplit`/`urlsplit` 내부 동작 변경(bpo-43882)과 Django validator가 그 strip에 *암묵적으로 의존*하고 있었다는 도메인 지식이 병목이다. 일반 파이썬 추론(K-Gen)만으론 "왜 기존 정규식이 안 잡냐"를 설명할 수 없다. 다만 이슈 본문이 그 도메인 사실을 친절히 제공하므로 모델빨 부담은 경감된다.

**Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 픽스가 기계적 가드 삽입이 아니라(그랬다면 T-DirectMap), "어느 단계에서·어떤 문자를·위치 무관으로" 검사할지에 대한 제약 추론이 핵심이라 T-ConstraintReason. 정규식 수정/trailing-only 같은 plausible-but-wrong 후보가 다수라 단순 None-가드형 S1 템플릿 매칭으로는 못 풀린다.

## 난이도 티어

**Tier = T3 (중간).**

이 티어로 미는 구조적 피처:
- 파일/줄: 1파일·gold patch 실질 +3줄(클래스 속성 1 + `__call__` 가드 2). 줄 수만 보면 T2 이하지만,
- localize 직접성: L0로 매우 높음(쉬움 쪽 신호).
- has-repro: 네이티브 스택트레이스 + 실패 테스트 명시(가장 강한 easiness 신호, ~87% 해결률 구간).
- **하지만 실질 추론(S2/S5) + K-Domain이 난이도를 끌어올린다.** 픽스 줄 수는 적어도 (a) 정규식 vs split-이전 검사라는 *실행 단계* 추론, (b) trailing-only vs 위치무관이라는 *일반화 범위* 추론, (c) silent-strip vs early-reject라는 *스펙 선택*을 모두 통과해야 정답에 도달. 이 세 갈림길 각각에 plausible-but-wrong 함정이 있다(overfit-risk의 그림자). 루브릭 T3 정의("L1 + S2/S5, 단일파일이나 실질 추론") 및 T4 정의("L1/L2 + S2 또는 K-Domain")의 경계에 걸치나, localize가 L0로 자명하고 patch가 극소(<5줄)라 T4까지 올리진 않고 T3로 둔다.

**공식 라벨과의 차이:** 공식 difficulty는 "15 min - 1 hour"(T3~T4 구간 prior). 본 분석도 T3로 거의 일치한다. 공식 라벨이 "개발자 구현시간"이라 strip-before-split 원인 분석에 드는 시간을 반영하는데, 이슈가 원인을 친절히 적어줘 에이전트 관점 localize 부담은 더 작아 T4가 아닌 T3로 조정.

## 골드패치 분석

- **건드린 파일·함수:** `django/core/validators.py` — `class URLValidator(RegexValidator)`. (1) 클래스 본문에 속성 추가, (2) `__call__` 메서드 본문 수정.
- **근본 원인:** Django는 LF/CR/Tab 제거를 stdlib `urlsplit` 동작에 *암묵적으로* 의존했다. 기존 코드는 `value.split('://')` 및 정규식 `regex` 매칭으로 검증하는데, 위험 문자는 split 과정/정규식 `\Z` 경계에서 자연히 걸러졌다. bpo-43882가 보안 목적으로 strip 시점을 split *이전*으로 옮기면서, validator가 보기도 전에 LF/CR/Tab이 사라져 거부 로직 전체가 우회됨.
- **수정 요지:** 클래스 속성 `unsafe_chars = frozenset('\t\r\n')`를 추가하고, `__call__`의 `isinstance(value, str)` 타입 체크 직후·`value.split('://')` 직전에
  ```python
  if self.unsafe_chars.intersection(value):
      raise ValidationError(self.message, code=self.code, params={'value': value})
  ```
  를 삽입. `frozenset.intersection(value)`는 문자열을 iterable로 받아 위치 무관하게 금지문자 포함 여부를 O(n)으로 검사한다. stdlib 동작에 의존하지 않고 Django가 split/정규식 *이전* 단계에서 raw `value`를 직접 차단(이슈의 "early reject" 옵션)한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개):** `test_validators (validators.tests.TestValidators)` — `TEST_DATA` 케이스 테이블 기반 파라미터(subTest) 테스트.
- **픽스 증명:** test_patch가 케이스 테이블에 trailing `\n`(기존)에 더해 trailing `\r`, **URL 중간** CR(`http://www.django\rproject.com/`, `http://[::\rffff:192.9.5.5]`), **선두** Tab(`http://\twww.djangoproject.com/`, `http://\t[::ffff:192.9.5.5]`) 케이스를 모두 `ValidationError` 기대값으로 추가. strip-before-split이 적용된 Python에서도 이들이 거부되려면 `unsafe_chars.intersection` 조기 거부가 반드시 있어야 하므로, 픽스 없이는 fail, 픽스 후 전부 pass. 단일 `test_validators`가 8개 신규 케이스(trailing/중간/선두 × CR/Tab)를 묶어 검사한다.
- **overfit 관점:** 테스트가 trailing-only가 아니라 **중간/선두 위치**까지 커버하므로, `value.endswith('\n')` 같은 special-case 픽스는 통과 못 한다 — test_patch가 의도적으로 위치 일반화를 강제해 overfit을 차단. 그래서 flag에 `overfit-risk`를 달지 않음(테스트가 일반화를 강제).
- **regression 관점:** PASS_TO_PASS 18개(Deprecation 5 + ValidatorEquality 8 + 기타 TestValidators 5)가 모두 유지돼야 한다. `flags: regression-trap` — 가드를 `__call__` 초입에 넣으므로 정상 URL 검증 경로가 깨지면 안 되고, 같은 모듈의 equality/message 동작도 영향받지 않아야 한다. 다만 P2P 표면이 validators 모듈 내로 좁아 regression 위험은 중간 수준.

## 모범답안 (오라클 기반)

이상적 풀이 궤적 4단계:

1. **localize 경로:** problem_statement의 스택트레이스에서 `validators.tests.TestValidators [URLValidator]`와 본문의 클래스명 `URLValidator`를 신호로 잡는다 → `django/core/validators.py`의 `class URLValidator`로 직행 → `__call__`이 `value.split('://')`과 정규식 `regex`로 검증함을 확인. 이슈 본문의 "django rejects URLs based on the split URL components ... bpo-43882 ... strips all instances of LF, CR and tab before splitting"이 근본원인을 그대로 적어주므로 추가 탐색 불필요(L0).

2. **픽스 (왜 올바른 일반화인가):** 정규식이나 split을 손대는 대신, split/정규식 *이전*에 raw `value`를 검사한다. 금지문자 집합 `frozenset('\t\r\n')`을 `intersection(value)`로 검사 → 문자가 URL의 어디(선두/중간/끝)에 있든 위치 무관하게 잡는다. 이는 overfit(trailing-only)이 아닌 올바른 일반화인데, 이유는 (a) bpo-43882가 strip하는 문자 집합이 정확히 LF/CR/Tab이고, (b) 그 문자는 위치 불문하고 strip되므로 trailing만 막으면 중간/선두 삽입을 놓치고, (c) 검사를 split 이전 raw value에 두어야 stdlib strip 동작에 무관하게 항상 도달하기 때문이다. 이슈의 두 옵션 중 "early reject"를 택하는 게 Django의 기존 보안 의도(위험 URL 거부)를 보존한다.

3. **regression 안전:** PASS_TO_PASS의 `test_max_length_validator_message`, `test_message_dict/list`, `test_regex_validator_flags`, `test_single_message`(TestValidators) 및 Deprecation/Equality 군이 안 깨져야 한다. 가드를 `isinstance` 체크 *직후*에 두되, 금지문자가 없는 정상 입력에 대해선 `intersection`이 빈 집합을 반환해 short-circuit 없이 기존 흐름으로 진행되므로 정상 URL 검증·메시지·equality 경로에 부작용 없음. `unsafe_chars`를 클래스 속성으로 둬 인스턴스마다 재생성 비용 없고 서브클래스 오버라이드 여지도 보존.

4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) **정규식 패치 함정:** `regex` 패턴에 `\n\r\t` 거부를 추가하려는 시도. bpo-43882 환경에선 이 문자가 정규식에 도달조차 안 하므로 무효 → 반드시 split/regex 이전 단계에서 검사해야 함을 인지. (b) **trailing-only 함정:** `value.endswith()`나 정규식 `\Z` 근처만 보면 중간/선두 케이스를 놓침 → 위치 무관 검사(`intersection`)로 일반화. (c) **silent-strip 오선택:** 이슈가 "silently strip" 옵션도 제시하나, 그러면 위험 URL을 통과시키게 돼 Django 보안 의도에 반함 → "early reject" 선택. (d) **재현 불가 함정:** 로컬 Python이 bpo-43882 미적용이면 기존 정규식만으로도 trailing 케이스가 잡혀 문제를 못 느낄 수 있다 → 이슈 본문의 원인 설명을 신뢰해 환경 무관한 명시적 가드를 넣는 게 정답.
