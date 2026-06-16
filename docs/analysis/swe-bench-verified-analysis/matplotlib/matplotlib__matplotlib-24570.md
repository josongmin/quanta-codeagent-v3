---
instance_id: matplotlib__matplotlib-24570
repo: matplotlib/matplotlib
base_commit: 8f0003ae902952372824c9917975fb372c026a42
version: "3.6"
difficulty: "<15 min fix"
created_at: 2022-11-30T15:50:17Z
fail_to_pass: 2
pass_to_pass: 267
gold_files: [lib/matplotlib/offsetbox.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`HPacker`에서 `align` 파라미터의 `"top"`과 `"bottom"`이 뒤바뀌어 동작한다. `align="bottom"`을 주면 자식들이 위쪽에 정렬되고 그 반대도 마찬가지다. 이슈에는 재현 스크립트와 actual/expected 이미지가 첨부되어 있고, `VPacker`의 `left`/`right`는 정상이라는 단서까지 달려 있다. 메인테이너 논의 끝에 deprecation 절차 없이 "단순 버그 수정"으로 처리하기로 결론났다.

## 유형 (정형화)
- **L = L1 (Traceable).** 이슈가 클래스명(`HPacker`)과 의미(top/bottom 반전)를 명시한다. 다만 `HPacker.__init__`이나 `get_extent_offsets`에는 정렬 로직이 없고, 공유 헬퍼 `_get_aligned_offsets(hd_list, height, align)`까지 한 단계 추적해야 분기를 만난다. grep 한 방(L0)은 아니고 좁은 단일파일 수렴이라 L1.
- **S = S2 (Constraint-Reasoning).** 고칠 지점(`elif align in [...]`)은 금방 찾지만, 어느 분기에 어느 라벨을 넣어야 좌표 의미가 맞는지를 **기하학적 추론**으로 합성해야 한다. `offsets = [d ...]`(원점 정렬)와 `offsets = [height - h + d ...]`(반대편 정렬)의 의미를 좌표축 방향과 매칭시켜야 하며, 단순 None가드/상수교체(S1)가 아니다.
- **K = K-Domain.** `_get_aligned_offsets`가 HPacker/VPacker 양쪽에서 좌표축을 바꿔(swap) 재사용된다는 offsetbox 레이아웃 내부지식이 있어야 "왜 HPacker만 틀리고 VPacker의 left/right는 멀쩡한가"를 이해하고 안전하게 고칠 수 있다.
- **primary_type = T-ConstraintReason.** 위치는 명확하나 올바른 분기-라벨 대응을 의미 추론으로 도출하는 게 본질이라 ConstraintReason. K-Domain도 강하지만 dominant는 추론 합성이다.

APR 관점: 이슈가 픽스 코드 한 줄을 적어주지 않고("top/bottom이 반전") 정확한 조건식을 모델이 좌표계 불변식으로 합성해야 하므로 SemFix/Angelix 계열 S2가 맞다. 후보를 무한정 시도하는 G&V가 아니라, 좌표 의미만 따지면 결정론적으로 답이 나온다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개, 헌크 1개, 실질 변경 4줄(라벨 2개를 두 분기 사이에서 교환) — 매우 작은 scope.
- localize 직접성: L1로 약한 탐색 필요(클래스 → 공유 헬퍼 1홉).
- has-repro: 이미지 + 재현 스크립트 존재(강한 easiness 신호).
- 그러나 **regression-trap**: 동일 헬퍼가 `left`/`right`(정상)도 처리하므로 분기를 잘못 만지면 멀쩡한 정렬을 깰 수 있다. P2P 232개 중 `test_packers[left]`/`[right]`/`[baseline]`/`[center]`가 직접 회귀 표적이다.
- 도메인 추론(좌표축 swap 재사용)이 들어가서 S1 기계픽스보다 한 단계 위.

공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 개발자에겐 한 줄이어도 에이전트 관점에선 (1) 공유 헬퍼까지 추적 (2) 4개 align 모두 안 깨는 정확한 라벨 교환을 추론해야 해서 T2가 아닌 **T3**로 상향한다. 시간라벨은 localize+regression 위험을 못 잡는다는 루브릭 원칙 적용.

## 골드패치 분석
- **파일·함수:** `lib/matplotlib/offsetbox.py`의 모듈 함수 `_get_aligned_offsets(hd_list, height, align="baseline")`.
- **근본원인:** 두 정렬 분기의 라벨 그룹핑이 좌표 의미와 어긋나 있었다. base에서 `["left", "top"]`이 `offsets = [d ...]`(원점/하단 정렬)에, `["right", "bottom"]`이 `offsets = [height - h + d ...]`(반대편/상단 정렬)에 묶여 있었다. VPacker 경로에서 `left`/`right`는 우연히 맞지만, 이 함수가 HPacker용으로 축을 swap해 쓰일 때 `top`/`bottom`의 의미가 뒤집힌다.
- **수정요지:** `top`과 `bottom` 라벨을 두 분기 사이에서 맞바꾼다. `["left", "top"]` → `["left", "bottom"]`, `["right", "bottom"]` → `["right", "top"]`. `left`/`right`/`baseline`/`center` 분기와 수식(`d`, `height - h + d`)은 그대로 둔다. 즉 동작이 옳던 `left`/`right`는 손대지 않고 어긋난 `top`/`bottom`만 올바른 분기로 재배치한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (2):** `test_packers[bottom]`, `test_packers[top]`. 신규 `test_packers`는 `HPacker`/`VPacker`를 `pad=0, sep=0`, dpi=72로 만들고 `get_extent_offsets(renderer)`의 offset 쌍을 `assert_allclose`로 검사한다. HPacker에서 `align in ("right","top")`이면 `y_height = y2 - y1`(반대편), `("baseline","left","bottom")`이면 `y_height = 0`(원점)을 기대 — 정확히 골드패치가 만든 새 그룹핑과 일치. base 코드에선 `top`/`bottom`이 반대 그룹에 있어 두 케이스가 실패한다.
- **픽스 증명:** 라벨 교환 후 `bottom`이 `offsets=[d ...]`(0 오프셋) 그룹으로, `top`이 `[height-h+d ...]`(`y2-y1`) 그룹으로 들어가 기대값과 정확히 매칭.
- **overfit:** 낮음. 테스트가 6개 align 전부(`baseline/bottom/top/left/right/center`)를 parametrize하고 HPacker·VPacker 양쪽 offset과 extent까지 검사해 special-case 통과가 불가능. `align`을 무조건 한 분기로 보내는 가짜 픽스는 다른 케이스에서 깨진다.
- **regression:** `test_packers[left]`/`[right]`/`[baseline]`/`[center]` + 기존 232 P2P가 보호막. `left`/`right` 분기를 건드리지 않은 골드패치 선택이 이들을 안전하게 통과시킨다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 `HPacker` + `align` 키워드로 `offsetbox.py`를 연다. `HPacker`/`VPacker`에 정렬 수식이 없음을 보고 호출 체인을 따라 공유 헬퍼 `_get_aligned_offsets`의 `elif align in [...]` 분기 블록에 도달. "VPacker의 left/right는 정상" 단서가 left/right 수식은 옳다는 강력한 힌트.
2. **픽스:** `top`/`bottom`을 두 분기 사이에서 교환. 올바른 일반화인 이유 — 좌표 의미상 `bottom`=원점 정렬(`offsets=[d]`), `top`=반대편 정렬(`height-h+d`)이어야 HPacker의 축-swap 재사용에서 일관되며, `left`/`right`의 검증된 동작을 보존한다. 라벨만 옮기고 수식은 불변이라 부수효과 0.
3. **regression 안전:** `left`/`right`/`baseline`/`center` 분기와 두 offset 수식을 절대 수정하지 않는다 — 이들은 정상이고 P2P(`test_packers[left/right/baseline/center]`, legend/anchored 다수)가 즉시 잡는다. 헬퍼가 VPacker에도 쓰이므로 VPacker 정렬도 함께 검증.
4. **함정 회피:** (a) HPacker 쪽에서만 고치려고 새 분기/축조건을 추가하면 동일 헬퍼를 쓰는 VPacker나 다른 align에 비대칭 버그를 심는다 — 골드처럼 헬퍼 한 곳에서 라벨 교환이 정답. (b) `top`/`bottom`을 둘 다 같은 분기로 몰거나 수식을 만지면 4개 align 회귀. (c) hints의 `fixed_api` deprecation 플래그 경로에 휘말려 과설계하지 말 것 — 최종 합의는 plain bugfix이고 테스트도 그걸 요구한다.
