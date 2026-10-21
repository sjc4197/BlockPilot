/**
 * 자식 프로세스 출력을 줄 단위로 자른다.
 * 바이트로 모았다가 줄바꿈에서 자르므로, 여러 바이트 글자(한글)가 청크 경계에서 잘려도 깨지지 않는다.
 * 줄마다 decode 를 따로 하므로 Windows 처럼 UTF-8 과 CP949 가 섞여 나와도 줄 단위로 맞게 읽는다.
 */
export class LineSplitter {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private decode: (b: Buffer) => string,
    private onLine: (line: string) => void,
  ) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i: number;
    while ((i = this.buf.indexOf(10)) >= 0) {
      let line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      this.onLine(this.decode(line));
    }
  }

  /** 아직 줄바꿈이 오지 않은 조각 (Windows pause 의 "계속하려면 아무 키나…" 처럼 줄바꿈 없이 기다리는 안내를 알아보려고) */
  pending(): string {
    return this.buf.length ? this.decode(this.buf) : "";
  }

  /** 프로세스가 끝났을 때 줄바꿈 없이 남은 마지막 조각 */
  flush() {
    if (this.buf.length) this.onLine(this.decode(this.buf));
    this.buf = Buffer.alloc(0);
  }
}
