/**
 * BlockPilot 자체가 예기치 않은 오류로 죽을 때, 켜 둔 마인크래프트 서버를 고아로 남기지 않는다.
 * uncaughtException / unhandledRejection 을 받으면 onFatal(보통 SIGINT 와 같은 종료 경로)을 돌리고,
 * 그것이 FATAL_CAP_MS 안에 끝나지 않아도 프로세스는 끝낸다 (종료 경로가 다시 죽어도 한 번만 처리).
 */

// 서버 stop 유예(30초)+강제 종료 단계보다 길게 잡아 월드 저장 도중 BlockPilot 만 먼저 죽지 않게 한다
const FATAL_CAP_MS = 50_000;

export function installCrashGuard(
  onFatal: (err: unknown) => Promise<void>,
  opts: { capMs?: number; exit?: (code: number) => void; target?: NodeJS.EventEmitter } = {},
) {
  const capMs = opts.capMs ?? FATAL_CAP_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  // 테스트에서는 process 대신 다른 EventEmitter 에 걸 수 있다
  const target: NodeJS.EventEmitter = opts.target ?? process;
  let handling = false;

  const handle = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown) => {
    if (handling) {
      // 정리하는 도중 또 터진 것: 정리가 끝나거나 시간이 다할 때까지 기다린다
      console.error(`[BlockPilot] 종료 정리 중 오류가 또 났어요 (${kind}):`, err);
      return;
    }
    handling = true;
    console.error(`\n[BlockPilot] 치명적인 오류로 꺼져요 (${kind}). 켜 둔 마인크래프트 서버를 먼저 안전하게 끕니다 (최대 ${Math.round(capMs / 1000)}초).`);
    console.error(err);
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      console.error(`[BlockPilot] ${why}`);
      exit(1);
    };
    const timer = setTimeout(() => finish("정리가 제때 끝나지 않아 그대로 종료해요."), capMs);
    timer.unref?.();
    onFatal(err).then(
      () => {
        clearTimeout(timer);
        finish("정리를 마치고 종료해요.");
      },
      (e) => {
        clearTimeout(timer);
        console.error("[BlockPilot] 종료 정리에 실패했어요:", e);
        finish("그대로 종료해요.");
      },
    );
  };

  const onException = handle("uncaughtException");
  const onRejection = handle("unhandledRejection");
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  /** 핸들러 해제 */
  return () => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}
