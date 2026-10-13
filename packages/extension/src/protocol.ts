// Mirrors backend/src/websocket/protocol.ts

export type ExtensionToBackend =
  | { type: 'HELLO'; extensionId: string }
  | { type: 'PING' }
  | { type: 'TOOL_RESULT'; correlationId: string; result: unknown; error?: string };

export type BackendToExtension =
  | { type: 'HELLO_ACK'; serverId: string }
  | { type: 'PONG' }
  | { type: 'EXECUTE_TOOL'; correlationId: string; toolName: string; input: Record<string, unknown>; code: string }
  | { type: 'START_RECORDING'; url: string };
  // OPEN_REVIEW_TAB removed — overlay architecture replaced by Review Actions tab (OPERATION KEYSTONE)

// Messages between background ↔ offscreen
export type OffscreenMessage =
  | { type: 'WS_CONNECTED' }
  | { type: 'WS_DISCONNECTED' };
  // OPEN_REVIEW_TAB removed — overlay architecture replaced by Review Actions tab (OPERATION KEYSTONE)

// Tab commands: offscreen → background (for Chrome API access)
export type TabCommand =
  | { type: 'TAB_OPEN'; url: string; active?: boolean }
  | { type: 'TAB_CLOSE'; tabId: number }
  | { type: 'TAB_EXEC'; tabId: number; code: string; input: unknown }
  | { type: 'TAB_WAIT_LOAD'; tabId: number }
  | { type: 'TAB_SLEEP'; ms: number }
  | { type: 'TAB_NAVIGATE'; tabId: number; url: string };

export type TabResult = { tabId?: number; result?: unknown; error?: string; success?: boolean };

// Messages between background ↔ content script (kept for direct primitive use)
export type ContentMessage =
  | { type: 'EXECUTE_PRIMITIVE'; correlationId: string; toolName: string; input: Record<string, unknown>; code: string }
  | { type: 'PRIMITIVE_RESULT'; correlationId: string; result: unknown; error?: string }
  | { type: 'PING' }
  | { type: 'PONG' };
  // CONTENT_SCRIPT_READY and INJECT_REVIEW_OVERLAY removed — overlay architecture
  // replaced by Review Actions tab (OPERATION KEYSTONE)
