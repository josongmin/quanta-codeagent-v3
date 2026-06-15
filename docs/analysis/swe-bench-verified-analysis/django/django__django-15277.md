---
instance_id: django__django-15277
repo: django/django
base_commit: 30613d6a748fce18919ff8b0da166d9fda2ed9bc
version: "4.1"
difficulty: <15 min fix
created_at: 2022-01-03T12:14:06Z
fail_to_pass: 2
pass_to_pass: 158
gold_files: [django/db/models/fields/__init__.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15277

## 문제 요약
`Value('test')._resolve_output_field()`는 `CharField()`를 `max_length` 없이 인스턴스화한다. 그런데 `CharField.__init__`이 무조건 `self.validators.append(validators.MaxLengthValidator(self.max_length))`를 실행하기 때문에 `max_length=None`인 깨진 validator가 만들어진다. 이 validator로 `clean()`을 호출하면 `MaxLengthValidator.compare`의 `a > b`에서 `'>' not supported between instances of 'int' and 'NoneType'` TypeError가 난다. output_field는 어차피 validate되지 않으므로 이 validator는 불필요하며, 추가로 `@deconstructible` 데코레이터된 validator를 매번 생성하는 비용까지 든다(이슈는 `Value._resolve_output_field`의 ~2µs 마이크로 최적화로 프레이밍됨). 사용자는 `max_length`가 None이면 validator를 아예 안 만들기를 기대하며, `BinaryField.__init__`가 이미 동일한 None-가드를 쓰고 있음을 선례로 제시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `CharField.__init__`을 파일·메서드 단위로 직접 지목하고, 깨지는 위치(`MaxLengthValidator` → `clean`)와 native 트레이스백(`TypeError: '>' not supported ...`)까지 박아둔다. grep `MaxLengthValidator` 한 방으로 수렴. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)** — 정형 결함클래스(None-가드 누락)에 정확히 매칭되고, 이슈가 픽스 코드(`if self.max_length is not None:`)를 거의 그대로 적어준다. 추론으로 식을 합성(S2)할 필요 없이 조건 한 줄을 기계적으로 삽입하는 template repair. PAR/TBar류 None-guard 템플릿이 곧바로 적용되는 케이스.
- **K (Knowledge) = K-Domain** — 픽스 자체는 일반 파이썬이지만, "이 가드가 안전하다"를 정당화하려면 django 내부 계약을 알아야 한다: output_field는 cleaning/validation 경로를 타지 않는다는 점, `MaxLengthValidator(None)`이 비교에서 깨진다는 점, max_length 필수성은 system-check 단으로 강제된다는 점, `BinaryField.__init__`의 선례. 일반 추론만으론 "validator를 빼도 정상 CharField가 안 깨지나?"를 확신할 수 없다.
- **primary type = T-DirectMap** — L0(위치 명확) + S1(기계적 None-가드)의 교과서적 조합. T-LocTrivial이 아닌 이유는 픽스의 *정당성*이 자명하지 않고(validator 제거의 안전성은 도메인 계약에 의존), T-DomainBound이 아닌 이유는 K-Domain이 픽스 *도출*의 병목이 아니라 *검증*의 보조 요소일 뿐이기 때문. dominant 신호는 "위치 명확 + 기계적 가드 픽스".

왜 S1인가(APR 관점): 결함이 "조건 없는 부수효과(validator append)"라는 정형 패턴이고, 이슈가 정확한 가드 술어와 삽입 지점을 명세하므로 후보 패치 공간이 단일점으로 붕괴한다. SemFix식 제약합성(S2)도, generate-and-validate 반복(S3/S4)도 불필요 — 템플릿 인스턴스화 한 번이면 끝. 이슈가 fix를 명세한다는 점에서 S1의 정의("이슈가 사실상 픽스를 명세")에 정확히 부합.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨도 `<15 min fix`(가장 쉬운 prior)와 정합.

이 티어로 미는 구조적 피처:
- **1파일 / 1헌크 / 실질 +1줄**(append를 if-블록으로 감쌈) — patch scope가 최소. ICLR 2024 컷의 "1파일·<5줄 ≈ 48% solve" 구간.
- **L0 + has-repro** — 이슈에 REPL 재현(`x.clean('1', model_instance=None)` → TypeError)과 native 트레이스백이 있어 가장 강한 easiness 신호(ORACLE-SWE: repro≫edit-location).
- **이슈가 픽스를 거의 적어줌** — T1 프로파일에 근접.

T1이 아니라 T2인 이유: (1) K-Gen이 아니라 K-Domain — validator를 제거해도 안전하다는 판단이 일반 파이썬 추론만으로는 닫히지 않고 django 계약 지식을 요구한다. (2) **regression-trap이 약하지 않다** — P2P가 158개로 넓고, 그중 `test_resolve_output_field`, `test_output_field_decimalfield`, `test_update_TimeField_using_Value`, `test_update_UUIDField_using_Value` 등 CharField/Value output_field 경로를 직접 밟는 테스트가 다수다. "Field.__init__에 가드를 넣는" 과도한 수정이나 max_length 있는 CharField의 정상 검증을 깨면 광범위 회귀가 난다. T1의 "regression-trap 약함" 프로파일에 어긋난다. P2P 폭과 도메인 검증 부담이 T1→T2로 한 칸 올린다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/fields/__init__.py` → `CharField.__init__`
- **근본 원인:** `CharField.__init__`이 `self.max_length`의 None 여부와 무관하게 항상 `self.validators.append(validators.MaxLengthValidator(self.max_length))`를 실행. `max_length=None`이면 `MaxLengthValidator.limit_value=None`이 되어, validator가 호출될 때 `compare(a, b)`의 `a > b`에서 `int > None` 비교로 TypeError를 던진다. `Value`의 output_field처럼 max_length 없이 `CharField()`가 생성되는 경로에서 이 깨진 validator가 노출된다(평소 모델 필드는 system-check가 max_length 필수를 강제해 가려져 있음).
- **수정 요지:** validator append를 `if self.max_length is not None:` 가드로 감싼다. None일 때 validator를 추가하지 않아 (1) 깨진 `MaxLengthValidator` 생성을 원천 차단하고 (2) 불필요한 `@deconstructible` 인스턴스화 비용을 제거한다. `max_length`가 설정된 정상 CharField는 종전과 동일하게 validator를 갖는다. `BinaryField.__init__`의 기존 None-가드 패턴과 일치한다.

```python
-        self.validators.append(validators.MaxLengthValidator(self.max_length))
+        if self.max_length is not None:
+            self.validators.append(validators.MaxLengthValidator(self.max_length))
```

## 검증 (test_patch)
- **FAIL_TO_PASS 동작 (2개):**
  - `ValueTests.test_output_field_does_not_create_broken_validators` — str/bool/int/float/date/datetime/time/timedelta/Decimal/bytes/uuid 11종 타입에 대해 `Value(value)._resolve_output_field()`로 얻은 field가 `field.clean(value, model_instance=None)`을 예외 없이 통과하는지 `subTest` 루프로 확인. 핵심은 `'str'` 케이스: 픽스 전에는 max_length=None인 `MaxLengthValidator`가 clean 중 TypeError를 던져 RED, 픽스 후에는 validator 자체가 없어 GREEN.
  - `test_raise_empty_expressionlist` — F2P에 함께 묶여 있으나(test_patch 인접/리하니스 영향), broken-validator 테스트가 본 픽스의 직접 증명이다.
- **픽스 증명 방식:** 테스트가 max_length 없이 만들어지는 모든 output_field 타입을 훑어, 회귀를 좁은 단일 입력이 아니라 타입 매트릭스로 일반화한다. 픽스가 "str일 때만" 같은 special-case가 아니라 "max_length가 None인 모든 CharField"에 작동함을 보장.
- **overfit 관점:** F2P가 2개로 얇지만 broken-validator 테스트가 11타입 매트릭스를 돌려 입력공간을 넓게 커버한다. 골드 픽스는 테스트가 검사하는 것보다 더 일반적(타입 무관, None 가드)이라 overfit-risk는 낮다 — 그래서 플래그에 `overfit-risk`를 넣지 않았다.
- **regression 관점:** P2P 158개가 넓고 Value/output_field/CharField 경로(`test_resolve_output_field`, `test_output_field_decimalfield`, `test_deconstruct_output_field`, `test_update_TimeField_using_Value` 등)를 직접 밟으므로 `regression-trap` 플래그. max_length가 있는 정상 CharField의 validator 부여를 깨면 이 다수 테스트가 RED가 된다. 골드 픽스는 None 경로만 분기하므로 정상 경로는 byte-identical로 보존되어 회귀가 없다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 트레이스백 `MaxLengthValidator` → `validators.py compare` `'>' not supported between 'int' and 'NoneType'`와 "Change the `CharField.__init__` to ..."를 직접 준다. `grep -n "MaxLengthValidator" django/db/models/fields/__init__.py`로 `CharField.__init__`의 무조건 append 한 줄에 즉시 수렴. `_resolve_output_field`나 `validators.py`로 새지 말 것 — 근본 원인은 validator 호출부가 아니라 *생성부*다.
2. **픽스와 왜 올바른 일반화인가:** append를 `if self.max_length is not None:`로 감싼다. 이것이 overfit이 아닌 이유 — 결함의 진짜 클래스는 "max_length 없는 CharField 전반에서 깨진 validator 생성"이고, str 케이스는 그 한 인스턴스일 뿐이다. None 가드는 타입과 무관하게 결함 클래스 전체를 닫고, max_length가 있을 때의 동작은 변경하지 않는다. `BinaryField.__init__`의 동일 패턴이 일관성·정당성을 뒷받침한다.
3. **regression 안전:** P2P 158개 중 max_length를 가진 CharField의 validator 동작과 Value output_field 해소 경로(`test_resolve_output_field`, `test_output_field_decimalfield`, `test_update_*_using_Value`)를 깨면 안 된다. 가드를 None 분기에만 두면 정상 경로 코드패스가 불변이라 안전. `Field.__init__`(상위) 같은 공유 지점에 가드를 넣으면 다른 필드 타입의 validator 계약을 건드려 회귀 위험 — CharField에만 국한해야 한다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) "마이크로 최적화" 프레이밍에 휘말려 `@deconstructible` 제거 같은 광범위·고위험 변경으로 새는 것(이슈도 "쉽고 더 correct한" 가드를 권한다). (b) `MaxLengthValidator.compare`에 None 가드를 넣어 *증상*만 덮는 것 — output_field에 불필요한 validator가 여전히 생성돼 성능 동기를 못 살리고, validator 전역 계약을 바꿔 다른 회귀를 부른다. (c) `Field.__init__` 상위로 가드를 끌어올려 과도하게 일반화하는 것. 정답은 "CharField 생성부의 최소 None 가드" 단 하나로 수렴하는 것이며, `BinaryField`의 선례가 그 정합성 신호다.
