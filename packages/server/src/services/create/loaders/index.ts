import type { CreateLoader, CreateLoaderInfo } from "@blockpilot/shared";
import type { LoaderProvider } from "./types.js";
import { vanilla } from "./vanilla.js";
import { fabric } from "./fabric.js";
import { paper } from "./paper.js";
import { forge } from "./forge.js";
import { neoforge } from "./neoforge.js";
import { CreateError } from "../errors.js";

export type { LoaderProvider, InstallContext, LaunchSpec, LoaderVersions } from "./types.js";

/** 화면에 보여 줄 순서 */
export const providers: Record<CreateLoader, LoaderProvider> = { vanilla, fabric, paper, forge, neoforge };

export const LOADER_ORDER: CreateLoader[] = ["fabric", "paper", "forge", "neoforge", "vanilla"];

export function loaderInfos(): CreateLoaderInfo[] {
  return LOADER_ORDER.filter((id) => providers[id]).map((id) => providers[id].info);
}

export function providerOf(loader: string): LoaderProvider {
  const p = providers[loader as CreateLoader];
  if (!p) throw new CreateError("invalid_setting", `'${loader}' 는 만들 수 없는 서버 종류예요.`, "목록에 있는 종류를 골라 주세요.");
  return p;
}
