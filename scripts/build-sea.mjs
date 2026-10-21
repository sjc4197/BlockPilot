// BlockPilot 단일 실행 파일(Node SEA) 빌드
//
//   node scripts/build-sea.mjs                 이 컴퓨터용
//   node scripts/build-sea.mjs --target linux-arm64 --skip-web
//
// 1) 웹 화면 빌드 → 2) 서버를 파일 하나(CJS)로 묶기 → 3) 웹 파일을 넣은 SEA blob 만들기
// 4) 대상 OS 의 공식 Node 실행 파일을 받아 해시 확인 → 5) blob 주입(맥은 임시 서명) → 6) 압축
// 결과: release/blockpilot-v<버전>-<대상>.zip | .tar.gz
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import yazl from "yazl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const NODE_VERSION = process.version; // 묶는 Node 와 blob 을 만드는 Node 를 같은 버전으로
const OUT = path.join(ROOT, "out", "sea");
const RELEASE = path.join(ROOT, "release");

const TARGETS = {
  "macos-arm64": { os: "darwin", arch: "arm64", ext: "tar.gz", exe: "blockpilot" },
  "macos-x64": { os: "darwin", arch: "x64", ext: "tar.gz", exe: "blockpilot" },
  "linux-x64": { os: "linux", arch: "x64", ext: "tar.xz", exe: "blockpilot" },
  "linux-arm64": { os: "linux", arch: "arm64", ext: "tar.xz", exe: "blockpilot" },
  "windows-x64": { os: "win", arch: "x64", ext: "zip", exe: "blockpilot.exe" },
  "windows-arm64": { os: "win", arch: "arm64", ext: "zip", exe: "blockpilot.exe" },
};
const hostOs = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];
const argv = process.argv.slice(2);
const target = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : `${hostOs}-${process.arch}`;
const T = TARGETS[target];
if (!T) throw new Error(`지원하지 않는 대상: ${target} (가능: ${Object.keys(TARGETS).join(", ")})`);
if (T.os === "darwin" && process.platform !== "darwin") throw new Error("macOS 용은 서명 때문에 macOS 에서 빌드해야 해요.");

const log = (m) => console.log(`▶ ${m}`);
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && cmd === "npm", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} 실패 (code ${r.status})`);
};

// 1) 웹 화면
const webDist = path.join(ROOT, "packages", "web", "dist");
if (!argv.includes("--skip-web")) {
  log("웹 화면 빌드");
  run("npm", ["run", "build", "--workspace=packages/web"], { cwd: ROOT });
}
if (!fs.existsSync(path.join(webDist, "index.html"))) throw new Error("packages/web/dist 가 없어요. 웹 화면부터 빌드해 주세요.");

// 2) 서버 묶기 (모든 대상이 같은 파일을 쓴다)
await fsp.mkdir(OUT, { recursive: true });
const bundle = path.join(OUT, "server.cjs");
log("서버 묶기 (esbuild)");
await build({
  entryPoints: [path.join(ROOT, "packages", "server", "src", "index.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  // ws 의 선택적 네이티브 가속 모듈 (없으면 순수 JS 로 동작)
  external: ["bufferutil", "utf-8-validate"],
  define: { __BLOCKPILOT_VERSION__: JSON.stringify(VERSION), "import.meta.url": "__bp_import_meta_url" },
  banner: { js: 'const __bp_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

// 3) SEA blob: 묶은 서버 + 웹 파일
const tdir = path.join(OUT, target);
await fsp.rm(tdir, { recursive: true, force: true });
await fsp.mkdir(tdir, { recursive: true });
const webFiles = [];
const walk = async (d) => {
  for (const e of await fsp.readdir(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) await walk(full);
    else webFiles.push(path.relative(webDist, full).split(path.sep).join("/"));
  }
};
await walk(webDist);
const manifest = path.join(tdir, "web-manifest.json");
await fsp.writeFile(manifest, JSON.stringify(webFiles));
const assets = { "web-manifest.json": manifest };
for (const f of webFiles) assets[`web/${f}`] = path.join(webDist, ...f.split("/"));
const blob = path.join(tdir, "sea-prep.blob");
const seaConfig = path.join(tdir, "sea-config.json");
await fsp.writeFile(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2));
log(`SEA blob 만들기 (웹 파일 ${webFiles.length}개)`);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 4) 대상 OS 의 공식 Node (Homebrew 등 이 컴퓨터의 node 는 다른 컴퓨터에서 안 돌 수 있어서 항상 공식 파일)
const cache = path.join(ROOT, "out", "node-cache");
await fsp.mkdir(cache, { recursive: true });
const base = `node-${NODE_VERSION}-${T.os}-${T.arch}`;
const archive = path.join(cache, `${base}.${T.ext}`);
const sums = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
const download = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 받기 실패 (${res.status})`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
};
if (!fs.existsSync(sums)) await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
const expected = fs.readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${base}.${T.ext}`))?.split(/\s+/)[0];
if (!expected) throw new Error(`SHASUMS256 에 ${base}.${T.ext} 가 없어요.`);
if (!fs.existsSync(archive) || sha256(archive) !== expected) {
  log(`공식 Node 받기: ${base}.${T.ext}`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${base}.${T.ext}`, archive);
}
if (sha256(archive) !== expected) throw new Error(`${base}.${T.ext} 해시가 맞지 않아요.`);
log("공식 Node 해시 확인 (sha256 일치)");
const extractDir = path.join(cache, base);
if (!fs.existsSync(extractDir)) {
  if (T.ext === "zip" && process.platform === "linux") run("unzip", ["-q", archive, "-d", cache]);
  // Windows: Git Bash 의 GNU tar 는 "D:\…" 를 원격 주소로 읽고 zip 도 못 푼다 → Windows 기본 tar.exe(bsdtar)
  else if (process.platform === "win32") run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", cache]);
  else run("tar", ["-xf", archive, "-C", cache]);
}
const nodeBin = T.os === "win" ? path.join(extractDir, "node.exe") : path.join(extractDir, "bin", "node");

// 5) 주입
const exe = path.join(tdir, T.exe);
await fsp.copyFile(nodeBin, exe);
await fsp.chmod(exe, 0o755);
if (T.os === "darwin") run("codesign", ["--remove-signature", exe]);
log("blob 주입 (postject)");
const postject = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
run(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(T.os === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);
// Apple 실리콘은 서명이 없으면 실행이 안 돼서 임시(ad-hoc) 서명만 한다 (개발자 인증서 서명 아님)
if (T.os === "darwin") run("codesign", ["--sign", "-", "--force", exe]);

// 6) 압축: 실행 파일 + 안내 + 라이선스
await fsp.mkdir(RELEASE, { recursive: true });
const folder = `blockpilot-v${VERSION}-${target}`;
const readme = (await fsp.readFile(path.join(ROOT, "scripts", "release-readme.txt"), "utf8")).replaceAll("{VERSION}", VERSION).replaceAll("{EXE}", T.exe);
const license = await fsp.readFile(path.join(ROOT, "LICENSE"));
let outFile;
if (T.os === "linux") {
  const stage = path.join(tdir, "stage", folder);
  await fsp.mkdir(stage, { recursive: true });
  await fsp.copyFile(exe, path.join(stage, T.exe));
  await fsp.chmod(path.join(stage, T.exe), 0o755);
  await fsp.writeFile(path.join(stage, "실행방법.txt"), readme);
  await fsp.writeFile(path.join(stage, "LICENSE"), license);
  outFile = path.join(RELEASE, `${folder}.tar.gz`);
  run("tar", ["-czf", outFile, "-C", path.join(tdir, "stage"), folder]);
} else {
  outFile = path.join(RELEASE, `${folder}.zip`);
  const zip = new yazl.ZipFile();
  // 실행 권한(0755)을 zip 에 남겨서 맥에서 풀어도 바로 실행되게
  zip.addFile(exe, `${folder}/${T.exe}`, { mode: 0o100755 });
  zip.addBuffer(Buffer.from(T.os === "win" ? readme.replace(/\n/g, "\r\n") : readme), `${folder}/실행방법.txt`, { mode: 0o100644 });
  zip.addBuffer(license, `${folder}/LICENSE`, { mode: 0o100644 });
  zip.end();
  await new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(outFile)).on("close", resolve).on("error", reject));
}
const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
log(`완성: ${path.relative(ROOT, outFile)} (${mb}MB)`);
console.log(`  실행 파일: ${path.relative(ROOT, exe)}`);
console.log(`  sha256: ${sha256(outFile)}`);
