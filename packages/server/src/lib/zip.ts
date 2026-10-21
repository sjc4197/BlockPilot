import yauzl from "yauzl";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

type Matcher = string[] | ((name: string) => boolean);

/**
 * jar(zip) 안에서 필요한 항목만 읽는다. 모드 메타데이터는 작으니 전부 메모리에 올려도 무방.
 * @param wanted 읽고 싶은 항목 이름 목록, 또는 이름을 받아 true/false를 돌려주는 함수
 */
export function readZipEntries(file: string, wanted: Matcher): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      collect(zip, wanted, resolve, reject);
    });
  });
}

/** 메모리에 올라온 jar(중첩 jar 등)에서 읽기 */
export function readZipEntriesFromBuffer(buf: Buffer, wanted: Matcher): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      collect(zip, wanted, resolve, reject);
    });
  });
}

function collect(
  zip: yauzl.ZipFile,
  wanted: Matcher,
  resolve: (m: Map<string, Buffer>) => void,
  reject: (e: unknown) => void,
) {
  const match = Array.isArray(wanted) ? (n: string) => wanted.includes(n) : wanted;
  const out = new Map<string, Buffer>();
  zip.on("error", reject);
  zip.on("end", () => resolve(out));
  zip.on("entry", (entry) => {
    if (!match(entry.fileName) || entry.fileName.endsWith("/")) return zip.readEntry();
    zip.openReadStream(entry, (e, stream) => {
      if (e || !stream) return reject(e);
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("error", reject);
      stream.on("end", () => {
        out.set(entry.fileName, Buffer.concat(chunks));
        zip.readEntry();
      });
    });
  });
  zip.readEntry();
}

/**
 * zip 을 dest 아래에 푼다 (Windows JDK 용). 항목 이름이 dest 밖을 가리키면(../, 절대 경로) 거부한다.
 */
export function extractZipTo(file: string, dest: string): Promise<void> {
  const root = path.resolve(dest);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) return reject(new Error(`zip 항목이 폴더 밖을 가리켜요: ${entry.fileName}`));
        if (entry.fileName.endsWith("/")) {
          fsp.mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        fsp.mkdir(path.dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return reject(e);
            const out = createWriteStream(target);
            out.on("error", reject);
            out.on("close", () => zip.readEntry());
            stream.on("error", reject);
            stream.pipe(out);
          });
        }, reject);
      });
      zip.readEntry();
    });
  });
}
