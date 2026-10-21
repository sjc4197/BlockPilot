import type { FastifyInstance } from "fastify";
import { AutomationSettings, AutomationUpdate, type AutomationView } from "@blockpilot/shared";
import { getAutomation, setAutomation } from "../config/store.js";
import { loadContext } from "../lib/context.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { discordStatus, isWebhookUrl, sendTestMessage, webhookHint } from "../services/discord.js";
import { automationRuntime } from "../services/automationState.js";

/** 화면용: 웹훅 주소는 절대 돌려주지 않는다 */
export async function automationView(id: string): Promise<AutomationView> {
  const a = await getAutomation(id);
  const rt = automationRuntime(id);
  return {
    discord: { webhookSet: !!a.discord.webhookUrl, webhookHint: webhookHint(a.discord.webhookUrl), events: a.discord.events, ...discordStatus(id) },
    autoRestart: { ...a.autoRestart, recentAttempts: rt.recentAttempts, gaveUp: rt.gaveUp },
    scheduledRestart: { ...a.scheduledRestart, nextAt: rt.nextScheduledAt, skipNext: rt.skipNext },
    lastCrash: rt.lastCrash,
  };
}

export async function automationRoutes(app: FastifyInstance) {
  app.get("/api/servers/:id/automation", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    return automationView(id);
  });

  app.put("/api/servers/:id/automation", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    const u = AutomationUpdate.parse(req.body ?? {});
    const cur = await getAutomation(id);
    const url = u.discord?.webhookUrl?.trim();
    if (url && !isWebhookUrl(url)) throw badRequest("디스코드 웹훅 주소가 아니에요. 채널 설정 → 연동 → 웹후크에서 \"웹후크 URL 복사\"로 받은 주소를 붙여 넣어 주세요.");
    const next = AutomationSettings.parse({
      discord: { webhookUrl: url === undefined ? cur.discord.webhookUrl : url, events: { ...cur.discord.events, ...u.discord?.events } },
      autoRestart: { ...cur.autoRestart, ...u.autoRestart },
      scheduledRestart: { ...cur.scheduledRestart, ...u.scheduledRestart },
    });
    await setAutomation(id, next);
    return automationView(id);
  });

  app.post("/api/servers/:id/automation/discord/test", async (req) => {
    const { id } = req.params as { id: string };
    await loadContext(id);
    const a = await getAutomation(id);
    if (!a.discord.webhookUrl) throw badRequest("먼저 디스코드 웹훅 주소를 저장해 주세요.");
    const err = await sendTestMessage(id, a.discord.webhookUrl);
    if (err) throw new HttpError(502, "discord_failed", err);
    return { ok: true };
  });
}
