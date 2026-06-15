---
instance_id: django__django-15380
repo: django/django
base_commit: 71e7c8e73712419626f1c2b6ec036e8559a2d667
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-31T19:44:44Z
fail_to_pass: 1
pass_to_pass: 133
gold_files: [django/db/migrations/autodetector.py]
---

# django__django-15380

## 문제 요약
한 번의 `makemigrations`에서 모델 rename과 그 모델의 필드 rename을 동시에 하면 autodetector가 `KeyError`로 크래시한다. 사용자가 모델 rename 질문에 `y`로 답하면 `generate_renamed_fields()`에서 `self.to_state.models[app_label, old_model_name]` 조회가 옛 모델명(이미 새 이름으로 바뀐 to_state에는 존재하지 않음)으로 들어가 KeyError가 난다. 사용자는 RenameModel + RenameField 두 오퍼레이션이 정상 생성되길 기대했다.

## 유형 분류
- 버그 카테고리: regression (커밋 aa4acc164d1247c0de515c959f7b09648b57dc42에서 도입)
- 서브시스템: django migrations / autodetector (makemigrations)
- 증상 타입: 예외 / 크래시 (KeyError)
- 로컬라이제이션 신호: problem_statement의 traceback이 정확한 파일·함수·라인을 지목 — `autodetector.py`, `generate_renamed_fields`, line 823 `new_model_state = self.to_state.models[app_label, old_model_name]`. "Regression in <sha>"까지 명시.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py:generate_renamed_fields`
- 근본 원인: from_state(이전 상태)는 옛 모델명을 쓰지만 to_state(새 상태)는 이미 rename된 새 모델명을 키로 가진다. 회귀 커밋이 old_model_state와 new_model_state 둘 다 `old_model_name`으로 조회하도록 만들어, 모델이 동시에 rename되면 to_state에는 `old_model_name`이 없어 KeyError 발생.
- 수정 요지: new_model_state 조회만 `old_model_name` → `model_name`(새 모델명)으로 바꾼다. old_model_state는 `renamed_models.get(...)`로 풀어낸 `old_model_name`을 그대로 from_state에서 조회하고, new_model_state는 새 키 `(app_label, model_name)`으로 to_state에서 조회하도록 정정. 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_rename_field_with_renamed_model` — `Author(name)` 모델을 `RenamedAuthor(renamed_name)`으로 모델·필드 동시 rename.
- 테스트가 증명하는 방식: `MigrationQuestioner({'ask_rename_model': True, 'ask_rename': True})`로 두 rename에 모두 yes 응답. 픽스 전에는 `generate_renamed_fields`에서 KeyError로 크래시. 픽스 후 testapp에 마이그레이션 1개, 오퍼레이션 타입 `['RenameModel', 'RenameField']` 순서로 생성되고 각각 `old_name='Author'→'RenamedAuthor'`, `old_name='name'→'renamed_name'` 속성을 가짐을 단언.

## 공략 포인트 (뭘 조져야)
- 어디부터: traceback이 라인 단위로 다 알려주므로 `generate_renamed_fields`의 from_state/to_state 조회 두 줄을 비교하면 끝. old vs new 상태의 모델명 비대칭이 핵심.
- 함정/난이도: 멀티파일 아님(소스 1파일 1라인). 헷갈릴 지점은 `old_model_name = self.renamed_models.get((app_label, model_name), model_name)` — 모델이 rename된 경우에만 old≠new가 되어 버그가 드러난다. from_state에는 old 키, to_state에는 new 키라는 상태별 키 규칙을 이해해야 "to_state는 model_name이어야 한다"는 결론에 도달.
- 우리 에이전트 관점: 막힐 위험은 낮음. 다만 두 줄 모두 `old_model_name`을 쓰는 게 정상처럼 보여 무심코 from_state 쪽도 같이 건드리는 과교정 위험. to_state만 model_name으로 바꾸는 비대칭성이 정답임을 놓치지 말 것.
