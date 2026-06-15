---
instance_id: django__django-15104
repo: django/django
base_commit: a7e7043c8746933dafce652507d3b821801cdc7d
version: "4.1"
difficulty: <15 min fix
created_at: 2021-11-19T20:46:58Z
fail_to_pass: 1
pass_to_pass: 131
gold_files: [django/db/migrations/autodetector.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-15104

## 문제 요약
`to` 인자를 하드코딩하고 `deconstruct()` 시 그 키를 kwargs에서 제거하는 커스텀 `ForeignKey` 필드를 쓰면, 마이그레이션 autodetector가 `KeyError: 'to'`로 크래시한다. 증상은 `python manage.py test -v 2`처럼 syncdb가 도는 경로에서 `generate_renamed_models` → `only_relation_agnostic_fields`가 변경 감지 중 터지는 것. problem_statement에 전체 traceback이 붙어있고 마지막 프레임이 `autodetector.py:99`의 `del deconstruction[2]['to']`를 지목하며, 사용자가 픽스(`deconstruction[2].pop('to', None)`)와 self-contained 재현 테스트까지 직접 제시했다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — 이슈 본문에 네이티브 traceback이 통째로 들어있어 파일·메서드·정확한 라인(`autodetector.py:99`, `only_relation_agnostic_fields`, `del deconstruction[2]['to']`)을 직접 지목한다. `grep "del deconstruction"` 한 방. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)** — 결함이 정형 결함클래스(존재 보장 안 된 dict 키에 대한 unsafe `del`)에 정확히 매칭된다. 픽스가 기계적이다: `del d[k]` → `d.pop(k, None)`은 "키 없으면 무시" 가드 템플릿. 이슈가 사실상 픽스를 명세하므로(사용자가 정답 한 줄을 적어줌) 추론 합성(S2)도, 테스트 반복(S3/S4)도 불필요하다.
- **K (Knowledge) = K-Gen (General)** — 일반 파이썬 지식으로 충분. `del`이 missing-key에서 KeyError를 던지고 `dict.pop(k, default)`가 안전하다는 건 표준 파이썬 의미. django ORM/autodetector 내부 동작을 깊이 이해할 필요 없이, "이 del이 키 없으면 터진다"는 사실만으로 픽스가 도출된다. (정확히 *왜* `to`가 제거되는지의 도메인 배경은 흥미롭지만 픽스에는 불필요.)
- **primary type = T-DirectMap** — L0(위치 명확) + S1(가드 추가라는 기계적 픽스). T-LocTrivial이 아닌 이유: 픽스가 "찾으면 끝"을 넘어 결함클래스 템플릿(None-safe 키 삭제) 적용이긴 하나 그조차 자명하므로, 위치-명확 + 기계적-가드인 T-DirectMap이 가장 정확하다.
- **왜 이 repair strategy인가 (APR 관점)** — PAR/TBar류 fix-pattern 매칭의 교과서 케이스. mutation operator로 치면 "unsafe-delete → safe-pop" 단일 변환이고, 검색공간이 1차원이라 generate-&-validate 루프가 필요 없다. 이슈가 oracle 패치를 그대로 적어줬으므로 spec-inference(S5)도 constraint-reasoning(S2)도 동원할 여지가 없다.

## 난이도 티어
**T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- **파일수 1 / 변경 1줄** — gold patch는 단일 파일 `autodetector.py`의 단일 헌크, 정확히 한 라인 교체. ICLR 2024 구조 컷에서 1파일·<5줄은 가장 쉬운 solve 구간(~48% baseline solve, 본 케이스는 그보다도 명확).
- **localize 직접성 최상** — L0. traceback이 라인을 짚고 사용자가 픽스를 제시. localization 실패(전체 실패의 ~51%)가 발생할 여지가 없음.
- **has-repro** — 네이티브 stack trace + self-contained 재현 코드 둘 다 존재. ORACLE-SWE 기준 repro 존재는 가장 강한 easiness 신호(해결률 ~87%).
- **K-Gen** — 도메인 지식 병목 없음.

공식 difficulty 라벨(`<15 min fix`)과 **일치**한다. 시간라벨이 가장 쉬운 구간이고, 본 분석의 구조피처(L0/S1/K-Gen/1줄/repro)도 모두 최저 난이도를 가리키므로 재조정 불필요.

단, **regression-trap** 플래그 1개가 붙는다: PASS_TO_PASS가 131개로 매우 넓다(autodetector 전체 동작 회귀군). 다만 이건 티어를 올리지 않는다 — 픽스가 동작-보존형(`del` 성공하던 경우 `pop`도 똑같이 제거)이라 인접 동작을 깰 의미적 경로가 없기 때문. trap은 "과교정(비교 의미를 바꾸는 수정)"을 했을 때만 발화한다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/migrations/autodetector.py` → `MigrationAutodetector.only_relation_agnostic_fields`
- **근본 원인**: 이 메서드는 FK들을 "관계 무관(relation-agnostic)"으로 비교하기 위해, 각 필드를 `deep_deconstruct`한 뒤 `field.remote_field and field.remote_field.model`이 참이면 deconstruct된 kwargs(`deconstruction[2]`)에서 `to` 키를 떼낸다(타겟 모델 차이를 비교에서 무시하려는 의도). 그런데 코드가 `del deconstruction[2]['to']`로 키 존재를 **무조건 가정**한다. 사용자의 커스텀 FK처럼 `deconstruct()`가 `to`를 이미 빼버리면 그 키가 없어 `del`이 `KeyError: 'to'`를 던지고, `generate_renamed_models` 경로 전체가 크래시한다.
- **수정 요지**: `del deconstruction[2]['to']` → `deconstruction[2].pop('to', None)`. 키가 있으면 동일하게 제거하고, 없으면 조용히 통과(default `None`). "to를 비교에서 제외"라는 원래 의도를 정확히 보존하면서 missing-key를 견딘다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_add_custom_fk_with_hardcoded_to (migrations.test_autodetector.AutodetectorTests)`. `__init__`에서 `kwargs['to']='testapp.Author'`로 하드코딩하고 `deconstruct()`에서 `del kwargs['to']`하는 `HardcodedForeignKey`를 정의한 뒤, 이 FK를 가진 `Book` 모델을 추가(`author_empty` → `author_empty` + `book_hardcoded_fk_to`)하는 변경을 감지시킨다.
- **픽스 증명**: 패치 전엔 변경 감지가 `only_relation_agnostic_fields`에서 KeyError로 죽는다(테스트가 에러로 실패). 패치 후엔 testapp에 마이그레이션 1개, 단일 `CreateModel(name='Book')` 오퍼레이션이 생성됨을 `assertNumberMigrations(changes,'testapp',1)` / `assertOperationTypes(...,['CreateModel'])` / `assertOperationAttributes(...,name='Book')`로 확인한다.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 표면적으로 얇지만, 픽스가 결함클래스의 근본(키 부재 일반)을 메우는 동작-보존형이라 special-case 통과가 불가능하다. CEGIS류 일반화 고민이 없는 케이스 — `pop(...,None)`은 모든 missing-`to` 입력을 한 번에 커버. `overfit-risk` 플래그를 달지 않는 이유다.
- **regression 관점**: PASS_TO_PASS 131개가 autodetector의 광범위한 동작(rename/proxy/m2m/swappable/order_with_respect_to/FK dependency 등)을 커버한다. `pop`은 `to`가 실제로 있던 모든 기존 경로에서 `del`과 byte-동치로 동작하므로 이 131개는 그대로 통과한다. trap은 "to 제거를 조건 분기로 바꾸거나 생략"하는 과교정에서만 발화.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 traceback 마지막 프레임 → `django/db/migrations/autodetector.py`, `only_relation_agnostic_fields`, line 99 `del deconstruction[2]['to']`. 신호가 라인을 직접 짚으므로 `grep "del deconstruction"` 또는 traceback 라인 점프 한 번이면 도착. cross-module 추적 불필요(L0).
2. **픽스와 왜 올바른 일반화인가**: `del deconstruction[2]['to']` → `deconstruction[2].pop('to', None)`. 근본원인은 "deconstruct 결과에 `to`가 항상 존재한다"는 무근거 가정. 커스텀 FK가 `to`를 빼는 건 합법(deconstruct 계약상 kwargs는 필드 재구성에 필요한 것만 담으면 됨)이므로, autodetector가 키 부재를 견디는 게 맞다. `pop(k, None)`은 "있으면 제거"라는 의도를 보존하면서 부재를 흡수 — special-case(특정 모델명/특정 필드)가 아니라 모든 missing-`to` 입력을 덮는 진짜 일반화.
3. **regression 안전**: `to`가 존재하던 종래 모든 FK 경로에서 `pop`은 `del`과 동일하게 키를 제거한다. 따라서 PASS_TO_PASS 131개(특히 FK dependency / proxy custom FK / rename referenced FK 계열)는 byte-동치로 안전. 비교 의미(타겟 모델 무시)도 불변.
4. **함정 회피**: 오라클 없는 에이전트의 오답 후보 — (a) `to` 제거 자체를 `if field.remote_field.model and 'to' in deconstruction[2]:` 같은 더 장황한 가드로 감싸기(기능 동치라 채점은 통과하나 최소변경이 아님), (b) 비교 의미를 바꾸려 `remote_field` 조건을 손대 과교정(131 P2P 중 FK 비교 동작을 깰 위험 = regression-trap 발화), (c) 커스텀 FK 재현 픽스처를 직접 짜내려다 시간 낭비. 회피법: traceback이 정답을 짚고 이슈가 동작-보존형 한 줄(`pop`)을 명시했으므로 그대로 적용하고, FK 비교 로직(`remote_field`/`only_relation_agnostic_fields`의 분기)은 절대 건드리지 않는다.
