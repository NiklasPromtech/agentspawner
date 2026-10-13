/**
 * Chat Orchestrator — Re-export shim
 *
 * The real implementation has moved to agents/chat-agent.ts.
 * This file re-exports everything for backward compatibility.
 * TODO: remove shim — update all importers to use agents/chat-agent.js directly.
 */

export type { OrchestratorEvent } from '../agents/ui/chat-agent.js';
export { stopRun } from '../agents/ui/chat-agent.js';
export { runChatAgent as runOrchestrator } from '../agents/ui/chat-agent.js';
