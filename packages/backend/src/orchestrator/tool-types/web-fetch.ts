// Conservative cap when the result goes directly to the agent's context window.
const FINAL_MAX_CHARS = 50_000;

// Larger cap when the result will be processed by a downstream step before the
// agent sees it. Keeps full fidelity for filtering/transform steps while still
// providing an upper bound against runaway payloads.
const MID_PIPELINE_MAX_CHARS = 500_000;

export async function runWebFetch(
  input: Record<string, unknown>,
  options?: { isMidPipeline?: boolean },
): Promise<string> {
  const url = input['url'];
  if (typeof url !== 'string') {
    throw new Error('web_fetch requires a "url" string parameter');
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'AgentSpawner/1.0' },
  });
  const text = await response.text();
  const maxChars = options?.isMidPipeline ? MID_PIPELINE_MAX_CHARS : FINAL_MAX_CHARS;
  return text.slice(0, maxChars);
}
