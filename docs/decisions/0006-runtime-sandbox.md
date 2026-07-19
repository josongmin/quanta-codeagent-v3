# ADR-0006: runtime 샌드박스 추상화 — Local(약식) + Docker(opt-in)

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §1.2(컨테이너 격리는 "필요할 때만"), §3.2(runtime: 약식→풀(sandbox 시)), §9.2(외부 시스템 통합 Docker = ADR 트리거), §12(위험), ADR-0003(contract 티어로 Docker 게이트)

## 결정

`runtime` 슬라이스에 `SandboxPolicy`(선언적 제약: `cwdJail`/`allowNetwork`/
`envAllowlist`/`maxOutputBytes`/`timeoutMs`)와 `Sandbox` 포트(`run(command,
policy)`)를 도입한다. 구현 둘:

- `LocalSandbox` — `runShell`과 동일한 `Bun.spawn(["bash","-lc",cmd])`
  기반의 **best-effort 인프로세스 confinement**. 보안 경계가 아님을
  코드 주석이 명시.
- `DockerSandbox` — `docker run --rm`로 host process와 분리된 실행 경계를
  제공한다. 정책을 docker 플래그로 매핑(`--network none`, `-v host:/workspace`,
  `--env NAME`, 옵션 `--memory`/`--cpus`). Docker 부재 시 `SandboxUnavailableError`를 던지고 **조용히
  LocalSandbox로 강등하지 않는다** — fallback은 호출자가 명시 선택.

기본은 LocalSandbox(default-off Docker). 정책 위반(jail escape)은
`SandboxPolicyError`로 하드 스톱, 절대 degraded run 안 함.

## 근거

- RFC §1.2는 컨테이너 격리를 "필요할 때만"으로 못박았다. 그래서 지금은
  **추상화(포트) + 정직한 enforcement 매트릭스**만 두고 Docker는 opt-in.
  RFC §3.2의 "runtime: 약식 → 풀(sandbox 시)"가 그대로 실현됨 — 2번째
  구현(Docker)이 진짜 필요해진 시점에 포트 추출(RFC §3.1 트리거 준수).
- 조용한 fallback 금지 이유: "Docker 격리를 요청했는데 말없이 비격리
  Local로 떨어짐"은 보안 약속의 침묵 위반 — ADR-0003이 contract 티어
  조용한 스킵을 금한 것과 같은 논리(은폐된 약속 깨짐 방지). 강등은 가시적
  결정이어야 하므로 throw 후 호출자 선택.
- env 스크럽은 두 구현 공통(`DEFAULT_ENV_ALLOWLIST` = PATH/HOME/LANG/…),
  부모의 API 키·토큰은 자식에 절대 미상속 — Local에서도 정직하게 지키는
  유일한 강한 보장 축이라 공통화.

## 트레이드오프

- **LocalSandbox가 정직하게 강제하지 못하는 것**(코드 주석이 이미 명시):

  | 제약 | LocalSandbox | DockerSandbox |
  |------|--------------|---------------|
  | env 스크럽 | 강제 (allowlist만) | 강제 (`--env NAME`) |
  | cwd 시작 + 명시적 escape 거부 | 강제 | 강제 (bind-mount) |
  | output cap / timeout | 강제 | 강제 |
  | 절대경로 FS 격리 (chroot) | **미강제** | 컨테이너 rootfs에서 분리; 마운트 workspace는 기본 writable |
  | 네트워크 차단 | **미강제(advisory)** | 강제 (`--network none`) |
  | CPU/메모리 한도 | **미강제** | 옵션이 제공될 때만 강제 (`--memory`/`--cpus` 기본값 없음) |

  Local의 `cwdJail`은 작업 디렉토리 설정 + *명시적으로 요청된* escape
  거부일 뿐 chroot가 아니다. `allowNetwork:false`는 Local에서 advisory.
- Docker backend의 현재 하드닝 한계: default image는 mutable tag
  `node:22-slim`, 컨테이너는 기본 root user, capability/no-new-privileges/
  pids 제한이 없고 workspace mount는 writable이다. 따라서 신뢰할 수 없는
  작업을 위한 hardened sandbox로 승격하려면 digest-pinned image, read-only
  mount/명시적 writable scratch, non-root user, capability drop,
  no-new-privileges, pids 및 자원 기본값을 소유한 별도 profile이 필요하다.
- Docker 데몬 의존: `DockerSandbox`는 데몬 부재 시 실행 불가
  (`isAvailable`로 선검사 후 `SandboxUnavailableError`). contract 티어
  게이트로 검증(ADR-0003).
- default-off의 비용: 옵트인하지 않으면 네트워크/FS/자원 격리가 **전혀
  없다** — RFC §1.2를 존중한 의도된 선택이나, 운영자가 격리를 켜야만
  실 보호가 생긴다는 점을 분명히 함.

## 후속

- CLI/agent가 정책·백엔드를 어떻게 선택·노출할지 배선은 소유권 밖
  (본 ADR은 슬라이스 계약만 확정).
- 추가 백엔드(rootless/gVisor 등) 필요 시 별도 ADR 없이 `Sandbox` 포트
  구현 추가로 흡수(이미 풀 헥사고날 — RFC §3.1).
