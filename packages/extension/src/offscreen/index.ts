import type { BackendToExtension, ExtensionToBackend, OffscreenMessage } from '../protocol.js';

const WS_URL = 'ws://localhost:3001/ws';
const PING_INTERVAL = 20_000;
const RECONNECT_DELAY = 3_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// ── Sandbox postMessage bridge ────────────────────────────────────────────────

let sandboxWindow: MessageEventSource | null = null;

// Pending RESULT callbacks: correlationId → {resolve, reject}
const pendingResults = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

// Pending TAB_REQUEST callbacks: id → sendResponse fn
let tabOpNextId = 0;
const pendingTabOps = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; [key: string]: unknown } | null;
  if (!msg || !msg.type) return;

  if (msg.type === 'SANDBOX_READY') {
    // Capture the sandbox window via event.source (iframe.contentWindow is null for sandboxed iframes)
    sandboxWindow = event.source;
    console.log('[Offscreen] Sandbox ready');
    return;
  }

  if (msg.type === 'RESULT') {
    const correlationId = msg['correlationId'] as string;
    const cb = pendingResults.get(correlationId);
    if (!cb) return;
    pendingResults.delete(correlationId);
    if (msg['error']) {
      cb.reject(new Error(msg['error'] as string));
    } else {
      cb.resolve(msg['result']);
    }
    return;
  }

  if (msg.type === 'TAB_REQUEST') {
    const id = msg['id'] as number;
    const method = msg['method'] as string;
    const payload = msg['payload'] as Record<string, unknown>;

    // Proxy to background via chrome.runtime.sendMessage
    chrome.runtime.sendMessage(
      { type: 'TAB_OP', method, payload },
      (response: { result?: unknown; error?: string } | undefined) => {
        if (!sandboxWindow) return;
        if (chrome.runtime.lastError) {
          (sandboxWindow as Window).postMessage({ type: 'TAB_RESPONSE', id, error: chrome.runtime.lastError.message }, '*');
          return;
        }
        if (response?.error) {
          (sandboxWindow as Window).postMessage({ type: 'TAB_RESPONSE', id, error: response.error }, '*');
        } else {
          (sandboxWindow as Window).postMessage({ type: 'TAB_RESPONSE', id, result: response?.result ?? null }, '*');
        }
      },
    );
    return;
  }
});

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(
  correlationId: string,
  toolName: string,
  input: Record<string, unknown>,
  code: string,
): Promise<void> {
  // code is now passed inline from the backend in the EXECUTE_TOOL message —
  // no HTTP fetch needed, and no cross-agent code contamination possible.

  if (!code.trim()) {
    // Extension primitive — no inline code, dispatch to content script via background
    try {
      const response = await new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'PRIMITIVE_OP', toolName, input },
          (resp: { result?: unknown; error?: string } | undefined) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp ?? { error: 'No response from background' });
            }
          },
        );
      });
      if (response.error) {
        send({ type: 'TOOL_RESULT', correlationId, result: null, error: response.error });
      } else {
        const resultStr = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
        send({ type: 'TOOL_RESULT', correlationId, result: resultStr });
      }
    } catch (err) {
      send({ type: 'TOOL_RESULT', correlationId, result: null, error: `Primitive dispatch failed: ${(err as Error).message}` });
    }
    return;
  }

  if (!sandboxWindow) {
    send({ type: 'TOOL_RESULT', correlationId, result: null, error: 'Sandbox not ready' });
    return;
  }

  // Send code to sandbox for execution (new Function is allowed in sandbox pages)
  const result = await new Promise<unknown>((resolve, reject) => {
    pendingResults.set(correlationId, { resolve, reject });
    (sandboxWindow as Window).postMessage({ type: 'EXECUTE', correlationId, code, input }, '*');

    // Timeout after 30s
    setTimeout(() => {
      if (pendingResults.has(correlationId)) {
        pendingResults.delete(correlationId);
        reject(new Error(`Tool "${toolName}" timed out after 30s`));
      }
    }, 30_000);
  });

  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  send({ type: 'TOOL_RESULT', correlationId, result: resultStr });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[Offscreen] WS connected');
    send({ type: 'HELLO', extensionId: chrome.runtime.id });
    chrome.runtime.sendMessage({ type: 'WS_CONNECTED' } satisfies OffscreenMessage);

    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) send({ type: 'PING' });
    }, PING_INTERVAL);
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    let msg: BackendToExtension;
    try {
      msg = JSON.parse(event.data) as BackendToExtension;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'HELLO_ACK':
        console.log('[Offscreen] Backend ack received');
        break;
      case 'PONG':
        break;
      case 'EXECUTE_TOOL':
        executeTool(msg.correlationId, msg.toolName, msg.input, msg.code ?? '').catch((err: Error) => {
          send({ type: 'TOOL_RESULT', correlationId: msg.correlationId, result: null, error: err.message });
        });
        break;
      case 'START_RECORDING':
        chrome.runtime.sendMessage({ type: 'START_RECORDING', url: (msg as { type: string; url: string }).url });
        break;
    }
  };

  ws.onclose = () => {
    console.log('[Offscreen] WS disconnected, reconnecting...');
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    chrome.runtime.sendMessage({ type: 'WS_DISCONNECTED' } satisfies OffscreenMessage);
    setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = () => ws?.close();
}

function send(msg: ExtensionToBackend) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

connect();
console.log('[Offscreen] Offscreen document initialized');
