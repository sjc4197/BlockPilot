/**
 * server.properties 키 메타데이터.
 * 폼 UI는 이 목록으로 자동 생성되고, 여기 없는 키는 "고급" 탭에 raw로 노출된다.
 */

export type PropertyGroup = "gameplay" | "world" | "players" | "network" | "performance";

export type PropertyMeta =
  | {
      key: string;
      group: PropertyGroup;
      label: string;
      description?: string;
      type: "boolean";
      /** 실행 중 콘솔 명령어로 반영 가능하면 명령어 템플릿, 없으면 재시작 필요 */
      liveCommand?: (value: string) => string;
    }
  | {
      key: string;
      group: PropertyGroup;
      label: string;
      description?: string;
      type: "enum";
      options: { value: string; label: string }[];
      liveCommand?: (value: string) => string;
    }
  | {
      key: string;
      group: PropertyGroup;
      label: string;
      description?: string;
      type: "int";
      min?: number;
      max?: number;
      liveCommand?: (value: string) => string;
    }
  | {
      key: string;
      group: PropertyGroup;
      label: string;
      description?: string;
      type: "string";
      placeholder?: string;
      liveCommand?: (value: string) => string;
    };

export const PROPERTY_GROUPS: { id: PropertyGroup; label: string }[] = [
  { id: "gameplay", label: "게임플레이" },
  { id: "world", label: "월드" },
  { id: "players", label: "플레이어" },
  { id: "network", label: "네트워크" },
  { id: "performance", label: "성능" },
];

export const PROPERTY_META: PropertyMeta[] = [
  // --- 게임플레이 ---
  {
    key: "difficulty",
    group: "gameplay",
    label: "난이도",
    type: "enum",
    options: [
      { value: "peaceful", label: "평화로움" },
      { value: "easy", label: "쉬움" },
      { value: "normal", label: "보통" },
      { value: "hard", label: "어려움" },
    ],
    liveCommand: (v) => `difficulty ${v}`,
  },
  {
    key: "gamemode",
    group: "gameplay",
    label: "기본 게임모드",
    description: "새로 접속하는 플레이어의 게임모드",
    type: "enum",
    options: [
      { value: "survival", label: "서바이벌" },
      { value: "creative", label: "크리에이티브" },
      { value: "adventure", label: "어드벤처" },
      { value: "spectator", label: "관전" },
    ],
    liveCommand: (v) => `defaultgamemode ${v}`,
  },
  {
    key: "force-gamemode",
    group: "gameplay",
    label: "게임모드 강제",
    description: "접속할 때마다 기본 게임모드로 되돌림",
    type: "boolean",
  },
  { key: "hardcore", group: "gameplay", label: "하드코어", description: "죽으면 관전 모드로 전환", type: "boolean" },
  { key: "pvp", group: "gameplay", label: "PvP 허용", type: "boolean" },
  { key: "allow-flight", group: "gameplay", label: "비행 허용", description: "서바이벌에서 비행 감지 시 추방하지 않음 (모드 사용 시 켜두면 편함)", type: "boolean" },
  { key: "enable-command-block", group: "gameplay", label: "커맨드 블록 허용", type: "boolean" },
  { key: "spawn-protection", group: "gameplay", label: "스폰 보호 반경", description: "OP가 아니면 이 반경 안에서 블록을 못 부숨. 0이면 비활성", type: "int", min: 0, max: 100000 },
  { key: "spawn-monsters", group: "gameplay", label: "몬스터 스폰", type: "boolean" },
  { key: "spawn-animals", group: "gameplay", label: "동물 스폰", type: "boolean" },
  { key: "spawn-npcs", group: "gameplay", label: "주민 스폰", type: "boolean" },

  // --- 월드 ---
  { key: "level-name", group: "world", label: "월드 폴더 이름", type: "string", placeholder: "world" },
  { key: "level-seed", group: "world", label: "시드", description: "비워두면 랜덤. 이미 생성된 월드에는 영향 없음", type: "string" },
  {
    key: "level-type",
    group: "world",
    label: "월드 타입",
    type: "enum",
    options: [
      { value: "minecraft:normal", label: "일반" },
      { value: "minecraft:flat", label: "평지" },
      { value: "minecraft:large_biomes", label: "큰 바이옴" },
      { value: "minecraft:amplified", label: "증폭" },
    ],
  },
  { key: "generate-structures", group: "world", label: "구조물 생성", description: "마을, 요새 등", type: "boolean" },
  { key: "allow-nether", group: "world", label: "네더 허용", type: "boolean" },
  { key: "max-world-size", group: "world", label: "최대 월드 크기 (반지름)", type: "int", min: 1, max: 29999984 },

  // --- 플레이어 ---
  { key: "max-players", group: "players", label: "최대 인원", type: "int", min: 1, max: 1000 },
  { key: "white-list", group: "players", label: "화이트리스트 사용", description: "등록된 플레이어만 접속 가능", type: "boolean", liveCommand: (v) => `whitelist ${v === "true" ? "on" : "off"}` },
  { key: "enforce-whitelist", group: "players", label: "화이트리스트 강제", description: "켜면 화이트리스트에서 빠진 접속자를 즉시 추방", type: "boolean" },
  { key: "online-mode", group: "players", label: "정품 인증", description: "끄면 비정품 접속 가능 (보안상 권장하지 않음)", type: "boolean" },
  { key: "player-idle-timeout", group: "players", label: "잠수 추방 (분)", description: "0이면 끔", type: "int", min: 0, max: 10000 },
  { key: "op-permission-level", group: "players", label: "OP 권한 레벨", type: "int", min: 1, max: 4 },
  { key: "hide-online-players", group: "players", label: "접속자 목록 숨기기", description: "서버 목록에서 접속 중인 플레이어를 숨김", type: "boolean" },

  // --- 네트워크 ---
  { key: "motd", group: "network", label: "MOTD", description: "서버 목록에 표시되는 문구", type: "string", placeholder: "A Minecraft Server" },
  { key: "server-port", group: "network", label: "포트", type: "int", min: 1, max: 65535 },
  { key: "server-ip", group: "network", label: "바인딩 IP", description: "보통 비워둠", type: "string" },
  { key: "enable-status", group: "network", label: "서버 목록에 상태 표시", type: "boolean" },
  { key: "enable-rcon", group: "network", label: "RCON 사용", description: "외부 도구가 콘솔 명령을 보낼 수 있게 함", type: "boolean" },
  { key: "rcon.port", group: "network", label: "RCON 포트", type: "int", min: 1, max: 65535 },
  { key: "rcon.password", group: "network", label: "RCON 비밀번호", type: "string" },
  { key: "enable-query", group: "network", label: "Query 사용", type: "boolean" },
  { key: "require-resource-pack", group: "network", label: "리소스팩 강제", type: "boolean" },
  { key: "resource-pack", group: "network", label: "리소스팩 URL", type: "string" },

  // --- 성능 ---
  { key: "view-distance", group: "performance", label: "시야 거리 (청크)", type: "int", min: 3, max: 32 },
  { key: "simulation-distance", group: "performance", label: "시뮬레이션 거리 (청크)", type: "int", min: 3, max: 32 },
  { key: "entity-broadcast-range-percentage", group: "performance", label: "엔티티 전송 범위 (%)", type: "int", min: 10, max: 1000 },
  { key: "max-tick-time", group: "performance", label: "최대 틱 시간 (ms)", description: "초과하면 서버가 멈춘 것으로 간주. -1이면 끔", type: "int", min: -1 },
  { key: "network-compression-threshold", group: "performance", label: "압축 임계값 (bytes)", type: "int", min: -1 },
  { key: "sync-chunk-writes", group: "performance", label: "동기 청크 저장", description: "끄면 저장이 빨라지지만 크래시 시 손실 가능", type: "boolean" },
];

export const PROPERTY_META_BY_KEY: Record<string, PropertyMeta> = Object.fromEntries(
  PROPERTY_META.map((m) => [m.key, m]),
);
