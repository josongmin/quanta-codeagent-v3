---
instance_id: django__django-16333
repo: django/django
base_commit: 60a7bd89860e504c0c33b02c78edcac87f6d1b5a
version: 4.2
difficulty: <15 min fix
created_at: 2022-11-27T20:09:15Z
fail_to_pass: 1
pass_to_pass: 87
gold_files: [django/contrib/auth/forms.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-16333

## 문제 요약
`contrib.auth.forms.UserCreationForm`을 ManyToManyField를 가진 커스텀 User 모델과 함께 쓰면, M2M 폼 필드(예: `ModelMultipleChoiceField`)에 입력한 데이터가 저장되지 않는다. 사용자는 `form.save(commit=True)` 호출 후 M2M 관계가 DB에 반영되기를 기대하지만, 부모 `ModelForm`과 달리 `UserCreationForm.save()`가 deferred M2M 저장 단계인 `self.save_m2m()`을 호출하지 않아 예외 없이 silent하게 누락된다. 이슈 본문이 결함 위치(`UserCreationForm.save(commit=True)`)와 근본원인(`save_m2m()` 미호출), 부모 클래스 대조군(`django.forms.ModelForm`)까지 모두 적시한다.

## 유형 (정형화)

**L = L0 (Pinpointed).** 이슈 본문이 파일이 아니라 메서드(`UserCreationForm.save`)와 빠진 호출(`self.save_m2m()`)까지 직접 지목한다. `grep -rn "class UserCreationForm" django/contrib/auth/forms.py` 한 방이면 끝. localize 노력 사실상 0.

**S = S1 Direct-Map (+S2 보조).** 이슈가 픽스를 거의 명세한다 — "부모 `ModelForm`처럼 `save_m2m()`을 불러라". 정형 결함클래스(오버라이드가 부모의 필수 후처리 단계를 누락)에 템플릿 매칭되는 기계적 픽스다. S2가 보조로 붙는 이유: 무조건 `self.save_m2m()`을 호출하면 안 되고 `hasattr(self, "save_m2m")` 가드(또는 commit 분기 안 배치)가 **필요하다는 불변식을 추론**해야 한다. `save_m2m`은 `BaseModelForm._post_clean`/`save` 경로에서 `commit=False`일 때만 인스턴스에 attach되는 콜러블이므로, 가드 없으면 M2M 없는 폼에서 AttributeError. 즉 위치·픽스의 골격은 S1로 받아쓰되, 조건 합성 한 스푼이 S2다.

**K = K-Domain.** 일반 파이썬 추론이 아니라 django forms 내부지식이 병목이다 — `ModelForm.save`의 deferred-m2m 프로토콜(`commit=False`→`save_m2m` 콜러블을 인스턴스에 붙여둠, `commit=True`→즉시 호출)을 알아야 픽스가 올바른지 판단 가능. 이 프레임워크 계약을 모르면 가드 조건을 잘못 잡는다.

**primary_type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 S1 기계적(누락된 부모 후처리 호출을 더하는 것). T-LocTrivial이 아닌 이유: 순수 K-Gen이 아니라 K-Domain 계약(가드 조건)이 픽스 정확성에 개입한다. T-ConstraintReason도 아님 — 조건 합성 비중이 dominant가 아니라 부수적이고, 핵심은 "빠진 한 단계를 매핑해 채우기"다.

## 난이도 티어

**Tier = T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치하며, 구조적 피처가 이를 뒷받침한다:
- **파일/줄수:** gold patch 1파일 2줄 추가(`if hasattr(...)`/`self.save_m2m()`). 구조적 컷 "1파일·<5줄 ≈ 48% solve" 구간.
- **localize 직접성:** L0 — 이슈가 심볼·누락호출을 적어준다. 탐색 비용 0.
- **repro:** 명시적 재현코드는 없으나(`has-repro` 미부여), 결함 메커니즘이 본문에 완전 서술돼 사실상 재현 불필요.
- **도메인/추론:** K-Domain이지만 얕다 — `save_m2m` 한 프로토콜만 알면 됨. constraint 추론도 가드 한 줄로 국소적.
- **P2P trap:** PASS_TO_PASS 87개로 넓은 편이라 `regression-trap` 부여. 다만 trap이 단일 지점(가드 누락)에 집약돼 회피 난이도가 낮아 T3로 올리지 않음.

T1이 아닌 이유: 순수 K-Gen·자명 픽스가 아니라, 가드 조건을 django forms 계약에서 도출해야 하므로 "존나쉬움"보다 한 칸 위. T3/T4가 아닌 이유: 실질 추론량·localize 노력·refactor가 모두 미미하고 단일 파일 2줄이라 중간 난이도 프로파일에 못 미친다.

## 골드패치 분석
- **건드린 파일/함수:** `django/contrib/auth/forms.py` : `UserCreationForm.save`
- **근본 원인:** `UserCreationForm`이 `ModelForm.save`를 오버라이드해 `user.set_password(self.cleaned_data["password1"])` 로직을 추가하면서, `commit=True` 경로에서 부모 `ModelForm`이 수행하던 deferred M2M 저장 호출을 빠뜨렸다. 부모 `BaseModelForm.save`는 `commit=True`면 `instance.save()` 후 `self._save_m2m()`을, `commit=False`면 인스턴스에 `save_m2m` 콜러블을 attach해 호출자에게 위임한다. 오버라이드 버전은 `if commit: user.save()`만 수행하고 끝나 M2M이 영구 유실됐다.
- **수정 요지:**
```python
         if commit:
             user.save()
+            if hasattr(self, "save_m2m"):
+                self.save_m2m()
         return user
```
`commit` 블록 안 `user.save()` 직후 `save_m2m`을 호출하되, `hasattr` 가드로 M2M 필드가 없는 폼(대다수 기존 사용처)에서는 no-op이 되게 한다. `save_m2m`은 폼에 M2M 필드가 있을 때만 인스턴스에 존재하므로 가드가 회귀를 막는 핵심 장치.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_custom_form_saves_many_to_many_field (auth_tests.test_forms.UserCreationFormTest)` — M2M 필드(`orgs`)를 포함한 커스텀 `UserCreationForm`이 `save(commit=True)` 시 M2M 데이터를 실제 DB에 반영하는지 검사.
- **증명 방식:** 신규 fixture 모델 `CustomUserWithM2M`/`Organization`(`tests/auth_tests/models/with_many_to_many.py`)을 import하고, `Meta.fields = UserCreationForm.Meta.fields + ("orgs",)`인 폼을 정의. `Organization` 1개 생성 → `orgs=[str(organization.pk)]`로 valid 검증(`assertIs(form.is_valid(), True)`) → `form.save(commit=True)` → `assertSequenceEqual(user.orgs.all(), [organization])`로 M2M 관계가 저장됐음을 확인. 픽스 전이면 `user.orgs.all()`가 비어 마지막 단언에서 실패.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만(`overfit-risk` 미부여 — 픽스가 special-case가 아니라 부모 계약 복원이라 일반화가 자명), 테스트가 실제 M2M effect(DB readback)를 관찰하므로 vacuous 통과 불가. special-case로 통과시킬 우회로가 좁다.
- **regression 관점:** PASS_TO_PASS 87개 중 다수 `UserCreationFormTest`(`test_success`, `test_custom_form`, `test_invalid_data` 등)가 M2M 없는 폼의 `save()`를 거친다. `hasattr` 가드 덕에 이들은 `save_m2m` 속성 부재 → no-op으로 byte-identical 동작. 가드를 빼면 이 P2P 군이 AttributeError로 무더기 깨진다.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈가 `UserCreationForm.save(commit=True)`와 "`self.save_m2m()` 누락", 대조군 `django.forms.ModelForm`을 명시 → `django/contrib/auth/forms.py`의 `UserCreationForm.save`를 열고, `django/forms/models.py`의 `BaseModelForm.save`와 diff. 부모가 `commit=True` 때 `self._save_m2m()`을, `commit=False` 때 `self.save_m2m = self._save_m2m`을 거는 패턴을 확인하면 누락 지점이 곧장 드러난다.

2. **픽스와 왜 올바른 일반화인가:** `if commit:` 블록의 `user.save()` 직후 `if hasattr(self, "save_m2m"): self.save_m2m()` 추가. 이것이 overfit이 아닌 이유 — 테스트의 `orgs` 필드에 특화된 분기가 아니라, **부모 `ModelForm`의 deferred-m2m 계약을 그대로 복원**한 것. 임의의 M2M 필드 조합·필드 수에 대해 동작하며, 부모와 동일한 시맨틱(commit 시 모든 m2m flush)을 따른다. 테스트가 `orgs` 하나만 검증해도 픽스는 그 입력공간을 넘어 일반적이다.

3. **regression 안전:** PASS_TO_PASS의 M2M 없는 `UserCreationForm`/`UserChangeForm`/`AdminPasswordChangeForm` 등 다수 save 경로를 안 깨야 한다. `hasattr` 가드가 핵심 — `save_m2m`은 폼에 m2m 필드가 있을 때만 인스턴스 속성으로 존재하므로, 없는 폼에서는 가드가 거짓→no-op이라 기존 동작 보존. 가드 위치를 `if commit:` 안에 둔 것도 중요: `commit=False`일 때는 호출자가 직접 `save_m2m`을 부르게 둬야 하므로 여기서 부르면 계약 위반.

4. **함정 회피:** 오라클 없는 에이전트의 최빈 실수는 **가드 없이 `self.save_m2m()`만 추가**하는 것 — M2M 필드 없는 폼에서 `save_m2m` 속성 부재로 AttributeError가 터져 P2P 다수가 깨진다(FAIL_TO_PASS는 통과하지만 회귀). 회피법: 부모 `BaseModelForm.save`를 반드시 정독해 `save_m2m`이 **`commit=False` 경로에서만 attach되는 조건부 속성**임을 파악하고 `hasattr` 가드를 두는 것. 두 번째 함정은 호출을 `if commit:` 밖에 두는 것 — `commit=False`인데 호출하면 호출자 위임 계약을 깨고 즉시 flush해버린다. 셋째, 검증 테스트를 직접 작성하려면 신규 fixture 모델(`with_many_to_many.py`의 `CustomUserWithM2M`/`Organization`)이 필요하므로, 픽스 코드만으론 FAIL_TO_PASS를 재현 못 할 수 있음에 유의.
