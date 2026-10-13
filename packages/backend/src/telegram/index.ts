import { getDb } from '../db/index.js';
import { agents, runs } from '../db/schema.js';
import { decrypt } from '../crypto/index.js';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../orchestrator/index.js';
import { runAutonomousOrchestrator } from '../orchestrator/autonomous.js';
import { abortRun } from '../orchestrator/abort-registry.js';
import { logger } from '../lib/logger.js';

// ── Outbound ──────────────────────────────────────────────────────────────────

export async function sendTelegramMessage(
  text: string,
  token: string,
  chatId: string,
): Promise<void> {
  if (!token || !chatId || !text.trim()) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'Telegram: sendMessage failed');
    }
  } catch (err) {
    logger.error({ err }, 'Telegram: failed to send message');
  }
}

// ── Active autonomous sessions (agentId → runId) ──────────────────────────────
const activeAutoSessions = new Map<string, string>();

// ── Inbound handler ───────────────────────────────────────────────────────────

async function handleTelegramMessage(
  agentId: string,
  token: string,
  chatId: string,
  userText: string,
): Promise<void> {
  const db = getDb();
  const trimmed = userText.trim();

  // ── /start_auto [budget] — kick off an autonomous session ──────────────────
  if (trimmed.startsWith('/start_auto')) {
    // Parse optional budget: /start_auto 1.5  → $1.50/hr
    const budgetMatch = trimmed.match(/\/start_auto\s+([0-9.]+)/);
    const budgetUsdPerHour = budgetMatch ? parseFloat(budgetMatch[1]!) : 0;

    if (activeAutoSessions.has(agentId)) {
      await sendTelegramMessage(
        `⚠️ An autonomous session is already running (run \`${activeAutoSessions.get(agentId)}\`). Send /stop_auto to stop it first.`,
        token,
        chatId,
      );
      return;
    }

    const runId = uuidv4();
    activeAutoSessions.set(agentId, runId);

    const budgetText = budgetUsdPerHour > 0 ? ` (budget: $${budgetUsdPerHour}/hr)` : ' (no budget limit)';
    await sendTelegramMessage(
      `🤖 Starting autonomous session${budgetText}...\nRun ID: \`${runId}\`\n\nSend /stop_auto to stop it.`,
      token,
      chatId,
    );

    await db.insert(runs).values({
      id: runId,
      agentId,
      status: 'pending',
      trigger: 'telegram',
      input: `__wake_up__${budgetUsdPerHour > 0 ? `:$${budgetUsdPerHour}/hr` : ''}`,
    });

    // Run async — Telegram mirroring is handled by orchestrator
    runAutonomousOrchestrator(runId, agentId, undefined, budgetUsdPerHour)
      .catch((err: unknown) => {
        logger.error({ err, agentId }, 'Telegram: autonomous session error');
        sendTelegramMessage(`❌ Autonomous session ended with error: ${String(err)}`, token, chatId).catch(() => {});
      })
      .finally(() => {
        activeAutoSessions.delete(agentId);
      });

    return;
  }

  // ── /stop_auto — stop the running autonomous session ──────────────────────
  if (trimmed === '/stop_auto') {
    const runId = activeAutoSessions.get(agentId);
    if (!runId) {
      await sendTelegramMessage('ℹ️ No autonomous session is currently running.', token, chatId);
      return;
    }

    // Abort the run via the same mechanism as the UI stop button
    abortRun(runId);
    activeAutoSessions.delete(agentId);
    await sendTelegramMessage(`⏹ Autonomous session \`${runId}\` has been signalled to stop.`, token, chatId);
    return;
  }

  // ── /help — show available commands ───────────────────────────────────────
  if (trimmed === '/help') {
    await sendTelegramMessage(
      `*Available commands:*\n\n` +
      `/help — show this message\n` +
      `/start_auto — start autonomous session (no budget limit)\n` +
      `/start_auto 1.5 — start autonomous session with $1.50/hr budget\n` +
      `/stop_auto — stop the running autonomous session\n\n` +
      `Or just send any message to chat with the agent.`,
      token,
      chatId,
    );
    return;
  }

  // ── Regular chat message ──────────────────────────────────────────────────
  const runId = uuidv4();

  await db.insert(runs).values({
    id: runId,
    agentId,
    status: 'pending',
    trigger: 'telegram',
    input: userText,
  });

  // The orchestrator mirrors assistant text to Telegram automatically,
  // so we just need to run it — no need to collect and re-send here.
  await runOrchestrator(runId, agentId, userText);
}

// ── Polling loop ──────────────────────────────────────────────────────────────

const activePollers = new Map<string, { stop: () => void }>();

export function startTelegramPolling(agentId: string, token: string, chatId: string): void {
  stopTelegramPolling(agentId); // clean up any existing poller

  let running = true;

  (async () => {
    let offset = 0;
    logger.info({ agentId, chatId: chatId || null }, 'Telegram: starting polling');

    while (running) {
      try {
        const url =
          `https://api.telegram.org/bot${token}/getUpdates` +
          `?offset=${offset}&timeout=25&allowed_updates=%5B%22message%22%5D`;

        const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.error({ status: res.status, body, agentId }, 'Telegram: getUpdates failed');
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }

        const data = await res.json() as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: { chat: { id: number | string }; text?: string };
          }>;
        };

        if (!data.ok) {
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }

        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          const incomingChatId = String(msg.chat.id);

          // If no chat ID is configured yet, or the user sends /start,
          // reply with their chat ID so they can paste it into settings.
          if (!chatId || msg.text.trim() === '/start') {
            await sendTelegramMessage(
              `Your Chat ID is: \`${incomingChatId}\`\n\nPaste this into the *Telegram Chat ID* field in your agent settings to activate the bot.`,
              token,
              incomingChatId,
            );
            continue;
          }

          if (incomingChatId !== String(chatId)) continue;

          logger.info({ agentId, text: msg.text }, 'Telegram: message received');
          handleTelegramMessage(agentId, token, chatId, msg.text).catch((err: unknown) => {
            logger.error({ err, agentId }, 'Telegram: message handler error');
          });
        }
      } catch {
        if (!running) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }

    logger.info({ agentId }, 'Telegram: polling stopped');
  })().catch((err: unknown) => logger.error({ err, agentId }, 'Telegram: polling loop crashed'));

  activePollers.set(agentId, { stop: () => { running = false; } });
}

export function stopTelegramPolling(agentId: string): void {
  const p = activePollers.get(agentId);
  if (p) {
    p.stop();
    activePollers.delete(agentId);
  }
}

// ── Startup loader ────────────────────────────────────────────────────────────

export async function reloadTelegramPollers(): Promise<void> {
  // Stop all running pollers first
  for (const [agentId] of activePollers) stopTelegramPolling(agentId);

  const db = getDb();
  const allAgents = await db.select().from(agents);

  let started = 0;
  for (const agent of allAgents) {
    if (agent.telegramKeyEncrypted) {
      const token = decrypt(agent.telegramKeyEncrypted);
      if (token) {
        startTelegramPolling(agent.id, token, agent.telegramChatId ?? '');
        started++;
      }
    }
  }
  logger.info({ count: started }, 'Telegram: started pollers');
}
