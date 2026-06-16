---
instance_id: pytest-dev__pytest-7982
repo: pytest-dev/pytest
base_commit: a7e38c5c61928033a2dc1915cbee8caa8544a4d0
version: "6.2"
difficulty: "<15 min fix"
created_at: 2020-10-31T12:27:03Z
fail_to_pass: 1
pass_to_pass: 78
gold_files: [src/_pytest/pathlib.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
pytest 6.1.0부터 테스트 디렉터리 안의 심볼릭 링크 디렉터리가 수집(collect)되지 않고 그냥 건너뛰어진다. 이전 버전에서는 따라 들어가 정상 수집했었다. 이슈 작성자는 회귀 커밋(`b473e515`)을 직접 지목하며, 자신이 거기서 `follow_symlinks=False`를 넣었지만 이유가 기억나지 않고 이전 동작과 맞지 않으니 제거해야 한다고 명시한다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 회귀 커밋 해시·증상·심지어 수정 방향(`follow_symlinks=False` 제거)까지 직접 지목. `grep follow_symlinks` 한 방이면 유일 후보가 나온다.
- **S (Repair Strategy) = S1 (Direct-Map)**: 이슈가 사실상 픽스를 명세한다. `entry.is_dir(follow_symlinks=False)` → `entry.is_dir()`로 인자 하나 제거하는 기계적 수정. 조건식·불변식을 추론 합성할 필요 없음.
- **K (Knowledge) = K-Gen**: `os.scandir`/`DirEntry.is_dir(follow_symlinks=...)`의 표준 라이브러리 시맨틱만 알면 충분. pytest 내부 도메인 지식 불요.
- **primary type = T-DirectMap**: 위치가 자명(L0)하고 픽스가 인자 제거 한 번(S1)인 전형적 direct-map. 이슈가 픽스를 거의 적어줬다는 점에서 T-LocTrivial 경계지만, "심볼릭 링크를 따라가야 한다"는 의미적 결정(기본 동작 복원)이 깔려 있어 단순 상수변경 이상의 T-DirectMap으로 둔다.

APR 관점: 결함클래스가 "잘못된 API 인자(behavior-flag 오설정)"로 정형화되며, 이슈 본문이 ground-truth 패치를 직접 서술하므로 S2 추론이나 S3/S4 generate-validate 루프가 불필요하다. 템플릿 매칭(잘못된 플래그 제거)으로 끝.

## 난이도 티어
**T1 (존나쉬움)**.
- 파일수 1, 수정 줄수 1줄(단일 헌크), localize 직접성 최상(L0), has-repro(회귀 커밋+증상 명시).
- 도메인 지식 0, constraint 추론 0.
- 다만 `regression-trap` 플래그: PASS_TO_PASS가 79개로 `test_collection.py` 거의 전체를 커버한다. 특히 `test_collect_sub_with_symlinks[True/False]`, `test_collect_symlink_out_of_tree`, `test_collect_symlink_file_arg`, venv 무시(`test_ignored_virtualenvs*`) 계열이 심볼릭/스캔 동작과 직접 인접 — 과하게 손대면 깨질 자리들이지만, 골드 패치는 인자 하나만 제거하므로 trap을 건드리지 않는다.
- 공식 라벨 `<15 min fix`와 완전히 일치. tier를 올릴 구조적 피처(멀티파일/멀티헌크/깊은 추론/overfit)가 없다.

## 골드패치 분석
- **파일·함수**: `src/_pytest/pathlib.py`의 `visit(path, recurse)` 제너레이터 (파일 트리 재귀 순회).
- **근본원인**: 회귀 커밋 `b473e515`에서 디렉터리 재귀 진입 조건을 `entry.is_dir(follow_symlinks=False)`로 작성. `follow_symlinks=False`이면 심볼릭 링크는 그것이 디렉터리를 가리키더라도 `is_dir()`이 `False`를 반환 → 심링크 디렉터리가 `recurse()` 분기에 못 들어가 수집에서 누락.
- **수정요지**: 인자를 제거해 `entry.is_dir()`(기본 `follow_symlinks=True`)로 되돌림. 이제 심링크가 디렉터리를 가리키면 `True`가 되어 `recurse(entry)`를 통과하고 `yield from visit(entry.path, recurse)`로 재귀 진입 → 6.1.0 이전 기본 동작 복원.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_collect_symlink_dir` 신설. `dir/`을 만들고 그 안에 `test_it.py`(1 테스트)를 둔 뒤, 같은 레벨에 `symlink_dir -> dir` 심볼릭 링크를 만들고 `runpytest()` 실행 → `assert_outcomes(passed=2)`. 즉 원본 디렉터리에서 1개, 심링크 디렉터리를 따라 들어가 1개, 총 2개가 수집·통과해야 함. `follow_symlinks=False` 상태에서는 심링크가 무시되어 `passed=1`만 나와 실패 → 패치 후 `passed=2`로 픽스 증명.
- **overfit 관점**: 픽스가 인자 제거라는 일반적 동작 복원이라 special-case가 아니다. 테스트가 얇아도(F2P 1개) 패치 표면이 정확히 "심링크 디렉터리 따라가기" 단일 시맨틱이라 overfit 여지가 거의 없음.
- **regression 관점**: 79개 P2P가 수집 경로 전반(venv 무시, out-of-tree 심링크, file-arg 심링크, 서브디렉터리 심링크)을 함께 검증한다. 인자 제거가 이 동작들을 깨지 않음을 광범위하게 보증.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 회귀 커밋 `b473e515`와 키워드 `follow_symlinks=False`를 그대로 준다 → 레포 전체에서 `grep -rn "follow_symlinks=False" src/_pytest/`로 단번에 `pathlib.py::visit`의 한 줄로 수렴. 추가 탐색 불필요.
2. **픽스와 일반화**: `entry.is_dir(follow_symlinks=False)` → `entry.is_dir()`. `DirEntry.is_dir()`의 기본값이 `follow_symlinks=True`이므로, 이는 "심볼릭 링크 디렉터리도 일반 디렉터리처럼 따라간다"는 6.1.0 이전 기본 동작을 복원하는 것. 특정 테스트 케이스를 통과시키기 위한 분기 추가가 아니라 잘못 도입된 플래그를 제거하는 것이라 올바른 일반화.
3. **regression 안전**: out-of-tree 심링크/venv 무시 로직은 `visit`의 재귀 조건이 아니라 상위 `recurse()` 콜백·`_in_venv` 등 별개 게이트에서 처리되므로, `is_dir()` 인자 제거가 그 정책을 우회하지 않는다. `test_collect_symlink_out_of_tree`, `test_ignored_virtualenvs*`가 그대로 통과해야 하고 통과함.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 위험 — (a) 무한 루프 걱정으로 심링크 처리에 방문기록/loop-guard 같은 과잉 구조를 추가(불필요, scope 초과, S6로 격상되며 오히려 위험). (b) `os.walk(followlinks=...)`나 상위 호출부를 건드려 멀티사이트 변경. 정답은 이슈가 명시한 대로 단일 헌크 인자 제거에 머무는 것 — 이슈 신뢰도가 매우 높은 케이스이므로 본문 지시를 그대로 따르는 게 최적.
