import yauzl from "yauzl";

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
