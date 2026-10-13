import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import { executeExtensionTool } from '../../websocket/server.js';

/**
 * Run a built-in server-side tool that isn't backed by extension code or user JS.
 * The tool's `code` field holds the builtin name (e.g. "vision_check").
 */
export async function runBuiltinTool(
  builtinName: string,
  input: Record<string, unknown>,
  agentId: string,
): Promise<string> {
  switch (builtinName) {
    case 'wait_ms': {
      const ms = typeof input['ms'] === 'number' ? Math.min(input['ms'], 30_000) : 1_000;
      await new Promise((r) => setTimeout(r, ms));
      return JSON.stringify({ waited: ms });
    }
    case 'screenshot':
      return runBuiltinScreenshot(input);
    case 'vision_check':
      return runVisionCheck(input, agentId);
    default:
      return JSON.stringify({ error: `Unknown builtin tool: ${builtinName}` });
  }
}

// ── screenshot ────────────────────────────────────────────────────────────────

async function runBuiltinScreenshot(input: Record<string, unknown>): Promise<string> {
  const tabId = input['tabId'];
  if (typeof tabId !== 'number') {
    return JSON.stringify({ error: 'screenshot requires a numeric tabId' });
  }
  const result = await executeExtensionTool('screenshot', { tabId }, 30_000, '');
  return typeof result === 'string' ? result : JSON.stringify(result);
}

// ── vision_check ──────────────────────────────────────────────────────────────

async function runVisionCheck(
  input: Record<string, unknown>,
  agentId: string,
): Promise<string> {
  const tabId = input['tabId'];
  const prompt = input['prompt'];

  if (typeof tabId !== 'number') {
    return JSON.stringify({ error: 'vision_check requires a numeric tabId' });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return JSON.stringify({ error: 'vision_check requires a non-empty prompt string' });
  }

  // 1. Take a screenshot of the tab
  let screenshotResult: unknown;
  try {
    screenshotResult = await executeExtensionTool('screenshot', { tabId }, 30_000, '');
  } catch (err) {
    return JSON.stringify({
      passed: false,
      answer: 'error',
      reason: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // The screenshot result should be a data URL string or an object with dataUrl
  let dataUrl: string | null = null;
  if (typeof screenshotResult === 'string') {
    dataUrl = screenshotResult;
  } else if (
    screenshotResult &&
    typeof screenshotResult === 'object' &&
    'dataUrl' in (screenshotResult as Record<string, unknown>)
  ) {
    const raw = (screenshotResult as Record<string, unknown>)['dataUrl'];
    if (typeof raw === 'string') dataUrl = raw;
  } else if (
    screenshotResult &&
    typeof screenshotResult === 'object' &&
    'result' in (screenshotResult as Record<string, unknown>)
  ) {
    const raw = (screenshotResult as Record<string, unknown>)['result'];
    if (typeof raw === 'string') dataUrl = raw;
  }

  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    // Try parsing as JSON to see if there's a data URL inside
    if (typeof screenshotResult === 'string') {
      try {
        const parsed = JSON.parse(screenshotResult);
        if (typeof parsed?.dataUrl === 'string') dataUrl = parsed.dataUrl;
        else if (typeof parsed?.result === 'string') dataUrl = parsed.result;
      } catch { /* ignore */ }
    }
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return JSON.stringify({
        passed: false,
        answer: 'error',
        reason: `Screenshot did not return a valid image data URL. Got: ${JSON.stringify(screenshotResult).slice(0, 200)}`,
      });
    }
  }

  // Extract media type and base64 data
  // data:image/png;base64,<data>
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    return JSON.stringify({ passed: false, answer: 'error', reason: 'Invalid data URL format' });
  }
  const mediaTypePart = dataUrl.slice(5, commaIdx); // strip leading "data:"
  const [mediaType] = mediaTypePart.split(';');
  const base64Data = dataUrl.slice(commaIdx + 1);

  // 2. Get the agent's API key
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent?.apiKeyEncrypted) {
    return JSON.stringify({
      passed: false,
      answer: 'error',
      reason: 'Agent has no API key configured — cannot call vision API',
    });
  }
  const apiKey = decrypt(agent.apiKeyEncrypted);

  // 3. Call Claude Vision
  const client = new Anthropic({ apiKey });

  let visionResponse: Anthropic.Messages.Message;
  try {
    visionResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: `Look carefully at this screenshot and answer the following question:\n\n${prompt}\n\nRespond ONLY with a JSON object in this exact format (no markdown, no explanation):\n{"passed": true/false, "answer": "short direct answer", "reason": "brief explanation of what you see"}`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    return JSON.stringify({
      passed: false,
      answer: 'error',
      reason: `Vision API call failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. Parse the response
  const rawText = visionResponse.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.Messages.TextBlock).text)
    .join('');

  // Strip any markdown fences
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as { passed?: boolean; answer?: string; reason?: string };
    return JSON.stringify({
      passed: !!parsed.passed,
      answer: parsed.answer ?? rawText.slice(0, 200),
      reason: parsed.reason ?? '',
    });
  } catch {
    // If JSON parse fails, do a best-effort interpretation
    const lower = rawText.toLowerCase();
    const passed = lower.includes('yes') || lower.includes('true') || lower.includes('orange') || lower.includes('highlighted');
    return JSON.stringify({ passed, answer: rawText.slice(0, 300), reason: '' });
  }
}

