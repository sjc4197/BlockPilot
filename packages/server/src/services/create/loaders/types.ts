import type { CreateLoader, CreateLoaderInfo } from "@blockpilot/shared";
import type { LaunchSpec } from "../../platform/types.js";
import type { CreateJob } from "../job.js";
import type { JavaRuntime } from "../java.js";
import type { McRelease } from "./mojang.js";

export type { LaunchSpec } from "../../platform/types.js";

export interface LoaderVersionEntry {
  version: string;
  /** 안정 빌드. 아니면 화면에 "(베타)" */
  stable: boolean;
}

export interface LoaderVersions {
  versions: LoaderVersionEntry[];
  /** 기본 선택. 보통 최신 안정, 없으면 최신 beta */
  recommended?: string;
}

/** 받을 파일 크기 안내 (version-info 화면용) */
export interface DownloadEstimate {
  mb: number;
  note?: string;
}

export interface InstallContext {
  job: CreateJob;
  /** 서버 폴더 (절대 경로) */
  target: string;
  mc: string;
  loaderVersion: string;
  java: JavaRuntime;
  /** 앱 폴더 안 임시 폴더 (작업이 끝나면 지워짐) */
  tmp: string;
  /** Mojang server.jar 다운로드 정보 (순정·Fabric 이 씀) */
  server: { url: string; sha1: string; size: number };
}

/**
 * 서버 종류별 공급자. 파이프라인은 OS 도 로더도 직접 묻지 않고 이 인터페이스만 쓴다.
 * - 목록 함수는 네트워크를 쓰고 10분 캐시
 * - install 은 "server-jar" 와 "loader" 두 단계를 직접 진행(또는 건너뜀)하고 시작 명령을 돌려준다
 */
export interface LoaderProvider {
  info: CreateLoaderInfo;
  /** 이 로더로 만들 수 있는 Mojang 정식 버전 (최신순) */
  listReleases(signal?: AbortSignal): Promise<McRelease[]>;
  /** mc 버전에 맞는 로더 버전 목록. 순정은 빈 목록 */
  listVersions(mc: string, signal?: AbortSignal): Promise<LoaderVersions>;
  /** 이 로더가 요구하는 Java major. 기본은 Mojang 값 */
  javaMajor(mc: string, mojangMajor: number, signal?: AbortSignal): Promise<number>;
  /** version-info 화면에 보여 줄 받을 크기 */
  downloadEstimate(mc: string, loaderVersion: string | undefined, serverJarBytes: number, signal?: AbortSignal): Promise<DownloadEstimate>;
  /** 고른 로더 버전이 mc 에 맞는지. 아니면 CreateError(not_found) */
  assertVersion(mc: string, loaderVersion: string, signal?: AbortSignal): Promise<void>;
  install(ctx: InstallContext): Promise<LaunchSpec>;
}

export type { CreateLoader };
