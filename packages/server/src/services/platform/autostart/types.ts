import type { AutostartMethod } from "@blockpilot/shared";

/** 로그인 항목에 적을 내용 */
export interface AutostartSpec {
  /** BlockPilot 실행 파일 절대 경로 */
  exe: string;
  /** 자동 실행된 인스턴스에 줄 환경 변수 (BLOCKPILOT_PORT 등 + BLOCKPILOT_AUTOSTARTED=1) */
  env: Record<string, string>;
  /** 로그·작업 폴더 (BLOCKPILOT_HOME) */
  home: string;
}

export interface AutostartState {
  enabled: boolean;
  /** 등록에 적힌 실행 파일 */
  registeredExe?: string;
  /** 실제로 쓰인 방식 (Linux 는 systemd 가 없으면 xdg 로 떨어진다) */
  method?: AutostartMethod;
}

export interface AutostartOpts {
  /** 지금 프로세스가 이 등록으로 켜진 것인지. 그러면 실행 중인 자기 자신을 내리거나 다시 띄우지 않는다 */
  selfAutostarted: boolean;
}

/**
 * OS 별 로그인 항목 등록. 파일·명령 생성은 순수 함수로 따로 두어 어느 OS 에서든 테스트한다.
 */
export interface AutostartBackend {
  method: AutostartMethod;
  methodLabel: string;
  hint?: string;
  status(): Promise<AutostartState>;
  enable(spec: AutostartSpec, opts: AutostartOpts): Promise<void>;
  disable(opts: AutostartOpts): Promise<void>;
}

/** BlockPilot 이 자동 실행 인스턴스에 넘기는 인자 */
export const AUTOSTART_FLAG = "--autostart";
