---
instance_id: pylint-dev__pylint-4970
repo: pylint-dev/pylint
base_commit: 40cc2ffd7887959157aaf469e09585ec2be7f528
version: "2.10"
difficulty: "<15 min fix"
created_at: 2021-09-05T19:44:07Z
fail_to_pass: 1
pass_to_pass: 17
gold_files: [pylint/checkers/similar.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [overfit-risk, has-repro]
---

## 문제 요약
`min-similarity-lines`(중복코드 검사 임계값)를 `0`으로 설정하면 중복 검사가 비활성화되어야 하는데, 실제로는 모든 코드 줄을 중복으로 취급해 대량의 `R0801` 에러를 쏟아낸다. flake8 등 다른 린터는 수치 옵션을 `0`으로 두면 해당 검사를 끄는 관례를 따른다(예: `max-line-length=0`). 따라서 `0`은 "임계값 0"이 아니라 "검사 비활성화"라는 sentinel로 해석되어야 한다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈가 옵션명 `min-similarity-lines`를 직접 지목한다. 코드에서 `min_lines` 심볼 → `pylint/checkers/similar.py`의 `Similar`/`Run`로 grep 한두 번에 수렴. 다만 옵션명과 내부 필드명(`min_lines`)이 달라 한 단계 매핑이 필요해 L0는 아니다.
- **S = S1 (Direct-Map) + 보조 S5 (Spec-Inference)**: 픽스는 "0이면 early-return"이라는 기계적 가드 1줄. 다만 `0`을 "비활성화 sentinel"로 정의하는 의도는 코드에 없고 이슈 본문/flake8 관례에서 재구성해야 하므로 약한 spec-inference가 섞인다.
- **K = K-Domain**: `similar` 체커의 임계값 비교 의미론(`eff_cmn_nb > self.min_lines`)을 알아야 "왜 0이 전부를 중복으로 만드는지"를 이해한다. 프레임워크 내부 동작 지식.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 가드 추가라는 기계적 형태(None/경계 가드 클래스). 의도 추론은 보조일 뿐 dominant는 direct-map.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일 `similar.py`, 골드 +2줄, localize 직접성 높음(옵션명→필드명 1매핑), has-repro(이슈가 `--duplicates=0` 재현을 사실상 명세). P2P 17개로 인접 동작(ignore-comments/-docstrings/-imports/-signatures, get_map_data 등)을 안 깨야 하지만, early-return이 `min_lines==0`에만 걸려 정상 경로를 건드리지 않으므로 regression trap은 약하다. 공식 라벨 `<15 min fix`와 일치(T1~T2 구간). T1이 아닌 이유: `0`을 비활성화로 보는 스펙이 코드에 명시돼 있지 않아 "픽스를 거의 적어주는" 자명함에는 못 미친다.

## 골드패치 분석
- **건드린 파일·함수**: `pylint/checkers/similar.py`의 `Similar.run`.
- **근본원인**: 중복 후보 필터는 `_compute_sims` → `_iter_sims` 경로에서 `if eff_cmn_nb > self.min_lines: yield com`로 거른다. `min_lines == 0`이면 공통 줄 수가 1 이상인 모든 commonality가 `> 0` 조건을 통과해 사실상 전 코드가 중복으로 보고된다. 즉 `0`이 "임계값 0"으로 산술 해석되어 의도(비활성화)와 정반대로 작동.
- **수정요지**: `run()` 진입부에서 `if self.min_lines == 0: return`으로 short-circuit. `_display_sims(self._compute_sims())` 호출 자체를 건너뛰어 어떤 중복도 보고하지 않게 한다. 임계값 비교식(`> self.min_lines`)은 손대지 않고, 0을 비활성화 sentinel로 격상하는 최소 가드.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_set_duplicate_lines_to_zero` — `similar.Run(["--duplicates=0", SIMILAR1, SIMILAR2])`를 stdout 캡처와 함께 실행하고 `SystemExit.code == 0` 및 `output.getvalue() == ""`을 단언. 즉 `0`이면 출력이 완전히 비어야 한다. `Run`은 CLI 진입점으로 `min_lines=int(val)=0`을 `Similar`에 전달하고 `sim.run()`을 호출하므로, 새 가드가 정확히 이 경로를 차단.
- **픽스 증명**: 가드 없으면 `_compute_sims`가 모든 commonality를 yield → stdout에 중복 보고가 찍혀 `output == ""` 단언이 깨진다. 가드 추가 시 `run()`이 즉시 return → 빈 출력 → `sys.exit(0)`로 `code == 0`.
- **overfit·regression 관점**: FAIL_TO_PASS가 1개뿐이고 출력 빈 문자열만 본다 → `overfit-risk` 존재(예: SimilarChecker(플러그인) 경로에서 `min_lines=0`일 때 동작은 이 테스트가 검증하지 않음; CLI `Run`만 커버). 다만 가드를 `min_lines==0`에만 한정했으므로 1 이상 임계값의 정상 동작(P2P 17개)은 불변 → regression 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `min-similarity-lines` / `--duplicates` 키워드 → `pylint/checkers/similar.py`. 옵션 등록부(`min-similarity-lines` → `self.config.min_similarity_lines` → `self.min_lines`)와 임계값 비교부 `if eff_cmn_nb > self.min_lines`를 읽어 "0이면 모든 양수 commonality가 통과"라는 인과를 확인.
2. **픽스와 일반화**: 비교식을 `>=`로 바꾸거나 `min_lines` 디폴트를 조정하는 대신, `run()` 초입에 `if self.min_lines == 0: return`을 둔다. 이유 — `0`을 "비활성화"라는 별도 의미(flake8 관례)로 격상하는 것이 의도이므로, 산술 임계값 자체를 흔들지 않고 sentinel만 가로채는 것이 올바른 일반화다. 비교식을 만지면 `min_lines==1` 등 경계 동작이 의도치 않게 바뀐다.
3. **regression 안전**: P2P의 ignore-* 계열·`test_get_map_data`·`test_no_args`·`test_help`는 모두 `min_lines>0` 또는 0과 무관한 경로다. 가드를 `== 0`로 좁혀 이들 정상 흐름을 보존해야 한다.
4. **함정 회피**: (a) `> self.min_lines`를 `>=`로 바꾸려는 유혹 — 그러면 1줄 중복도 잡혀 다수 P2P가 깨진다. (b) 가드를 `_compute_sims`/`_iter_sims` 깊숙이 넣어 일부 통계는 채워지게 두는 변형 — CLI 경로에선 통과해도 빈 출력 계약을 어길 수 있다. `run()` 최상단 early-return이 가장 안전. (c) 오라클 없는 에이전트는 `SimilarChecker`(플러그인) 쪽 `min_lines=0` 처리까지 손대려다 과도하게 번질 수 있으나, FAIL_TO_PASS는 CLI `Run`만 요구하므로 최소 가드로 충분.
