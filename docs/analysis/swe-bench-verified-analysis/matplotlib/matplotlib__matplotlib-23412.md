---
instance_id: matplotlib__matplotlib-23412
repo: matplotlib/matplotlib
base_commit: f06c2c3abdaf4b90285ce5ca7fedbb8ace715911
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: 2022-07-11T01:41:11Z
fail_to_pass: 1
pass_to_pass: 46
gold_files: [lib/matplotlib/patches.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
패치(`Patch`) 객체에 dash 튜플 `(offset, onoffseq)` 형태로 linestyle을 지정해도 offset(dash phase)이 무시된다. `Rectangle((...), ls=(0,(10,10)))`와 `ls=(10,(10,10)))`이 동일하게 그려져, 같은 위치의 두 패치 테두리가 어긋나지 않고 겹친다. 동일 linestyle을 `Line2D`(`plt.plot`)에 주면 offset이 정상 적용되므로 패치 쪽만의 결함이다. hints에서 제보자가 `draw()` 내부에서 offset을 강제로 0으로 덮어쓰는 한 줄을 정확히 지목했고, 메인테이너도 "버그로 보고 바로 고치자, good first issue"로 합의했다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 문제 파일·라인(`lib/matplotlib/patches.py` L588)을 직접 링크로 지목하고, hints가 "여기 0을 전달된 offset으로 바꾸면 완전히 동작한다"까지 적어준다. grep도 필요 없는 핀포인트.
- **S1 (Direct-Map, +S2)**: 픽스가 사실상 명세돼 있다 — `_dash_pattern`의 offset 슬롯을 하드코딩 `0`에서 실제 값으로 되돌리는 기계적 치환. 다만 단순 상수교체가 아니라 "offset만 보존하면서 onoffseq는 유지"라는 튜플 불변식을 이해해야 해 약한 S2가 보조로 붙는다.
- **K-Domain**: `cbook._setattr_cm` 컨텍스트매니저로 draw 동안만 `_dash_pattern`을 임시치환하는 matplotlib 내부 관용구와, `(offset, onoffseq)` dash 표현·렌더러 dash 전달 경로를 알아야 "왜 offset을 0으로 죽였는지"와 그 제거 안전성을 판단할 수 있다.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 가드/상수 수준의 기계적 치환(S1)이므로 정형 Direct-Map. APR 관점에서 이슈+hints가 픽스 위치와 형태를 모두 제공하는 template-매칭 상황이라 합성 탐색이 거의 불필요하다.

## 난이도 티어
**T2 (쉬움)**. 구조 피처: 1파일·실질 1라인(주석 포함 −4/+3), localize 직접성 최상(L0, 이슈에 라인 링크), has-repro(완전한 재현 스니펫). 도메인 지식은 `_setattr_cm`/dash-tuple 정도로 가볍고, 픽스 추론은 "0을 원래 offset으로 복원"으로 거의 결정적이다. 단 FAIL_TO_PASS가 픽셀비교 1개뿐(`check_figures_equal`)이고 PASS_TO_PASS 46개가 모두 같은 `test_patches.py` 안의 linestyle/그리기 동작이라 regression-trap이 있어 T1까지는 못 내린다. 공식 라벨 "15분–1시간"과 정합적이며, 본질 작업이 메인테이너 말대로 코드 1줄+테스트 작성에 몰린 good-first-issue다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/patches.py`의 `Patch.draw(self, renderer)`.
- **근본원인**: `draw()`가 렌더 직전 `cbook._setattr_cm(self, _dash_pattern=(0, self._dash_pattern[1]))`로 `_dash_pattern`을 임시 교체하면서 offset 슬롯을 무조건 `0`으로 박았다("Patch has traditionally ignored the dashoffset" 주석). 그래서 사용자가 준 offset이 렌더 단계에서 항상 소실됐다.
- **수정요지**: 해당 컨텍스트를 `cbook._setattr_cm(self, _dash_pattern=(self._dash_pattern))`로 바꿔 offset을 죽이는 튜플 재구성을 제거하고 원본 `_dash_pattern`(=`(offset, onoffseq)`)을 그대로 보존. "전통적으로 무시했다"는 주석도 삭제. 단 한 곳의 의도적 0-강제만 제거한 최소 수정.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_dash_offset_patch_draw[png]` 1개. `check_figures_equal`로 test/ref 두 figure의 PNG를 픽셀 동치 비교한다. ref는 offset 없이 onoffseq를 손으로 보강해(`(0,[6,6])` + `(0,[0,6,6,0])`) 만든 두 사각형, test는 offset 0과 6을 직접 준 두 사각형(`(0,[6,6])` + `(6,[6,6])`). offset 6짜리가 ref의 보정본과 픽셀일치해야 통과 — 즉 offset이 실제 렌더에 반영됨을 증명한다.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이지만, offset≠0이 진짜 적용돼야만 통과하는 픽셀-동치 검증이고 ref가 수학적으로 동등한 onoffseq로 구성돼 special-case 통과 여지가 작다. 패치가 offset만 0으로 죽이던 단일 분기를 제거하므로 테스트-특화 하드코딩으로 빠질 표면이 없다.
- **regression 관점**: PASS_TO_PASS 46개에 `test_patch_custom_linestyle`, `test_patch_linestyle_accents`, `test_default_linestyle`, `test_patch_linestyle_none` 등 dash/linestyle 그리기가 포함된다. 기존 호출은 대부분 offset 0이라 `(0, onoff)`가 `_dash_pattern` 원본과 동일 → 동작 불변. offset 보존이 이들을 깨지 않음이 통과로 확인된다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 패치 vs Line2D 대비 + "offset 무효"라는 증상과 `patches.py` 라인 링크를 직접 준다. `Patch.draw`로 바로 가서 `_setattr_cm(... _dash_pattern=(0, self._dash_pattern[1]))`의 0-강제와 "traditionally ignored the dashoffset" 주석을 찾는다(L0, 탐색 거의 0).
2. **픽스**: 그 튜플 재구성을 제거하고 원본 `self._dash_pattern`을 그대로 넘긴다. 이게 올바른 일반화인 이유 — offset을 죽이던 것은 의도가 아닌 관성(메인테이너 합의)이었고, 수정은 모든 offset 값에 대해 "사용자가 준 dash phase를 그대로 렌더러에 전달"하는 일반 동작을 복원한다. 특정 입력을 특수처리하지 않으므로 overfit이 아니다.
3. **regression 안전**: offset 0이 기본인 기존 linestyle 경로(`(0, onoff)`)는 `_dash_pattern`과 값이 같아 결과 불변 — `test_patch_custom_linestyle`/`test_default_linestyle` 등 46개 P2P가 그대로 통과해야 하고 통과한다. PDF/SVG hatch 우회나 facecolor 분기는 건드리지 않아 부수효과 없음.
4. **함정 회피**: (a) hints의 "그냥 docstring만 고치자(intended behavior)" 미끼를 따라가 코드를 안 고치면 FAIL_TO_PASS 미해결 — 메인테이너의 최종 합의("버그다, 바로 고치자")를 신호로 코드 수정을 택해야 한다. (b) offset만 바꾸려고 `(self._dash_pattern[0], self._dash_pattern[1])`처럼 장황하게 재구성하면 동치지만 불필요 — 원본 튜플 직접 전달이 정답. (c) 픽셀 비교 테스트 작성 시 ref를 offset로 만들면 순환검증이 되므로, 오라클처럼 onoffseq 보강(`(0,[0,6,6,0])`)으로 offset 6과 동등한 형상을 독립 구성해야 진짜 teeth가 생긴다.
