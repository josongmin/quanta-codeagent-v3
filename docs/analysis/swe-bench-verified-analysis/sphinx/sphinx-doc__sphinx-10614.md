---
instance_id: sphinx-doc__sphinx-10614
repo: sphinx-doc/sphinx
base_commit: ac2b7599d212af7d04649959ce6926c63c3133fa
version: "7.2"
difficulty: "15 min - 1 hour"
created_at: "2022-06-29T14:29:04Z"
fail_to_pass: 1
pass_to_pass: 5
gold_files: [sphinx/ext/inheritance_diagram.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약

`sphinx.ext.inheritance_diagram`로 SVG 출력 모드에서 상속 다이어그램을 만들면, 루트가 아닌 하위 디렉터리 문서에 박힌 다이어그램의 클릭 링크가 404로 깨진다. PNG 모드에서는 정상. 원인은 SVG가 `<object>`로 임베드되어 링크가 SVG 파일(`_images/`) 기준 상대경로인데, 코드가 모든 SVG 링크에 무조건 `"../"`만 붙여서 루트 문서에서만 우연히 맞고 중첩 문서·외부(intersphinx 절대 URL)에서는 어긋나기 때문이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 "inheritance_diagram + SVG 링크"를 명시하고 `sphinx/ext/inheritance_diagram.py`의 `html_visit_inheritance_diagram` 하나로 수렴. 정확한 줄은 약간 읽어야 하지만 후보 단일파일·단일함수. L0는 아님(심볼 직접 지목까진 안 함).
- **S2 (Constraint-Reasoning, +S5)**: 고칠 지점은 명확하나, "SVG는 `../` 붙임 / PNG는 안 붙임"이라는 잘못된 분기를 "URL을 SVG 위치 기준 상대경로로 올바르게 구성"이라는 불변식으로 재합성해야 한다. 특히 intersphinx 외부 링크는 절대 URL이라 `../`을 붙이면 안 된다는 스펙은 이슈에 직접 안 적혀 있고(이슈는 내부 링크만 언급) 코드/관례에서 추론해야 함 → S5 보조.
- **K-Domain**: graphviz/clickmap 렌더링, `<object>` SVG 임베드의 상대경로 의미, intersphinx의 `internal`/`refuri` xref 속성 등 sphinx 내부 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 잡히나 픽스가 "조건 추가"가 아니라 *올바른 경로 구성식*을 의미적으로 합성하는 데 핵심 난점이 있음.

APR 관점: 한 줄 가드/상수 변경(S1)으로 안 풀린다. 잘못된 SVG/PNG 분기 자체를 제거하고 `internal` 플래그 기반으로 refname을 다르게 추출하는 의미적 재구성이라 SemFix/Angelix류 constraint-reasoning에 해당.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일수 1 / 핵심 변경 ~6줄(헌크 1개) → scope만 보면 작다.
- localize 직접성: L1로 낮은 편(repro zip + 명확한 증상).
- **regression-trap 강함**: PNG 경로, SVG `refid`(내부 앵커) 경로, latex 경로까지 같은 함수/주변이 P2P로 묶여 있어 SVG `refuri` 한 갈래만 고치면서 나머지를 안 깨야 함. 실제 골드는 SVG `refid` 분기의 `"../"`도 같이 제거한다(미묘한 연쇄).
- **도메인+스펙추론**: intersphinx 외부 절대 URL이라는, 이슈 본문에 없는 케이스를 픽스가 함께 처리해야 정답(test_patch가 바로 그걸 검증). 단순 "`../` 떼기"로 끝내면 외부링크가 깨지거나 내부링크가 깨진다.

공식 라벨 "15분~1시간"과 대체로 일치하나, 에이전트 입장에선 *올바른 일반화*(외부 vs 내부 구분)를 놓치기 쉬워 T3보다 T4로 올린다.

## 골드패치 분석

- **파일/함수**: `sphinx/ext/inheritance_diagram.py` → `html_visit_inheritance_diagram`.
- **근본원인**: SVG는 `<object>`로 임베드되어 링크가 SVG 자신(`_images/`) 기준 상대다. 기존 코드는 이를 "출력 문서 기준 상대"로 착각하고 SVG일 때 일괄 `"../"`를 prepend 했다. 이 보정은 루트 문서에서만 우연히 맞고, 중첩 문서(`subdir/`)에서는 `../` 한 단계가 모자라/남아 404가 된다. 또한 intersphinx 외부 절대 URL에도 `"../"`가 붙어 깨진다.
- **수정요지**:
  - `refuri` 분기: SVG/PNG로 갈리던 `if graphviz_output_format == 'SVG'` 보정을 제거. 대신 xref의 `internal` 플래그로 분기 — 외부(intersphinx) 링크면 `child['refuri'].rsplit('#', 1)[-1]`로 클래스명(refname)을 URI에서 추출하고, 내부면 `child['reftitle']`을 그대로 키로 사용. URL 자체는 가공 없이 `child.get('refuri')` 그대로 저장(`urls[refname] = ...`).
  - `refid` 분기(내부 앵커): SVG일 때 붙이던 `'../' + current_filename + '#' + refid`에서 `'../'`를 제거해 `current_filename + '#' + refid`로 수정. PNG 경로는 불변.

즉 "SVG면 `../`" 라는 잘못된 전역 보정을 걷어내고, 링크 종류(외부/내부/앵커)에 맞는 올바른 키·URL 구성으로 대체했다.

## 검증 (test_patch)

- **FAIL_TO_PASS**: `test_inheritance_diagram_svg_html`. 테스트루트에 `sphinx.ext.intersphinx`를 추가하고, `subdir/` 하위문서 + 외부 인벤토리(`subdir.other.Bob` → `https://example.org/foo.html#...`)를 구성. 빌드 후 base/subdir의 SVG 클릭맵을 모두 순회하며:
  - `://` 포함(절대 URL) 링크는 반드시 `https://example.org/`로 시작 → **외부 링크에 `../`가 안 붙음**을 증명.
  - 상대 URL은 `app.outdir / imagedir / reluri`가 실제 존재 → **중첩 문서 링크가 404 아님**을 증명.
  - `latex_alias` 테스트의 클래스명도 `Bar/Baz` → `DocHere/DocLowerLevel`로 갱신(중첩 케이스 픽스처).
- **overfit 관점**: 테스트가 단일 케이스가 아니라 (내부 root, 내부 nested, 외부 intersphinx) × (PNG, SVG) 조합을 클릭맵 전수 순회로 검사 → `../`만 떼는 special-case 패치는 외부링크 단언에서 깨지고, `internal` 무시 패치는 nested 단언에서 깨진다. overfit 방어가 비교적 단단함(그래서 flag는 has-repro/regression 중심).
- **regression 관점**: PASS_TO_PASS 5개(`test_inheritance_diagram`, `_png_html`, `_latex`, `_latex_alias`, `_import_classes`)가 PNG/latex 경로와 import 로직을 잡아둔다. SVG 분기만 고치고 이들을 보존해야 함.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "SVG에서만 404, 중첩 문서에서만 발생, 링크가 SVG 기준 상대" 단서 → grep `inheritance_diagram` → `html_visit_inheritance_diagram`의 `urls[...] = "../" + refuri` (SVG 전용 `"../"` prepend)를 즉시 의심. PNG 분기와의 비대칭이 스모킹건.
2. **픽스(올바른 일반화)**: "SVG면 `../`"는 위치-무관 상수 보정이라 틀렸다. SVG 링크는 이미 `_images/` 기준 상대로 dot이 생성하므로 출력문서 깊이에 따른 `../` 가산은 잘못. 올바른 모델은 *URL을 가공하지 말고 키만 정확히*: 내부 xref는 `reftitle`로, 외부(intersphinx, `internal=False`)는 절대 URL이라 `refuri`의 fragment에서 refname을 뽑아 매핑. 이게 root/nested/external을 한 번에 맞추는 일반해.
3. **regression 안전**: PNG의 `refuri`/`refid` 경로와 latex 경로(P2P)는 절대 건드리지 말 것 — PNG 클릭맵은 출력문서 기준이라 동작이 다르다. SVG `refid`(내부 앵커)의 `../`도 같이 떼야 하지만 PNG `refid`는 `'#' + refid`로 유지.
4. **함정 회피**: 오라클 없는 에이전트의 전형 오답 = (a) 단순히 SVG의 `"../"`만 삭제 → 외부 절대 URL은 맞지만 nested 내부링크 깊이를 못 맞추거나, intersphinx 케이스를 빼먹어 미검증 통과 후 실제 테스트에서 실패. (b) `internal` 플래그의 존재를 모르고 외부/내부를 구분 못 함(K-Domain 지식 결핍). (c) 출력문서 기준으로 상대경로를 재계산하려다 SVG가 `_images/`에 산다는 사실을 놓침. 회피책: SVG 임베드(`<object>`)의 base가 SVG 파일 위치라는 점을 먼저 확정하고, intersphinx 외부 링크를 별도 케이스로 명시 처리.
