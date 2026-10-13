// web_search is handled natively by Anthropic API as a built-in tool.
// This file exports the tool definition to include in the API call.

import type Anthropic from '@anthropic-ai/sdk';

export function getWebSearchToolDef(): Anthropic.Messages.Tool {
  // The native web search tool only accepts `type` and `name` — no description or input_schema.
  // Cast through unknown to sidestep the SDK's incomplete type for server-side tools.
  return {
    type: 'web_search_20250305',
    name: 'web_search',
  } as unknown as Anthropic.Messages.Tool;
}
