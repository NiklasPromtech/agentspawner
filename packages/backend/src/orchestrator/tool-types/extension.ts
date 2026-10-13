import { executeExtensionTool } from '../../websocket/server.js';

export async function runExtensionTool(
  toolName: string,
  input: Record<string, unknown>,
  code = '',
): Promise<string> {
  // If the tool declares its own timeoutMs, give the WS layer that + 5s buffer
  const wsTimeout = typeof input['timeoutMs'] === 'number'
    ? (input['timeoutMs'] as number) + 5_000
    : 30_000;
  const result = await executeExtensionTool(toolName, input, wsTimeout, code);
  return typeof result === 'string' ? result : JSON.stringify(result);
}
