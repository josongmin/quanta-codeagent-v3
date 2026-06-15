---
instance_id: django__django-14493
repo: django/django
base_commit: 7272e1963ffdf39c1d4fe225d5425a45dd095d11
version: 4.0
difficulty: <15 min fix
created_at: 2021-06-05T12:50:25Z
fail_to_pass: 1
pass_to_pass: 36
gold_files: [django/contrib/staticfiles/storage.py]
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-14493

## 문제 요약
`ManifestStaticFilesStorage`를 상속해 `max_post_process_passes = 0`으로 설정하면 `collectstatic` 실행 시 크래시가 난다. `HashedFilesMixin.post_process()` 내부의 `for i in range(self.max_post_process_passes)` 루프가 한 번도 돌지 않으면, 루프 본문 첫 줄에서만 초기화되는 `substitutions` 지역변수가 바인딩되지 않은 채 루프 종료 후 `if substitutions:` 분기에서 참조되어 `UnboundLocalError: local variable 'substitutions' referenced before assignment`가 발생한다. 사용자가 pass를 0으로 끄려는 동기는 잘못된 CSS 생성(django ticket #21080)을 막기 위함이며, 0으로 꺼도 collectstatic이 정상 동작하길 기대한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — problem_statement의 트레이스백이 파일·라인·변수까지 그대로 명시한다: `django/contrib/staticfiles/storage.py:251`의 `if substitutions:`, 그리고 "substitutions is only set if the loop is entered at least once"라는 인과 설명, GitHub 영구링크(L246-L257)까지 박혀 있다. grep 한 방, 사실상 localize 비용 0.
- **S1 (Direct-Map)** — 정형 결함클래스(루프가 0회 도는 경계에서 변수 미초기화 → use-before-assignment)에 템플릿 매칭. 픽스는 "루프 진입 전 기본값 초기화 1줄 추가"라는 기계적 패턴이며 이슈가 이미 픽스를 사실상 명세한다(추론 합성 불필요 → S2 아님, 후보 다수 아님 → S3/S4 아님).
- **K-Gen** — 일반 파이썬 스코프 규칙(지역변수는 할당 지점에서 바인딩, 0회 루프면 미바인딩)만으로 충분. staticfiles 도메인 지식은 *원인 이해*에 무관하고 픽스 도출에도 불필요. (서브시스템이 staticfiles일 뿐, 병목이 도메인지식이 아니므로 K-Domain 아님.)
- **primary type: T-LocTrivial** — L0 + S1의 정의 그대로. 찾으면 끝, 픽스 자명. 이슈가 결함 라인·원인·해법을 거의 적어준다.
- **왜 이 repair strategy인가 (APR 관점):** PAR/TBar류 템플릿 수리에서 "uninitialized-variable-on-empty-loop"는 표준 fix pattern(루프 밖으로 기본값 호이스팅)이다. SemFix/Angelix식 제약 합성(올바른 식·조건 추론)이 전혀 필요 없고, 테스트 피드백으로 후보를 걸러내는 G&V/CEGIS 반복도 불필요하다 — 정답 패치 공간이 단일점에 수렴하므로 dominant strategy는 S1.

## 난이도 티어
**T1 (존나쉬움).** 공식 라벨 "<15 min fix"와 정확히 일치한다.
- 이 티어로 미는 구조적 피처: 단일 파일(`gold_files` 1개) · 1줄 추가 · L0 직접 localize(트레이스백에 파일·라인·변수·원인 전부) · `has-repro`(네이티브 스택트레이스 = 가장 강한 easiness 신호, 해결률 ~87%) · K-Gen.
- T1 프로파일(L0 + S1, 1파일 ≲10줄, has-repro, K-Gen)에 모든 항목이 부합한다.
- 유일한 상향 요인은 `regression-trap`(PASS_TO_PASS 36개)이지만, 이는 루프 구조를 건드리지 않는 호이스팅 1줄이라 인접 동작에 영향이 없어 실질 난이도를 끌어올리지 못한다 — T2로도 밀지 않는다. 공식 라벨과 본 티어가 일치하므로 별도 재조정 근거 불필요.

## 골드패치 분석
- **건드린 파일·함수:** `django/contrib/staticfiles/storage.py` → `HashedFilesMixin.post_process()`.
- **근본 원인:** `substitutions = False`가 `for i in range(self.max_post_process_passes):` 루프 본문 첫 줄에서만 초기화된다. `max_post_process_passes = 0`이면 루프가 0회 실행 → 변수 미바인딩 상태로 루프 종료 후 `if substitutions:`("최대 패스를 다 써도 치환이 남았다"는 경고 yield 경로)에 도달 → `UnboundLocalError`.
- **수정 요지:** 루프 직전, `paths = {path: paths[path] for path in adjustable_paths}` 줄 다음에 `substitutions = False` 한 줄을 추가해 루프 실행 횟수와 무관하게 변수가 항상 정의되도록 보장. 0 pass면 치환이 없으므로 `False`가 의미상 올바른 기본값이고, 루프가 1회 이상 돌면 본문 내 기존 `substitutions = False` 및 이후 재할당이 정상적으로 덮어쓴다(멀티패스 시맨틱 불변).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_collectstatistic_no_post_process_replaced_paths` — `tests/staticfiles_tests/storage.py`에 `max_post_process_passes = 0`인 신규 스토리지 `NoPostProcessReplacedPathStorage`를 추가하고, `TestCollectionNoPostProcessReplacedPaths`(`run_collectstatic_in_setUp = False`)에서 `run_collectstatic(verbosity=1)`을 직접 호출 후 stdout에 `'post-processed'`가 포함됨을 단언한다.
- **픽스 증명:** 패치 전에는 `run_collectstatic` 호출 자체가 `UnboundLocalError`로 터져 단언에 도달조차 못 한다 → 예외 제거가 통과의 필요충분 조건. `'post-processed'` 출력 확인으로 "0 pass여도 post-process 파이프라인이 정상 완주"까지 함께 검증한다.
- **overfit 관점:** 골드 픽스가 입력 의존 없는 무조건 초기화 1줄이라 special-case로 통과시킬 여지가 없다 — `overfit-risk` 플래그 비해당(FAIL_TO_PASS 1개지만 픽스 공간이 단일점이라 얇은 테스트로도 과소명세되지 않음).
- **regression 관점:** `regression-trap` 표기 — PASS_TO_PASS 36개가 ManifestStorage post-processing 동작 전반(멀티패스, 매니페스트, 템플릿태그, 권한 등)을 커버한다. 정답 호이스팅은 루프 시맨틱을 바꾸지 않아 이들을 안전하게 보존한다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 트레이스백이 `storage.py:251 if substitutions:`와 `UnboundLocalError`, 그리고 "substitutions is only set if the loop is entered at least once"를 직접 준다 → 곧장 `HashedFilesMixin.post_process()`만 열어 `substitutions` 라이프사이클을 추적한다. 추가 탐색 불필요.
2. **픽스와 일반화 근거:** 루프 *밖, 진입 전*에 `substitutions = False`를 추가한다. 이것이 overfit이 아닌 올바른 일반화인 이유 — "0회 루프 시 변수 미바인딩"이라는 근본 원인을 입력 무관하게 제거하므로, `max_post_process_passes`가 0이든 N이든 항상 정의 보장. `== 0` 특수분기로 우회하는 것보다 결함 클래스 자체를 봉인한다.
3. **regression 안전:** PASS_TO_PASS 36개(특히 멀티패스를 도는 `test_intermediate_files`, `test_aggregating_modules` 등)를 안 깨야 한다. 호이스팅한 기본값은 루프가 1회 이상 돌면 본문 첫 줄 `substitutions = False`가 즉시 덮어쓰므로 멀티패스 경로의 거동이 바이트 동일하게 유지된다 → 안전.
4. **함정 회피:** 오라클 없는 에이전트의 오답 지점 — (a) 루프 *본문 안*의 기존 `substitutions = False`를 옮기거나 제거하면 매 패스 리셋이 사라져 멀티패스 로직이 깨진다(PASS_TO_PASS 회귀). (b) `max_post_process_passes == 0` 특수분기·early-return을 넣는 오버엔지니어링은 불필요한 복잡도와 회귀 위험. (c) `if substitutions:` 분기를 "치환 검사"로 오해해 조건 자체를 손대면 안 됨 — 이는 "최대 패스 초과 경고 yield" 경로다. 정답은 호이스팅 1줄로 끝낸다.
