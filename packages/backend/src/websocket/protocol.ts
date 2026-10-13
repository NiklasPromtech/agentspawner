export type ExtensionToBackend =
  | { type: 'HELLO'; extensionId: string }
  | { type: 'PING' }
  | { type: 'TOOL_RESULT'; correlationId: string; result: unknown; error?: string };

export type BackendToExtension =
  | { type: 'HELLO_ACK'; serverId: string }
  | { type: 'PONG' }
  | { type: 'EXECUTE_TOOL'; correlationId: string; toolName: string; input: Record<string, unknown>; code: string }
  | { type: 'START_RECORDING'; url: string }
  | {
      type: 'OPEN_REVIEW_TAB';
      sourceType: 'action' | 'review';
      actionId?: string;   // required when sourceType === 'action'
      reviewId?: string;   // required when sourceType === 'review'
      agentId: string;
      url: string;
      proposedContent: string;
      actionType: string;
      title: string;
      description: string;
      tabId?: number;      // if present, inject overlay into this existing tab instead of opening a new one
    };

export interface PendingToolCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}
