import yauzl from "yauzl";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

type Matcher = string[] | ((name: string) => boolean);

export interface ReadZipOptions {
  /** 읽은 내용 합계가 이 바이트를 넘으면 읽기를 멈추고 실패한다 (압축 폭탄·거대한 항목 대비) */
  maxBytes?: number;
}

/**
 * jar(zip) 안에서 필요한 항목만 읽는다. 모드 메타데이터는 작으니 전부 메모리에 올려도 무방.
 * 이름 목록을 주면 그 이름을 다 찾는 즉시 멈춘다 (같은 이름이 또 나와도 처음 것만).
 * @param wanted 읽고 싶은 항목 이름 목록, 또는 이름을 받아 true/false를 돌려주는 함수
 */
export function readZipEntries(file: string, wanted: Matcher, opts: ReadZipOptions = {}): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      collect(zip, wanted, opts, resolve, reject);
    });
  });
}

/** 메모리에 올라온 jar(중첩 jar 등)에서 읽기 */
export function readZipEntriesFromBuffer(buf: Buffer, wanted: Matcher, opts: ReadZipOptions = {}): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      collect(zip, wanted, opts, resolve, reject);
    });
  });
}

function collect(
  zip: yauzl.ZipFile,
  wanted: Matcher,
  opts: ReadZipOptions,
  resolve: (m: Map<string, Buffer>) => void,
  reject: (e: unknown) => void,
) {
  const names = Array.isArray(wanted) ? new Set(wanted) : null;
  const match = names ? (n: string) => names.has(n) : (wanted as (name: string) => boolean);
  const max = opts.maxBytes ?? Infinity;
  const out = new Map<string, Buffer>();
  let total = 0;
  let settled = false;
  const fail = (e: unknown) => {
    if (settled) return;
    settled = true;
    zip.close();
    reject(e);
  };
  const done = () => {
    if (settled) return;
    settled = true;
    zip.close();
    resolve(out);
  };
  zip.on("error", fail);
  zip.on("end", done);
  zip.on("entry", (entry: yauzl.Entry) => {
    if (settled) return;
    if (!match(entry.fileName) || entry.fileName.endsWith("/") || out.has(entry.fileName)) return zip.readEntry();
    if (total + entry.uncompressedSize > max) return fail(new Error(`zip 항목이 너무 커요: ${entry.fileName} (${entry.uncompressedSize}바이트)`));
    zip.openReadStream(entry, (e, stream) => {
      if (e || !stream) return fail(e);
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => {
        total += c.length;
        if (total > max) {
          stream.destroy();
          return fail(new Error(`zip 항목이 너무 커요: ${entry.fileName}`));
        }
        chunks.push(c);
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (settled) return;
        out.set(entry.fileName, Buffer.concat(chunks));
        // 찾던 이름을 다 읽었으면 나머지 항목은 보지 않는다
        if (names && out.size >= names.size) return done();
        zip.readEntry();
      });
    });
  });
  zip.readEntry();
}

/**
 * match 가 true 인 항목을 하나씩 메모리에 읽어 handler 에 넘긴다 (handler 가 끝나야 다음 항목).
 * 큰 항목을 한꺼번에 올리지 않기 위해 — 거를 크기는 match(name, size) 에서 정한다. 심볼릭 링크·폴더는 넘기지 않는다.
 */
export function forEachZipEntry(file: string, match: (name: string, size: number) => boolean, handler: (name: string, data: Buffer) => Promise<void> | void): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(e);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;
        if (entry.fileName.endsWith("/") || isSymlinkEntry(entry) || !match(entry.fileName, entry.uncompressedSize)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", fail);
          stream.on("end", () => {
            Promise.resolve()
              .then(() => handler(entry.fileName, Buffer.concat(chunks)))
              .then(() => {
                if (!settled) zip.readEntry();
              }, fail);
          });
        });
      });
      zip.readEntry();
    });
  });
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

// ---------- 항목 목록 · 접두사만 풀기 (모드팩 .mrpack) ----------

export interface ZipEntryInfo {
  name: string;
  /** 압축을 푼 크기 (중앙 디렉터리 값. yauzl 이 실제 크기와 대조한다) */
  size: number;
  dir: boolean;
  /** 유닉스 심볼릭 링크 항목 */
  symlink: boolean;
}

/** 유닉스 모드가 심볼릭 링크인 항목 (externalFileAttributes 상위 16비트) */
export function isSymlinkEntry(entry: { externalFileAttributes: number }): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

/**
 * zip 의 항목 목록만 읽는다 (내용은 읽지 않음).
 * 항목 수가 maxEntries 를 넘으면 목록을 만들지 않고 entryCount 만 돌려준다 (압축 폭탄 대비).
 */
export function listZipEntries(file: string, maxEntries = Infinity): Promise<{ entries: ZipEntryInfo[]; entryCount: number }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      if (zip.entryCount > maxEntries) {
        zip.close();
        return resolve({ entries: [], entryCount: zip.entryCount });
      }
      const entries: ZipEntryInfo[] = [];
      zip.on("error", (e) => {
        zip.close();
        reject(e);
      });
      zip.on("end", () => resolve({ entries, entryCount: zip.entryCount }));
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.push({ name: entry.fileName, size: entry.uncompressedSize, dir: entry.fileName.endsWith("/"), symlink: isSymlinkEntry(entry) });
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/** dest 아래를 가리키는 절대 경로. 밖을 가리키면(../, 절대 경로) 예외 */
function entryTarget(root: string, rel: string): string {
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`zip 항목이 폴더 밖을 가리켜요: ${rel}`);
  return target;
}

/** extractZipPrefixTo 가 항목마다 묻는 처리 방법: 쓰기 · 건너뛰기 · 파일 대신 메모리로 넘기기 */
export type ExtractAction = "write" | "skip" | "capture";

export interface ExtractPrefixOptions {
  /** 쓰기 전에 하는 더 엄격한 이름 검사 (건너뛰는 항목엔 하지 않음) */
  checkName?: (rel: string) => void;
  /** 항목(prefix 를 뗀 경로, 폴더는 끝의 / 없이)마다 처리 방법. 없으면 전부 write */
  filter?: (rel: string, entryName: string, dir: boolean) => ExtractAction;
  /** filter 가 capture 라고 한 항목의 내용 */
  onCapture?: (rel: string, data: Buffer) => void;
  /** capture 항목 크기 상한 (기본 1MB) */
  captureMaxBytes?: number;
}

/**
 * zip 안에서 prefix(예 "overrides/") 로 시작하는 항목만, prefix 를 떼고 dest 아래에 푼다. 이미 있는 파일은 덮어쓴다.
 * extractZipTo 와 같은 경로 검사에 더해 심볼릭 링크 항목을 거부하고, checkName 으로 더 엄격한 이름 검사를 끼울 수 있다.
 * filter 로 항목을 건너뛰거나(skip) 파일 대신 내용만 받을(capture) 수 있다.
 * @returns 푼 파일 수 (폴더·건너뛴 것·capture 제외)
 */
export function extractZipPrefixTo(file: string, prefix: string, dest: string, opts: ExtractPrefixOptions = {}): Promise<number> {
  const root = path.resolve(dest);
  const captureMax = opts.captureMaxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      let count = 0;
      let failed = false;
      const fail = (e: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(e);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed) resolve(count);
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (failed) return;
        if (!entry.fileName.startsWith(prefix)) return zip.readEntry();
        const rel = entry.fileName.slice(prefix.length);
        if (!rel || rel === "/") return zip.readEntry();
        const isDir = rel.endsWith("/");
        const name = isDir ? rel.slice(0, -1) : rel;
        let target: string;
        let action: ExtractAction;
        try {
          if (isSymlinkEntry(entry)) throw new Error(`zip 안의 심볼릭 링크는 풀지 않아요: ${entry.fileName}`);
          action = opts.filter?.(name, entry.fileName, isDir) ?? "write";
          if (action === "skip" || (isDir && action === "capture")) return zip.readEntry();
          opts.checkName?.(name);
          target = entryTarget(root, rel);
        } catch (e) {
          return fail(e);
        }
        if (isDir) {
          fsp.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        if (action === "capture") {
          if (entry.uncompressedSize > captureMax) return fail(new Error(`zip 항목이 너무 커요: ${entry.fileName}`));
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return fail(e);
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("error", fail);
            stream.on("end", () => {
              if (failed) return;
              try {
                opts.onCapture?.(name, Buffer.concat(chunks));
              } catch (ce) {
                return fail(ce);
              }
              zip.readEntry();
            });
          });
          return;
        }
        fsp.mkdir(path.dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return fail(e);
            const out = createWriteStream(target);
            out.on("error", fail);
            out.on("close", () => {
              if (failed) return;
              count++;
              zip.readEntry();
            });
            stream.on("error", (se) => {
              out.destroy();
              fail(se);
            });
            stream.pipe(out);
          });
        }, fail);
      });
      zip.readEntry();
    });
  });
}
