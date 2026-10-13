import type { ContentMessage } from '../protocol.js';
import { PRIMITIVES } from '../primitives/index.js';

// Content script: listens for EXECUTE_PRIMITIVE from background, runs tool code

chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return false;
  }

  if (msg.type === 'EXECUTE_PRIMITIVE') {
    const { correlationId, toolName, input, code } = msg;

    (async () => {
      try {
        let result: unknown;

        // If there's custom code, run it via execute_code primitive
        if (code) {
          const fn = new Function('input', 'primitives', `"use strict"; return (async () => { ${code} })()`);
          result = await fn(input, PRIMITIVES);
        } else if (toolName in PRIMITIVES) {
          result = await PRIMITIVES[toolName]!(input);
        } else {
          result = { error: `Unknown primitive: ${toolName}` };
        }

        sendResponse({ type: 'PRIMITIVE_RESULT', correlationId, result } satisfies ContentMessage);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        sendResponse({ type: 'PRIMITIVE_RESULT', correlationId, result: null, error } satisfies ContentMessage);
      }
    })();

    return true; // async response
  }

  return false;
});

console.log('[AgentSpawner] Content script loaded');
