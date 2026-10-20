# BlockPilot

마인크래프트 서버 폴더 경로만 지정하면 설정·모드·플레이어·콘솔을 웹 GUI로 관리할 수 있는 로컬 대시보드.

## 기능

- **서버 인식** — 폴더를 등록하면 로더(Fabric / Forge / NeoForge / Paper / Vanilla)와 마인크래프트 버전을 자동 감지
- **서버 설정** — `server.properties`를 그룹별 폼으로 편집 (난이도, PvP, 게임모드, 최대 인원, MOTD, 시야 거리 등). 나머지 키는 고급 탭에서 raw 편집
- **플레이어** — 화이트리스트 / OP / 밴 목록 관리. 닉네임만 입력하면 Mojang API로 UUID 자동 조회
- **모드** — `mods/` 안의 jar를 읽어 이름·버전·설명·의존성 표시, 의존성 누락 경고, 활성/비활성 토글, 삭제, 업로드
- **서버 제어** — 시작 / 중지 / 재시작, 실시간 콘솔 스트리밍, 명령어 전송

서버가 **실행 중이면** 설정 변경을 콘솔 명령(`difficulty`, `whitelist add` 등)으로 즉시 반영하고, **중지 상태면** 파일을 직접 수정합니다. 파일을 쓰기 전에는 항상 `.blockpilot-backup/`에 사본을 남깁니다.

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

## 구조

```
packages/
├── shared/   zod 스키마, API 타입, server.properties 키 메타데이터
├── server/   Fastify API — 파일 IO, 프로세스 관리, WebSocket 콘솔
└── web/      React + Vite + Tailwind 대시보드
```

등록된 서버 목록은 `~/.blockpilot/config.json`에 저장됩니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `BLOCKPILOT_PORT` | `4800` | 대시보드 포트 |
| `BLOCKPILOT_HOST` | `127.0.0.1` | 바인딩 주소. 인증이 없으므로 외부에 열지 마세요 |
| `BLOCKPILOT_HOME` | `~/.blockpilot` | 설정 파일 위치 |

## 라이선스

MIT
