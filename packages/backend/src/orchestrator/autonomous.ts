/**
 * Autonomous Orchestrator — Re-export shim
 *
 * The real implementation has moved to agents/manager-agent.ts.
 * This file re-exports everything for backward compatibility.
 * TODO: remove shim — update all importers to use agents/manager-agent.js directly.
 */

export { runManagerAgent as runAutonomousOrchestrator } from '../agents/manager-agent.js';
