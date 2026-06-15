---
instance_id: django__django-15863
repo: django/django
base_commit: 37c5b8c07be104fd5288cd87f101e48cb7a40298
version: 4.2
difficulty: <15 min fix
created_at: 2022-07-20T12:58:04Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [django/template/defaultfilters.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15863

## 문제 요약
`floatformat` 템플릿 필터가 `Decimal` 입력에 대해 정밀도를 잃는다. `Decimal('42.12345678901234567890')`을 `{{ value|floatformat:20 }}`로 렌더하면 기대값 대신 `42.12345678901234400000`처럼 뒤쪽 자릿수가 깨진 값이 나온다. 이는 float의 IEEE-754 53비트 가수 한계를 넘는 자릿수가 잘려나간 흔적이다. 사용자는 고정밀 `Decimal`이 float을 경유하지 않고 그대로 보존된 채 포매팅되기를 기대했다. problem_statement에 동작하는 MWE(재현 스크립트)가 포함되어 있고, 원인을 "incorrect conversion to Decimal ... converted to float instead"로 직접 지목한다.

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈가 필터 이름 `floatformat`과 "conversion to Decimal" 라인을 명시한다. `grep floatformat django/template/defaultfilters.py` 한 방으로 함수 본문에 도달하고, `Decimal(...)` 생성 직전 한 줄로 좁혀진다. 후보 모호성 없음.
- **S2 (Constraint-Reasoning) +S1** — 고칠 위치는 자명하나(L0), 올바른 픽스는 "왜 `repr`이 틀렸고 무엇으로 바꿔야 정밀도가 보존되는가"라는 의미 추론을 요구한다. `repr(Decimal(x))` → `"Decimal('...')"` 문자열 → `Decimal()` 생성자가 `InvalidOperation` → except fallback이 `float(text)` 경유 → 정밀도 손실, 이 인과 사슬을 따져 `str(text)`가 그 사슬을 끊는 올바른 표현임을 도출해야 한다. 최종 변경 자체는 한 토큰(`repr`→`str`)이라 S1(기계적)의 외양을 띠지만, 그 토큰을 고르는 근거가 불변식 추론이므로 dominant는 S2다.
- **K-Domain** — float vs `Decimal`의 정밀도 모델, `Decimal` 생성자가 받는 문자열 형식, django 템플릿 필터의 fallback 분기 의미를 알아야 안전하게 고친다. 순수 일반 파이썬 추론(K-Gen)만으로도 핵심에 근접 가능하나, `repr`/`str`/`float`의 상호작용과 fallback 분기 보존 판단에 Decimal 도메인 감각이 필요해 K-Domain으로 둔다.

primary type = **T-ConstraintReason**: 위치는 명확(L0)하나 픽스 도출이 S2 의미 추론에 달려 있다. 위치 찾기가 어려운 T-DiffuseLoc도, 기계적 가드 추가인 T-DirectMap도 아니다. APR 관점에서 이는 SemFix/Angelix류의 "올바른 표현식을 합성"하는 문제 — 후보를 여러 개 시도해 테스트로 거르는 G&V가 아니라, 데이터 변환 불변식(입력 보존)을 따져 단일 정답을 추론하는 결로 푼다.

## 난이도 티어
**T3 (중간)**. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만 한 단계 위로 올린다. 근거:

- **구조 피처는 가볍다**: 1파일, 1라인(±1), has-repro, 단일 FAIL_TO_PASS. 이것만 보면 T1~T2.
- **티어를 올리는 피처(S2 추론 부하)**: 공식 시간라벨은 "개발자 구현시간"이라 fallback 사슬을 이미 이해한 코어 개발자 기준 <15분이다. 그러나 오라클 없는 에이전트 입장에서 난점은 *수정 위치*가 아니라 *왜 그 한 토큰인가*다. `repr`→`str` 변경이 어떻게 float 경유 fallback을 회피시키는지 모르면, 증상(정밀도 손실)을 보고 except 분기나 `arg` 파싱부를 손대는 과교정으로 새기 쉽다. localize 직접성은 최상(L0)이나 fix-synthesis가 의미 추론이라 T1/T2의 "픽스 자명"에 미달.
- **regression-trap**: PASS_TO_PASS 9개(float dunder, infinity, negative-zero, force-grouping, unlocalize, zero-values, `#15789` 회귀 등)가 인접 입력 타입을 전부 커버한다. `str` 치환이 float·`"foo"` 비숫자·infinity 입력에서도 회귀를 안 일으키는지가 함정.
- T4까지 안 가는 이유: cross-file 의존 없음, localize가 L0로 자명, 도메인 깊이가 ORM/query-compiler급은 아님.

## 골드패치 분석
- **건드린 파일·함수**: `django/template/defaultfilters.py` 의 `floatformat(text, arg=-1)`.
- **근본 원인**: `Decimal`을 만들 입력 문자열을 `input_val = repr(text)`로 생성했다. `text`가 `Decimal` 인스턴스면 `repr(Decimal('42.12...'))`는 `"Decimal('42.12...')"`처럼 클래스명·따옴표가 박힌 문자열을 돌려준다. 이 형태는 `Decimal(input_val)` 생성자가 파싱하지 못해 `InvalidOperation`을 던지고, except 분기로 떨어져 `Decimal(str(float(text)))` 류로 float을 경유한다. 이 float 변환에서 53비트 가수를 초과하는 자릿수가 손실된다.
- **수정 요지**: `input_val = repr(text)` → `input_val = str(text)` 한 줄. `str(Decimal('42.12...'))`는 `"42.12345678901234567890"` 같은 순수 숫자 문자열이므로 `Decimal(input_val)`이 **첫 시도에서 성공**하고 float fallback을 타지 않아 원래 정밀도가 보존된다. float·int·문자열 입력에 대해서도 `str()`은 `repr()`과 동일하거나 `Decimal()`이 받는 형태를 주므로 기존 동작이 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `template_tests.filter_tests.test_floatformat.FunctionTests.test_inputs`.
- **픽스 증명**: `test_inputs`에 `floatformat(Decimal("123456.123456789012345678901"), 21)` == `"123456.123456789012345678901"` 단언이 추가된다. 21자리 소수는 float(약 15~17 유효자리)에 담기지 못하므로 패치 전에는 float fallback 경로에서 끝자리가 어긋난 값이 나와 실패한다. `str(text)` 경로로 `Decimal`이 보존되어야만 정확히 통과 → fix와 결함이 직접 결속된다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 표면상 overfit 신호이나, 추가 케이스가 "고정밀 보존"이라는 일반 속성을 21자리로 표현한 것이라 special-case 통과 트릭(예: 특정 입력만 분기)으로는 못 푼다. 골드의 `str` 치환은 입력 타입 전반을 일반화하므로 overfit 위험은 실질적으로 낮다.
- **regression 관점**: PASS_TO_PASS 9개가 float dunder method, infinity, negative-zero, zero-values, force-grouping, unlocalize, `#15789` 회귀 등 인접 입력을 폭넓게 고정한다. `repr`→`str` 변경이 이들 비-Decimal 입력에서도 동일 출력을 내야 통과하므로, fallback 분기를 건드리는 과교정은 여기서 잡힌다.

## 모범답안 (오라클 기반)
이상적 풀이 궤적 4단계:

1. **localize 경로**: problem_statement이 (a) 필터명 `floatformat`, (b) "incorrect conversion to Decimal", (c) "converted to float instead"를 명시 → `django/template/defaultfilters.py`의 `floatformat`를 열고 `Decimal(...)` 생성 줄(`input_val = repr(text); d = Decimal(input_val)`)을 직접 지목. MWE를 실행해 `42.12345...400000` 손실을 재현하면 float 경유 가설이 확정된다.
2. **픽스와 왜 올바른 일반화인지**: `repr(text)`가 `Decimal` 입력에서 `"Decimal('...')"`를 만들어 `Decimal()` 생성자를 깨고 except fallback의 float 경로를 강제함을 추적한다. `str(text)`로 바꾸면 `Decimal`은 순수 숫자열을 주어 첫 try에서 성공하고, float·int·str 입력은 `str()`==`repr()` 또는 생성자 호환 형태라 동작 불변. 이는 특정 입력을 분기 처리하는 special-case가 아니라 "입력의 정밀한 텍스트 표현을 보존한다"는 변환 불변식을 복원하는 것이라 올바른 일반화다.
3. **regression 안전**: PASS_TO_PASS의 float dunder(`test_float_dunder_method`), infinity, negative-zero, zero-values, force-grouping, unlocalize, `#15789`를 안 깨야 한다. `str()`가 이들 입력에서 기존 `repr()`과 같은(혹은 `Decimal()`이 받는) 문자열을 내는지 확인 — float은 `str(1.5)=="1.5"`로 동일, 비숫자 `"foo"`는 try 전체가 `InvalidOperation` 후 별도 except로 빈 문자열을 반환하므로 영향 없음.
4. **함정 회피**: 오라클 없는 에이전트는 증상(정밀도 손실)만 보고 except fallback 로직을 재작성하거나 `arg`/`use_l10n` 파싱부를 손대는 과교정에 빠지기 쉽다. 핵심은 "fallback이 문제의 *증상*이지 원인이 아니다 — try를 첫 시도에서 성공시키면 fallback 자체를 안 탄다"는 점. 골드처럼 `repr`→`str` 단일 토큰 최소 변경으로 수렴하고, float·문자열·infinity 입력에 회귀가 없는지 PASS_TO_PASS로 자기검증하면 안전하다.
