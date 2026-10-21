/**
 * Windows 는 방금 받은 파일을 백신이 검사하거나, 켜져 있는 서버가 파일을 잡고 있으면 잠깐 rename/삭제가 실패한다(EPERM·EBUSY·EACCES).
 * 그런 경우에만 짧게 몇 번 다시 시도한다. macOS·Linux 에서는 보통 첫 시도에 끝난다.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

export async function retryFs<T>(fn: () => Promise<T>, attempts = 6, delayMs = 150): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!TRANSIENT.has((e as { code?: string }).code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}
