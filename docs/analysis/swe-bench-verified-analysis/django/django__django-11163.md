---
instance_id: django__django-11163
repo: django/django
base_commit: e6588aa4e793b7f56f4cadbfa155b581e0efc59a
version: "3.0"
difficulty: <15 min fix
created_at: 2019-04-02T21:46:42Z
fail_to_pass: 1
pass_to_pass: 141
gold_files: [django/forms/models.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-11163

## 문제 요약
`model_to_dict(instance, fields=[])` 처럼 빈 필드 리스트를 넘기면, "요청한 필드가 없음"이므로 빈 dict `{}`를 반환해야 한다. 그런데 실제로는 모든 필드를 반환한다. 사용자는 빈 리스트를 "아무 필드도 선택하지 않음"으로 기대했지만, 함수는 이를 "필터 없음(전체)"으로 잘못 해석한다. 이슈 본문이 버그 라인(`if fields and f.name not in fields:`), 수정안(`if fields is not None and ...`), 그리고 원본 PR 링크(#11150)까지 그대로 명시해 준다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈가 파일이 아니라 **정확한 한 줄과 그 위치의 표현식**까지 지목한다. `model_to_dict`로 grep 한 방. 후보 탐색이 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조).** 이슈가 픽스를 글자 그대로 적어줘서 dominant는 기계적 템플릿 매칭(falsy-vs-None 가드 교체 = 정형 결함클래스 "빈 컬렉션 truthiness 혼동")이다. S1로 본다. 다만 *왜* `is not None`이 맞고 옆 줄 `exclude`는 건드리면 안 되는지를 따지려면 빈 리스트의 의미론(선택 집합 vs 제외 집합)을 추론해야 하므로 S2를 보조로 단다 — 이게 과교정을 막는 핵심 reasoning이다.
- **K (Knowledge) = K-Gen.** django 내부 지식이 아니라 순수 Python truthiness(`[] is falsy`)와 일반 함수 계약 추론으로 충분. ORM/쿼리컴파일러 같은 도메인 깊이 불요.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 S1 기계적 가드 교체. T-LocTrivial이 아니라 T-DirectMap인 이유: 픽스가 "한 줄 추가"가 아니라 **기존 falsy 가드를 None-가드로 교체**하는 정형 결함클래스 매핑이고, 옆 줄 `exclude`와의 비대칭 때문에 완전 자명(trivial)까지는 아니기 때문. APR 관점에서 PAR/TBar류 픽스 템플릿("falsy-collection guard → explicit None guard")에 1:1 매칭되는 전형적 Direct-Map 케이스.

## 난이도 티어
**T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- **파일/줄수:** 1파일 1함수, gold가 정확히 **1줄 교체**(`if fields and` → `if fields is not None and`). ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 컷의 가장 쉬운 끝.
- **localize 직접성:** L0 — 이슈가 라인과 수정 문자열을 다 적어줌. localization 에러(실패의 ~51%)가 발생할 여지 자체가 없음.
- **has-repro:** 재현 호출(`model_to_dict(instance, fields=[])`)이 본문에 명시(가장 강한 easiness 신호).
- **K-Gen:** 도메인 지식 병목 없음.

공식 라벨(`<15 min fix`)과 **일치**. 시간라벨이 잡지 못하는 localize 난이도/overfit 위험도 여기선 모두 낮아 재조정 불필요. 유일하게 T1을 살짝 위로 당길 뻔한 요소는 `regression-trap`(아래 줄 `exclude`를 같이 바꾸는 과교정)인데, test_patch가 `exclude=[]`→전체를 단언해 즉시 잡아주므로 테스트 피드백만으로 자가교정 가능 → T1 유지.

## 골드패치 분석
- **건드린 파일/함수:** `django/forms/models.py` 의 `model_to_dict(instance, fields=None, exclude=None)`.
- **근본 원인:** 필드 필터 분기 `if fields and f.name not in fields:`. `fields=[]`(빈 리스트)는 Python에서 falsy라 `fields and ...`가 단락 평가로 즉시 False가 되어 **필터링 자체가 스킵**된다. 결과적으로 "빈 선택(`[]`)"과 "필터 미지정(`None`, 기본값)"이 구분되지 않고 둘 다 전체 필드를 통과시킨다 — 의도와 정반대.
- **수정 요지:** 조건을 `if fields is not None and f.name not in fields:` 로 교체. falsy 여부가 아니라 명시적 `None` 여부로 분기한다. 이제 `fields=[]`는 not-None이므로 모든 `f.name`이 `not in []`에 걸려 전부 제외 → `{}` 반환. `fields=None`일 때만 필터를 건너뛴다. 정확히 한 줄 변경. 바로 아래 `if exclude and f.name in exclude:`는 **의도적으로 그대로 둔다**(빈 exclude의 의미 "제외 없음=전체"가 falsy 동작과 일치하므로).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_modelform_subclassed_model (model_forms.tests.ModelOneToOneFieldTests)`.
- **픽스 증명:** `BetterWriter` 인스턴스(`id, name, score, writer_ptr`)에 대해 네 단언을 추가:
  - `model_to_dict(bw, fields=[])` → `[]` — **핵심 회귀 단언.** 버그 상태에선 전체 필드를 반환해 `[]`와 불일치 → FAIL. 픽스 후 `{}` → PASS.
  - `model_to_dict(bw, fields=['id', 'name'])` → `['id', 'name']` — 정상 부분 선택 보존.
  - `model_to_dict(bw, exclude=[])` → 전체 필드 — **과교정 가드.** 누군가 exclude까지 `is not None`으로 바꾸면 여기서 빈 dict가 나와 FAIL.
  - `model_to_dict(bw, exclude=['id', 'name'])` → `['score', 'writer_ptr']` — 정상 제외 보존.
- **overfit 관점:** FAIL_TO_PASS는 1개지만 단언이 fields/exclude × 빈/비빈 4축을 cover해 `fields=[]`만 special-case로 통과시키는 얄팍한 픽스를 배제한다. overfit 위험 낮음(`overfit-risk` 플래그 미부여).
- **regression 관점:** `regression-trap` 부여. PASS_TO_PASS 141개가 model_forms 전반(ModelFormBaseTest/UniqueTest/FileAndImageFieldTests 등)을 덮어, `model_to_dict` 분기를 잘못 바꾸면(특히 `fields`의 None 기본 경로 또는 exclude 동작) 광범위 회귀가 난다. 골드의 1줄 핀포인트 변경이 이 P2P를 모두 보존함.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 본문이 버그 표현식 `if fields and f.name not in fields:`와 함수명을 그대로 줌 → `rg "model_to_dict" django/forms/models.py`로 단번에 해당 분기 도달. 탐색 노력 거의 0(L0).
2. **픽스 & 올바른 일반화:** `fields` 가드를 `if fields is not None and f.name not in fields:`로 교체. 이게 overfit이 아닌 이유 — "빈 리스트=빈 선택"이라는 **의미를 truthiness가 아니라 sentinel(`None`)로 표현**하도록 계약을 바로잡는 것이라, `fields=[]`뿐 아니라 임의의 부분집합·`None` 기본 경로 모두에 일관되게 성립한다(special-case 분기 추가가 아님).
3. **regression 안전:** `fields=None`(기본 호출, 압도적 다수의 P2P 경로)는 여전히 not-None 검사에서 False → 필터 스킵 → 기존 전체 필드 동작 보존. 141개 P2P 중 model_to_dict를 기본값으로 부르는 모든 케이스가 byte-identical하게 유지됨. exclude 동작도 미변경이라 exclude 계열 P2P 무영향.
4. **함정 회피:** 오라클 없는 에이전트의 유일한 실족 지점은 **바로 아래 `if exclude and f.name in exclude:`를 대칭으로 같이 `is not None`으로 바꾸는 과교정**. 그러나 `exclude=[]`의 자연 의미는 "아무것도 제외 안 함=전체"라서 현재 falsy 동작이 *맞다* — fields만 의미가 뒤집힌다는 비대칭을 이해해야 한다. 인지 못 해 둘 다 바꾸면 test_patch의 `model_to_dict(bw, exclude=[])`→전체 단언이 즉시 RED로 잡아내므로, 테스트를 돌리는 에이전트는 자가교정 가능. 결국 "빈 컬렉션 truthiness 함정 + fields/exclude 의미 비대칭" 인지가 전부.
