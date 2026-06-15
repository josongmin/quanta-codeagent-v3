---
instance_id: django__django-13112
repo: django/django
base_commit: 09914ccf688974e068941f55412b930729bafa06
version: 3.2
difficulty: <15 min fix
created_at: 2020-06-26T04:51:38Z
fail_to_pass: 1
pass_to_pass: 63
gold_files: [django/db/models/fields/related.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13112

## 문제 요약
대소문자가 섞인 app 라벨(예: `DJ_RegLogin`)을 가진 앱에서 ForeignKey를 사용하면 Django 3.1b1에서 `migrate`/`makemigrations`가 크래시한다. 증상은 `ValueError: The field DJ_RegLogin.Content.category was declared with a lazy reference to 'dj_reglogin.category', but app 'dj_reglogin' isn't installed` 형태로, FK가 가리키는 타깃 참조 문자열이 전체가 소문자로 뭉개져 실제 등록된 mixed-case app 라벨과 매칭되지 않는다. 3.0에서는 정상 동작했던 회귀(regression)이며, hints가 회귀 커밋 `9e1b6b8a66`을 지목하고 잠정 패치까지 제시한다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)**: 이슈가 파일/심볼을 직접 지목하진 않지만, 에러 메시지 `'dj_reglogin.category'`가 입력 라벨 `DJ_RegLogin`을 통째로 소문자화한 형태라는 점 + hints가 회귀 커밋과 후보 패치(`related.py`)를 제공한다. "lazy reference 문자열을 어디서 소문자화하나"를 grep하면 `ForeignObject.deconstruct()`의 `self.remote_field.model.lower()` 단일 후보로 수렴한다. 직접 핀포인트(L0)는 아니고 약간의 추론·grep이 필요하므로 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점은 거의 자명하지만, 올바른 식은 "전체 `.lower()`"가 아니라 "`app_label`은 보존하고 `model_name`만 소문자화"라는 **불변식 추론**으로 합성해야 한다. 단순히 `.lower()`를 지우거나 후보를 여러 개 던져 테스트로 고르는 G&V(S3/S4)가 아니라, app 라벨이 마이그레이션에서 case-sensitive이고 model_name은 `label_lower`로 정규화된다는 두 제약을 따져 조건식(`'.' in model` 분기 + split 후 부분 lower)을 머리로 도출하는 의미적 수리다.
- **K (Knowledge) = K-Domain**: django migrations/ORM 내부 계약 지식이 병목이다. lazy reference 해소가 app_label은 대소문자 구분, model_name은 `_meta.label_lower`로 소문자 정규화한다는 점, `deconstruct`가 migration state 직렬화 경로라는 점을 알아야 "왜 부분 lower가 정답인지"를 판단할 수 있다. 일반 파이썬 추론(K-Gen)만으론 `.lower()` 전체 제거 같은 과수정에 빠지기 쉽다.

**Primary type = T-ConstraintReason**: 위치는 L1로 좁혀지나 진짜 난점이 "올바른 조건식·소문자화 범위를 추론으로 합성"하는 데 있다. APR 관점에서 SemFix/Angelix류의 semantic repair — 결함 위치는 한 줄이지만 정답은 도메인 불변식(app_label case-sensitivity)을 만족하는 식의 재합성이며, 템플릿 매칭(S1)으로는 "model_name만 보존" 변환이 안 나온다.

## 난이도 티어
**Tier = T3 (중간)**. 공식 라벨은 `<15 min fix`(가장 쉬움, T1~T2 prior)지만 한 단계 올려 T3로 둔다.

- **T3로 미는 피처**:
  - 단일 파일·단일 함수·실질 +5줄의 소규모 수정이지만, **localize 직접성이 L1**(에러 표면=`migrate` 런타임, 실제 결함=`deconstruct` 직렬화 시점이라 인과 거리가 있음).
  - 픽스가 S2 의미추론을 요구 — "전체 lower vs model_name만 lower"의 판단이 정답/오답을 가른다. 기계적 가드 추가(S1)가 아니다.
  - **regression-trap**: PASS_TO_PASS 63개가 대부분 `test_state`의 model state/related-models 테스트로, deconstruct의 `to` 정규화에 직접 의존한다. `.lower()`를 통째로 지우면 `label_lower` 일관성을 깨 다수 회귀가 난다(과수정 함정).
- **공식 라벨과 다른 이유**: `<15 min fix`는 *정답을 아는 개발자의 구현 시간*이다. hints에 후보 패치가 있어 인간에겐 15분이지만, 오라클 없는 에이전트에겐 (a) split 후 부분 lower라는 비자명한 범위 결정과 (b) dot-less 분기 누락 시 `ValueError(split)` 함정이 있어 T1로 보긴 어렵다. 다만 has-repro(네이티브 ValueError 스택)와 좁은 patch scope가 T4 이상으로 올리는 것도 막으므로 T3가 적정.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/related.py` — `ForeignObject.deconstruct()` (line ~582, `kwargs['to']` 생성 분기).
- **근본 원인**: `self.remote_field.model`이 문자열(lazy reference, 예 `'DJ_RegLogin.Category'`)일 때 무조건 `self.remote_field.model.lower()`를 호출해 문자열 **전체**를 소문자화했다. 그 결과 model_name뿐 아니라 **app_label까지 소문자**가 되어 `dj_reglogin.category`가 된다. app 라벨은 migration state에서 대소문자를 구분하므로, 이후 lazy reference 해소 시 등록된 `DJ_RegLogin`(또는 `MiXedCase_migrations`) 앱을 못 찾아 `ValueError`로 크래시한다. 회귀 커밋 `9e1b6b8a66`에서 도입된 결함.
- **수정 요지**: 문자열에 `.`이 있으면 `app_label, model_name = self.remote_field.model.split('.')`로 분리해 `'%s.%s' % (app_label, model_name.lower())`로 **model_name만** 소문자화하고 app_label 원본 대소문자를 보존한다. `.`이 없는(self/단일 모델 참조) 경우는 기존대로 전체 lower. 즉 소문자화 대상을 model_name으로만 좁히고, hints의 단순 split-only 버전이 dot-less 입력에서 터질 위험을 `'.' in` 가드로 막은 더 안전한 형태다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `migrations.test_state.StateTests.test_reference_mixed_case_app_label`.
- **동작 / 픽스 증명**: 신규 테스트가 `app_label = 'MiXedCase_migrations'`(대소문자 혼합)로 `Author`, `Book`(`ForeignKey`), `Magazine`(`ManyToManyField`) 세 모델을 정의하고, `ProjectState`에 `ModelState.from_model()`로 등록한 뒤 `project_state.apps.get_models()`를 호출한다. FK와 M2M 둘 다 deconstruct를 거치므로 두 코드경로를 함께 커버한다. 픽스 전: app_label이 소문자로 뭉개져 lazy reference 해소가 실패(dangling reference `ValueError`). 픽스 후: app_label 보존으로 3개 모델이 정상 렌더되어 `len(project_state.apps.get_models()) == 3` 성립.
- **overfit 관점**: 테스트는 단 1개지만 special-case가 아니라 mixed-case 라벨이라는 **결함 클래스의 대표 입력**을 직접 친다(FK+M2M 양 경로). 정답 식이 "model_name만 lower"라는 일반 규칙이라 이 입력 너머로도 옳게 일반화된다 — overfit-risk 플래그는 달지 않음(S4가 아니라 S2).
- **regression 관점**: PASS_TO_PASS 63개가 deconstruct/state 정규화에 의존하므로 regression-trap. 핵심은 `.lower()`를 제거하지 않고 dot-less 분기를 보존하는 것 — 이 둘을 지키면 `test_render`, `test_*_fk/m2m`, `label_lower` 일관성 테스트가 전부 그린.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 에러 문자열 `'dj_reglogin.category'`가 입력 `DJ_RegLogin.Category`를 **통째로** 소문자화한 형태임을 인지 → 도메인 지식상 model_name은 소문자 정규화가 맞지만 app_label은 case-sensitive여야 함을 떠올림 → "lazy reference(문자열) 모델 참조를 어디서 `.lower()` 하나"를 grep → `related.py`의 `ForeignObject.deconstruct()` 내 `kwargs['to'] = self.remote_field.model.lower()` 단일 지점으로 수렴(hints의 회귀 커밋·후보 패치가 이를 확증).
2. **픽스와 올바른 일반화 이유**: `model` 문자열에 `.`이 있으면 `app_label.model_name`으로 split해 `app_label`은 보존, `model_name`만 lower. 이게 옳은 일반화인 이유는 — (a) 비문자열 분기는 이미 `_meta.label_lower`로 동일 규칙(app_label 보존 + name lower)을 쓰므로 두 분기의 동작을 일치시키는 것이고, (b) 모든 mixed-case 라벨에 작동하는 규칙이지 테스트 입력에만 맞춘 패치가 아니다.
3. **regression 안전**: `.`이 없는 self-reference/단일 모델명(예 `'Author'`)은 split이 2-튜플을 못 만들어 `ValueError`를 내므로 **반드시 else 분기로 기존 전체 lower 유지**. 이로써 `test_self_relation`, `test_direct_fk`/`test_direct_m2m`, `test_render*`, `label_lower` 의존 테스트 63개가 안 깨진다. PASS_TO_PASS가 deconstruct 정규화에 광범위 의존하므로 변경은 mixed-case 경로에만 국소화돼야 한다.
4. **함정 회피**: 오라클 없는 에이전트의 두 오답 — (1) **`.lower()` 통째 제거**: model_name 정규화가 깨져 다수 P2P 회귀(과수정). (2) **hints의 split-only 버전 그대로 채택**: dot-less 입력에서 `app_label, model_name = model.split('.')`가 `ValueError`를 던져 self-reference 케이스를 새로 깨뜨림. 정답은 소문자화 범위를 model_name으로 좁히고 `'.' in self.remote_field.model` 가드로 dot-less 분기를 보존하는 최소·안전 변경이다.
