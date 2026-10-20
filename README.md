# BlockPilot

마인크래프트 서버 폴더 경로만 지정하면 설정·모드·플레이어·콘솔·백업을 웹 GUI로 관리할 수 있는 로컬 대시보드.

## 기능

| 화면 | 할 수 있는 것 |
|---|---|
| 대시보드 | 로더/버전/접속자/모드 수 요약, 시작·중지·재시작, 접속자 킥/밴, 최근 콘솔 |
| 서버 설정 | `server.properties`를 그룹별 폼으로 편집 (난이도, PvP, 게임모드, 최대 인원, MOTD, 시야 거리 …). 나머지 키는 고급 탭에서 raw 편집 |
| 플레이어 | 화이트리스트 / OP / 밴(플레이어·IP) 관리. 닉네임만 입력하면 Mojang API로 UUID 자동 조회 |
| 모드 | `mods/`(Paper는 `plugins/`)의 jar를 읽어 이름·버전·설명·의존성 표시, 의존성 누락 경고, 활성/비활성, 삭제, 업로드, 친구용 클라이언트 모드 zip 내보내기 |
| 설정 파일 | `config/`, `plugins/` 등의 toml / json / yaml / properties 파일 편집. 저장 전 문법 검사 |
| 콘솔 | 실시간 로그 스트리밍, 명령어 전송, ↑↓ 히스토리 |
| 로그 | `logs/`(gz 포함)와 `crash-reports/` 보기, 검색, WARN/ERROR 필터 |
| 백업 | 월드 zip 백업 / 복원 / 다운로드, 간격·보관 개수 설정으로 자동 백업 |

### 동작 방식

- **서버 실행 중**: 설정 변경을 콘솔 명령(`difficulty`, `whitelist add` 등)으로 즉시 반영. 명령으로 못 바꾸는 항목은 파일에 저장하고 "재시작 필요"로 표시
- **서버 중지 중**: 파일을 직접 수정. 쓰기 전에 `.blockpilot-backup/`에 사본을 남기고, 임시 파일 → rename으로 안전하게 교체
- **BlockPilot 밖에서 띄운 서버**: `server.properties`에 `enable-rcon=true`, `rcon.password`가 있으면 RCON으로 명령·중지·접속자 조회 가능
- 지원 로더: Fabric, Forge, NeoForge, Paper/Purpur, Vanilla (버전·로더 자동 감지)

## 요구 사항

- Node.js 20 이상
- Java (서버를 BlockPilot에서 시작하려면)

## 실행

```bash
npm install
npm run build
npm start
```

브라우저에서 http://127.0.0.1:4800 을 열고 서버 폴더 경로를 등록하세요.

개발 모드 (백엔드 4800, 프론트 4801 HMR):

```bash
npm run dev
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `BLOCKPILOT_PORT` | `4800` | 대시보드 포트 |
| `BLOCKPILOT_HOST` | `127.0.0.1` | 바인딩 주소. `0.0.0.0` 등 외부 주소로 바꾸면 접속 토큰이 자동 생성되어 로그에 출력됩니다 |
| `BLOCKPILOT_TOKEN` | (없음) | 접속 토큰을 직접 지정. 설정하면 루프백에서도 토큰 입력이 필요합니다 |
| `BLOCKPILOT_HOME` | `~/.blockpilot` | 등록된 서버 목록·설정·토큰이 저장되는 폴더 |

## 구조

```
packages/
├── shared/   zod 스키마, API 타입, server.properties 키 메타데이터
├── server/   Fastify API — 파일 IO, 프로세스/RCON 제어, WebSocket 콘솔, 백업 스케줄러
└── web/      React + Vite + Tailwind 대시보드
```

## 테스트

```bash
npm test
```

## 라이선스

MIT
