import Fastify from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { HttpError } from "./lib/errors.js";
import { initAuth } from "./lib/auth.js";
import { installOriginGuard } from "./lib/originGuard.js";
import { authRoutes } from "./routes/auth.js";
import { serversRoutes } from "./routes/servers.js";
import { propertiesRoutes } from "./routes/properties.js";
import { playersRoutes } from "./routes/players.js";
import { modsRoutes } from "./routes/mods.js";
import { processRoutes } from "./routes/process.js";
import { mojangRoutes } from "./routes/mojang.js";
import { configsRoutes } from "./routes/configs.js";
import { logsRoutes } from "./routes/logs.js";
import { backupsRoutes } from "./routes/backups.js";
import { createRoutes } from "./routes/create.js";
import { fsRoutes } from "./routes/fs.js";
import { automationRoutes } from "./routes/automation.js";
import { networkRoutes } from "./routes/network.js";
import { statsRoutes } from "./routes/stats.js";
import { modrinthRoutes } from "./routes/modrinth.js";
import { startPlaytimeTracker } from "./services/stats.js";
import { startDiscordNotifier } from "./services/discord.js";
import { startAutoRestart } from "./services/autoRestart.js";
import { startScheduledRestarts, stopScheduledRestarts } from "./services/scheduledRestart.js";
import { startPerfSampler, stopPerfSampler } from "./services/perf.js";
import { CreateError } from "./services/create/errors.js";
import { shutdownAll } from "./services/process.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { cancelAllJobs, recoverInterruptedJobs } from "./services/create/job.js";

const PORT = Number(process.env.BLOCKPILOT_PORT ?? 4800);
const HOST = process.env.BLOCKPILOT_HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// CORS 는 일부러 켜지 않는다. 대시보드는 같은 출처에서 서빙되고, 다른 출처(악성 페이지 등)의 요청은 아래 가드가 막는다.
installOriginGuard(app, HOST);
await app.register(websocket);
await app.register(multipart);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (err instanceof CreateError) {
    const status = err.code === "busy" ? 409 : ["network", "http_error", "not_found"].includes(err.code) ? 502 : 400;
    return reply.code(status).send({ error: err.code, message: err.message, hint: err.hint, detail: err.detail });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "validation", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
  }
  app.log.error(err);
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({ error: "internal", message: e.message ?? "서버 오류" });
});

await initAuth(app, HOST);

await app.register(authRoutes);
await app.register(serversRoutes);
await app.register(propertiesRoutes);
await app.register(playersRoutes);
await app.register(modsRoutes);
await app.register(processRoutes);
await app.register(mojangRoutes);
await app.register(configsRoutes);
await app.register(logsRoutes);
await app.register(backupsRoutes);
await app.register(createRoutes);
await app.register(fsRoutes);
await app.register(automationRoutes);
await app.register(networkRoutes);
await app.register(statsRoutes);
await app.register(modrinthRoutes);

// 프로덕션: 빌드된 프론트엔드 서빙 (packages/web/dist)
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [path.resolve(here, "../../web/dist"), path.resolve(here, "../../../web/dist")].find((p) => fs.existsSync(path.join(p, "index.html")));
if (webDist) {
  // wildcard 모드: 파일이 없으면 notFound 핸들러로 넘어가 SPA index.html 을 돌려준다
  // (wildcard:false 는 시작 시점의 파일 목록을 고정해 재빌드 후 해시가 바뀐 번들을 못 찾는다)
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found", message: "없는 API 경로입니다." });
    return reply.sendFile("index.html");
  });
}

startScheduler(app.log);
startDiscordNotifier();
startAutoRestart();
startScheduledRestarts();
startPerfSampler();
startPlaytimeTracker();
// 지난번에 만들기 도중 꺼졌다면 그때 만들던 파일을 정리
await recoverInterruptedJobs(app.log);

const stop = async () => {
  app.log.info("종료 중: 실행 중인 서버를 정리합니다");
  stopScheduler();
  stopScheduledRestarts();
  stopPerfSampler();
  // 만들던 서버가 있으면 취소하고 이번에 만든 파일을 지운 뒤 끈다
  await cancelAllJobs();
  await shutdownAll();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port: PORT, host: HOST });
