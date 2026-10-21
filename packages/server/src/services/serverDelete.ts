import fsp from "node:fs/promises";
import path from "node:path";
import type { DeleteServerResult, RegisteredServer } from "@blockpilot/shared";
import { listServers, removeServer } from "../config/store.js";
import { badRequest, conflict } from "../lib/errors.js";
import { activeJob } from "./create/job.js";
import { assertDeletableTarget } from "./create/target.js";
import { forgetManaged, type ManagedServer } from "./process.js";
import { forgetPlaytime } from "./stats.js";
import { isBackupRunning } from "./scheduler.js";
import { validateServerDir } from "./serverInfo.js";
import { platform } from "./platform/index.js";
import { isInsidePath, samePath } from "../lib/paths.js";

/**
 * 서버 폴더를 디스크에서 완전히 지우고 목록에서도 뺀다. 되돌릴 수 없다.
 *
 * 지우기 전에 확인하는 것:
 * - 사용자가 서버 이름을 그대로 입력했는지
 * - 서버가 꺼져 있는지 (BlockPilot 이 띄운 것도, 밖에서 띄운 것도), 자동 백업·새 서버 만들기가 이 폴더를 쓰고 있지 않은지
 * - 실제 경로(심볼릭 링크를 따라간 곳)가 시스템·홈·앱 폴더가 아니고, 여전히 마인크래프트 서버 폴더인지
 * - 그 안에 다른 등록된 서버가 들어 있지 않은지
 */
export async function deleteServerFolder(server: RegisteredServer, managed: ManagedServer, confirmName: string): Promise<DeleteServerResult> {
  if (confirmName !== server.name) {
    throw badRequest(`확인용 이름이 달라요. '${server.name}' 을(를) 그대로 입력해 주세요.`);
  }

  const status = await managed.status();
  if (managed.isManaged() || status.state !== "stopped") {
    throw conflict("서버가 켜져 있어요. 레버를 내려 서버를 끈 뒤 다시 시도해 주세요.");
  }
  if (isBackupRunning(server.id)) throw conflict("자동 백업이 진행 중이에요. 끝난 뒤 다시 시도해 주세요.");

  const registered = path.resolve(server.path);
  let real: string;
  try {
    real = await fsp.realpath(registered);
  } catch {
    throw badRequest("서버 폴더가 이미 없어요. 목록에서 빼려면 서버 목록에서 '등록 해제'를 눌러 주세요.");
  }

  // 시스템·홈·앱 폴더, 너무 얕은 경로는 거부 (CreateError → 400)
  assertDeletableTarget(real);
  // 폴더가 다른 것으로 바뀌었으면 지우지 않는다
  await validateServerDir(real);

  for (const other of await listServers()) {
    if (other.id === server.id) continue;
    const otherReal = await fsp.realpath(other.path).catch(() => path.resolve(other.path));
    if (isInsidePath(otherReal, real)) {
      throw conflict(`이 폴더 안에 다른 등록된 서버 '${other.name}' 가 있어서 지울 수 없어요.`);
    }
  }

  const job = activeJob();
  if (job?.journal && isInsidePath(job.journal.target, real)) {
    throw conflict("이 폴더에서 새 서버를 만들고 있어요. 끝난 뒤 다시 시도해 주세요.");
  }

  try {
    await fsp.rm(real, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    const stillThere = await fsp.stat(real).then(() => true, () => false);
    const code = (e as { code?: string }).code;
    const reason = code === "EACCES" || code === "EPERM" ? "권한이 없는 파일이 있어요" : (e as Error).message;
    // 폴더가 남아 있으면 목록에서도 빼지 않는다 (사용자가 다시 시도하거나 직접 정리할 수 있게)
    if (stillThere) throw conflict(`일부 파일을 지우지 못했어요 (${reason}). 남은 파일은 ${platform.words.fileManager}에서 확인해 주세요.`);
  }

  let removedLink: string | undefined;
  if (!samePath(registered, real)) {
    const st = await fsp.lstat(registered).catch(() => null);
    if (st?.isSymbolicLink()) {
      await fsp.unlink(registered).catch(() => {});
      removedLink = registered;
    }
  }

  await removeServer(server.id);
  await forgetPlaytime(server.id);
  forgetManaged(server.id);
  return { deletedPath: real, removedLink };
}
