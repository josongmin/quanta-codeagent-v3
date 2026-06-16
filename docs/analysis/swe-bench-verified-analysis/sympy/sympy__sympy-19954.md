---
instance_id: sympy__sympy-19954
repo: sympy/sympy
base_commit: 6f54459aa0248bf1467ad12ee6333d8bc924a642
version: "1.7"
difficulty: "<15 min fix"
created_at: 2020-08-12T06:07:32Z
fail_to_pass: 1
pass_to_pass: 56
gold_files: [sympy/combinatorics/perm_groups.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Gen
flags: [regression-trap, has-repro]
---

## 문제 요약
`DihedralGroup(18).sylow_subgroup(p=2)` 호출이 `IndexError: list assignment index out of range`로 죽는다. 스택트레이스는 `minimal_blocks()` 내부 `del num_blocks[i], blocks[i]` 줄(perm_groups.py:2207)을 정확히 지목한다. `DihedralGroup(2*25)`에서도 같은 에러가 재현된다. 즉 특정 군에서 minimal block system 계산 중 리스트 인덱스가 깨진다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 네이티브 스택트레이스가 함수(`minimal_blocks`)와 줄(`del num_blocks[i], blocks[i]`)을 직접 박아준다. grep 한 방, 탐색 0.
- **S2 (Constraint-Reasoning, +S6)**: 위치는 자명하나 픽스는 "가드 한 줄 추가"가 아니다. **세 리스트(`blocks`/`num_blocks`/`rep_blocks`)를 인덱스로 동기 유지해야 한다는 불변식**을 복원해야 하며, 루프 도중 in-place `del`로 인덱스를 망가뜨리는 패턴을 "수집 후 일괄 필터링"(mask) 구조로 바꿔야 한다. 단순 매핑이 아니라 자료구조 불변식 추론이라 S2, 작은 구조 재배치를 동반하므로 S6 보조.
- **K-Gen**: 군론 도메인 지식 불필요. 버그 자체는 순수 파이썬 리스트-mutation-during-iteration 결함. block-system 의미를 몰라도 인덱스 동기성만 보면 고칠 수 있다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 올바른 픽스가 "루프 중 다중 리스트 동기 삭제"라는 불변식 합성을 요구. T-DirectMap(기계적 가드)보다 한 단계 위.

## 난이도 티어
**T3 (중간).** 구조적 피처: 단일 파일·단일 함수, 골드 헌크 1개(~6줄 net). has-repro(네이티브 IndexError 스택트레이스)로 localize는 T1급. 그러나 픽스가 **인덱스 동기 불변식 추론**을 요구하고, naive 픽스(예: `del num_blocks[i], blocks[i], rep_blocks[i]`로 셋 다 지우기)는 여전히 enumerate 중 mutation이라 인덱스가 밀려 또 깨진다 — 이 함정 때문에 S1 기계적 가드로는 안 풀린다. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, mutation-during-iteration의 올바른 일반화를 잡아야 해서 T3로 +1 상향. P2P 56개가 `minimal_blocks`/`sylow_subgroup` 동작을 광범위하게 고정(regression-trap)하는 점도 T3을 지지.

## 골드패치 분석
- **파일·함수**: `sympy/combinatorics/perm_groups.py`의 `minimal_blocks(self, randomized=True)`.
- **근본원인**: orbit를 순회하며 발견된 block system들을 `blocks`, `num_blocks`, `rep_blocks` 세 리스트에 **인덱스 정렬 상태로** 쌓는다. 새 `rep`가 기존 `r`의 진부분집합을 만들면(기존 i번째가 non-minimal) 그것을 제거하는데, 원래 코드는 `for i, r in enumerate(rep_blocks)` 루프 **안에서** `del num_blocks[i], blocks[i]`로 즉시 삭제한다. 이러면 (a) `blocks`/`num_blocks`는 즉시 짧아지는데 `rep_blocks`는 루프 끝의 list-comprehension에서야 별도 제거되어 **세 리스트 길이가 일시적으로 어긋나고**, (b) 같은 패스에서 두 번째 non-minimal을 만나면 줄어든 리스트에 옛 `i`로 접근해 `IndexError`. `DihedralGroup(18)`처럼 한 패스에서 다중 제거가 발생하는 군에서 터진다.
- **수정요지**: 루프 중 삭제를 없애고 `blocks_remove_mask = [False]*len(blocks)`로 **삭제 대상만 표시**한 뒤, 루프 종료 후 세 리스트를 동일 mask로 **일괄 재구성**한다:
  `blocks = [b for i,b in enumerate(blocks) if not mask[i]]`, `num_blocks`/`rep_blocks`도 동형. 즉 mutate-while-iterating → collect-then-filter(S6) 전환으로 세 리스트의 인덱스 동기 불변식을 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS** = `test_sylow_subgroup` 1개. 추가된 단언:
  `DihedralGroup(18).sylow_subgroup(p=2).order() == 4`, `DihedralGroup(50).sylow_subgroup(p=2).order() == 4`.
- **픽스 증명**: base에선 두 호출 모두 `minimal_blocks()`에서 IndexError로 죽어 테스트가 import/실행조차 통과 못 함. 픽스 후 mask 일괄삭제로 인덱스가 깨지지 않아 정상적으로 위수 4(=2×2, 정이면체군 D_18·D_50의 Sylow-2의 위수)를 반환한다. 단순 "안 죽음"이 아니라 **반환 위수의 정확성**까지 검증해 픽스가 결과를 망치지 않음을 확인.
- **overfit·regression 관점**: FAIL_TO_PASS가 얇아(1개·특정 군 2개) overfit 여지는 있으나, 픽스가 입력별 special-case가 아니라 리스트 동기 로직의 일반 교정이라 overfit-risk 낮음(그래서 플래그 미부여). 반면 P2P 56개(`test_minimal_blocks`, `test_is_primitive`, `test_sylow_subgroup` 기존부 등)가 `minimal_blocks`의 출력 정확성을 광범위하게 고정 → mask 재구성이 정상 경로의 minimal block 집합을 바꾸면 즉시 깨지므로 regression-trap 유효. 골드는 삭제 대상만 동일 기준으로 골라 정상 경로 출력은 불변.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `minimal_blocks` 2207줄 `del num_blocks[i], blocks[i]`를 직접 지목 → 해당 함수만 열면 됨(L0). 군론 이해 불필요.
2. **픽스와 일반화 근거**: 진짜 원인은 `enumerate(rep_blocks)` 순회 중 `blocks`/`num_blocks`를 in-place `del`하면서 세 평행 리스트의 인덱스 정렬이 깨지는 것. 올바른 일반화는 "iterate 중 mutate 금지" 원칙 — 삭제 후보를 `blocks_remove_mask`로 모으고 **루프 종료 후 세 리스트를 같은 mask로 동시 재구성**. 이는 특정 군이 아니라 "한 패스에서 ≥1개 non-minimal 제거" 일반 경우를 모두 커버하므로 overfit이 아님.
3. **regression 안전**: P2P 56개가 정상 경로 minimal block 집합을 고정. mask는 기존 `del`/comprehension이 지우던 것과 **정확히 같은 원소**(`len(r)>len(rep) and rep.issubset(r)`인 i)만 표시하므로, 버그가 안 터지던 군들의 출력은 byte-identical. `minimal` 플래그·`num_block not in num_blocks` append 조건은 손대지 않음.
4. **함정 회피**: 오라클 없는 에이전트의 1순위 오답은 "셋 다 즉시 삭제"(`del num_blocks[i], blocks[i], rep_blocks[i]`)다 — 이는 enumerate 인덱스가 여전히 밀려 다중 제거 시 또 IndexError거나 한 칸씩 건너뛴다. 2순위는 `to_remove`에 `rep_blocks[i]`만 모으는 기존 절름발이 패턴 유지(blocks/num_blocks 동기 누락). 회피법: **루프 본문에서 어떤 리스트도 mutate하지 않고**, 종료 후 mask 기반으로 세 리스트를 한꺼번에 거른다는 불변식을 먼저 세우는 것.
