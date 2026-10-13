/**
 * Setup Agent
 *
 * All agent logic for the /setup/* and /agents/:agentId/setup/* endpoints.
 * Each function is a pure agent: it takes clean parameters and returns clean data.
 * The route file (routes/setup.ts) handles HTTP concerns — body parsing, DB lookups,
 * auth, and serialising results into responses.
 *
 * Functions:
 *   runSetupAgent           — generate system prompt + recommended flows/DBs/schedules
 *   parseAndSyncProfileBlob — extract structured profileBlob from an existing system prompt
 *   runConverseAgent        — conversational onboarding (pre-agent-creation chat)
 *   runPlanFlowsAgent       — propose atomic flow set for an agent
 *   runAmendAgent           — iterative chat-based system prompt editing
 *   runRetrospectiveAgent   — adjust agent scope after a flow turns out to be infeasible
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getWebSearchToolDef } from '../../orchestrator/tool-types/web-search.js';
import { getConstraintsForPlatform, buildConstraintBlock } from '../../data/platform-constraints.js';

// ── Generate ──────────────────────────────────────────────────────────────────

const GENERATE_SYSTEM_PROMPT = `You are an AI agent configuration assistant for AgentSpawner, a browser automation platform.

SYSTEM PROMPT RULES:
- Write in second person ("You are a...")
- Specific: mention the site/platform, company context, and work style
- Behavioral guidelines: tone, when to stop, how to prioritize
- 150-300 words. No placeholder text or template variables.

FLOW RECOMMENDATION RULES (CRITICAL):
- Atomic only: open one tab, do one thing, return result, close tab
- FORBIDDEN: sequences, campaigns, multi-day workflows, follow-up loops
- GOOD: check_dms, reply_to_dm, send_dm, search_leads, scrape_profile_bio, check_notifications
- BAD: outreach_sequence, 3_day_follow_up, weekly_campaign
- 3-5 flows max. Skip tools the agent already has installed.
- snake_case names.
- SMART CONTENT FLOWS (MANDATORY): Any flow that posts, comments, replies, or sends text content
  to an external platform MUST be described as a "smart content flow". Include the phrase
  "Smart content flow" at the start of the description — e.g. "Smart content flow: posts a comment
  to a Reddit thread using the __hydrate__ + __generate__ pipeline". This signals to the flow
  builder that the hydration pipeline is mandatory and raw text inputs are forbidden.

DATABASE RECOMMENDATION RULES:
- Only recommend tables the agent will actually read/write during its work
- GOOD: leads, sent_messages, scraped_profiles, dm_history, seen_notifications
- BAD: analytics, reports, user_preferences (agent doesn't need these)
- 1-3 tables max.
- Columns: only what's needed. Types must be "text", "number", or "boolean" only.
- snake_case table and column names.

SCHEDULE RECOMMENDATION RULES:
- One schedule per recommended flow that makes sense to run on a timer
- Use standard 5-field cron syntax (minute hour day month weekday)
- Match cadence to task urgency: DM checks every 15-30 min, lead scraping 1-2x/day, notifications hourly
- "label": short human-readable string like "Every 15 min" or "Twice daily at 9am & 5pm"
- "input": the message the agent receives when the schedule fires — be specific, e.g. "Check for new DMs and reply to any that need a response"
- "flowName": must match a name from recommendedFlows exactly
- Only recommend schedules for flows you also recommended.

PROFILE BLOB RULES:
- "jobDescription": 2-4 sentence summary of the agent's role
- "competitors": array of {name, url?, notes} — companies/products the agent should be aware of
- "tone": array of bullet strings describing communication style (e.g. "Direct and confident", "Never use corporate jargon")
- "allowed": array of strings — things the agent is explicitly permitted to do (e.g. "Comment on public posts", "Send DMs to users who follow first")
- "restricted": array of strings — things the agent must never do (e.g. "Mass follow/unfollow", "Send unsolicited cold DMs")
- "focus": one sentence describing the primary objective
- "mindset": one sentence describing the operating philosophy / personality framing

RESPONSE FORMAT — valid JSON only, no markdown fences:
{
  "systemPrompt": "...",
  "profileBlob": {
    "jobDescription": "...",
    "competitors": [{"name": "...", "url": "...", "notes": "..."}],
    "tone": ["...", "..."],
    "allowed": ["...", "..."],
    "restricted": ["...", "..."],
    "focus": "...",
    "mindset": "..."
  },
  "recommendedFlows": [{"name": "...", "description": "..."}],
  "recommendedDatabases": [{"name": "...", "description": "...", "columns": [{"name": "...", "type": "text|number|boolean"}]}],
  "recommendedSchedules": [{"flowName": "...", "cron": "...", "label": "...", "input": "..."}]
}`;

export interface SetupAgentParams {
  apiKey: string;
  agentModel?: string;
  roleTitle: string;
  companyContext: string;
  jobDescription: string;
  installedToolNames: string;
}

export interface ProfileBlob {
  jobDescription: string;
  competitors: { name: string; url?: string; notes: string }[];
  tone: string[];
  allowed: string[];
  restricted: string[];
  focus: string;
  mindset: string;
}

export interface SetupAgentResult {
  systemPrompt: string;
  profileBlob: ProfileBlob;
  recommendedFlows: { name: string; description: string }[];
  recommendedDatabases: { name: string; description: string; columns: { name: string; type: string }[] }[];
  recommendedSchedules: { flowName: string; cron: string; label: string; input: string }[];
}

/**
 * Generate a system prompt and recommended flows/databases/schedules for a new agent.
 */
export async function runSetupAgent(params: SetupAgentParams): Promise<SetupAgentResult> {
  const { apiKey, agentModel = 'claude-sonnet-4-6', roleTitle, companyContext, jobDescription, installedToolNames } = params;

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: agentModel,
    max_tokens: 2048,
    system: GENERATE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Role title: ${roleTitle}
Company context: ${companyContext || '(not provided)'}
Job description: ${jobDescription}
Already installed tools: ${installedToolNames}

Generate a system prompt and recommend atomic flows for this agent.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    systemPrompt?: string;
    profileBlob?: ProfileBlob;
    recommendedFlows?: { name: string; description: string }[];
    recommendedDatabases?: { name: string; description: string; columns: { name: string; type: string }[] }[];
    recommendedSchedules?: { flowName: string; cron: string; label: string; input: string }[];
  };

  const defaultProfileBlob: ProfileBlob = {
    jobDescription: '',
    competitors: [],
    tone: [],
    allowed: [],
    restricted: [],
    focus: '',
    mindset: '',
  };

  return {
    systemPrompt: parsed.systemPrompt ?? '',
    profileBlob: parsed.profileBlob ?? defaultProfileBlob,
    recommendedFlows: parsed.recommendedFlows ?? [],
    recommendedDatabases: parsed.recommendedDatabases ?? [],
    recommendedSchedules: parsed.recommendedSchedules ?? [],
  };
}

// ── Parse & sync profile blob ─────────────────────────────────────────────────

/**
 * Extract a structured profileBlob from an existing system prompt and persist it
 * to the agents table. Safe to call fire-and-forget.
 */
export async function parseAndSyncProfileBlob(
  agentId: string,
  systemPrompt: string,
  apiKey: string,
): Promise<void> {
  const db = getDb();
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Extract a structured profile from the following agent system prompt.

Return ONLY a valid JSON object matching this exact shape — no markdown, no commentary:
{
  "jobDescription": "1-3 sentence summary of what this agent does and its primary goal",
  "focus": "paragraph describing what the agent focuses on, what makes a good opportunity, where it spends time",
  "mindset": "1-2 sentences on the agent's attitude, personality, and approach",
  "tone": ["bullet describing a tone rule", "another tone rule", ...],
  "allowed": ["thing it is allowed to do", ...],
  "restricted": ["thing it must not do", ...],
  "competitors": []
}

Rules:
- tone: extract each distinct style/voice guideline as a short bullet (4–10 items)
- allowed: extract explicit allowed channels or actions
- restricted: extract explicit restrictions and prohibitions
- Keep each item concise (one sentence max)
- If a section has no clear content in the prompt, use an empty array or empty string

System prompt:
"""
${systemPrompt}
"""`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  let profileBlob: unknown;
  try {
    profileBlob = JSON.parse(jsonMatch[0]);
  } catch {
    return;
  }

  await db.update(agents)
    .set({
      profileBlob: JSON.stringify(profileBlob),
      profileBlobUpdatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, agentId));
}

// ── Conversational onboarding ─────────────────────────────────────────────────

const CONVERSE_SYSTEM_PROMPT = `You are an agent configuration specialist with access to web search.

PHASE 1 — RESEARCH (first user message ONLY):
Before asking any questions, use web_search to research:
1. The company/product/website mentioned (what they do, value prop, pricing)
2. 1-2 main competitors in the same space
3. The target audience / ideal customer profile
4. A similar job title or role description (e.g. "outreach specialist for [product type]")

After research, synthesize what you learned internally. Do NOT dump raw search results to the user.
Immediately proceed to Phase 2 with your first targeted clarifying question.
Keep your response brief — just 1-2 sentences acknowledging what you found + one focused question.

PHASE 2 — CLARIFICATION (3–5 exchanges max):
Ask one focused question at a time to fill gaps the research couldn't answer:
- What tone? (professional, casual, somewhere between)
- Any accounts or user types to explicitly avoid?
- Specific restrictions? (no DMs, no emails, platforms to avoid, etc.)
- Target criteria? (follower count, keywords in bio, industry, geography, etc.)

NEVER ask where data should be stored or delivered. All collected data is stored internally in AgentSpawner's database — that is the platform's core value proposition. Do not offer Google Sheets, Notion, Airtable, or any other external storage as options; it implies the platform has no persistence of its own.

Be conversational and warm. If the user's first message already covers most points, skip ahead.

PHASE 3 — CONFIG GENERATION:
When you have enough info (usually after 2-4 exchanges), generate the config.
Signal completion by ending your message with a JSON block inside <config> tags:

<config>
{
  "name": "short descriptive name (2-4 words, e.g. 'X Outreach Agent')",
  "systemPrompt": "full system prompt here",
  "goals": [
    { "type": "objective", "title": "...", "description": "...", "priority": 1 },
    { "type": "objective", "title": "...", "description": "...", "priority": 2 }
  ]
}
</config>

SYSTEM PROMPT WRITING RULES:
- Start with: "You are a [role] that [primary task]."
- Include ALLOWED CHANNELS section: explicit list of platforms/methods the agent CAN use
- Include RESTRICTIONS section: explicit list of what it must NEVER do
  - Cover channels NOT mentioned by user (if email wasn't mentioned, add "Do NOT send emails")
  - Cover DMs/direct messages unless user explicitly said DMs are allowed
  - Be specific: "Do NOT send direct messages on any platform" not just "no DMs"
- Do NOT include any "APPROVAL RULES" section or any instruction telling the agent to queue drafts, flag things for review, or hold back from acting. Human review is enforced mechanically by the action flows themselves (they contain a built-in pause step). If the system prompt also instructs the agent to handle review, the cheap autonomous model gets confused and writes drafts as plain chat messages instead of triggering the flow. The system prompt should only say: "Action flows (posting, commenting, replying) include an automatic human review step — do not attempt to post anything by other means."
- Include FOCUS section: what makes a good target/lead/opportunity
- 200-400 words. Concrete and specific. No vague language. Use insights from your research.

GOALS RULES:
- 2-4 goals maximum
- Only operational goals — what the agent pursues every time it runs
- Do NOT include setup tasks like "build flows" or "configure tools" — the wizard handles that automatically
- Use objectives (broad ongoing goals) for things the agent works toward indefinitely
- Priority 1 = most important`;

export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConverseResult {
  done: boolean;
  reply: string;
  config?: {
    name: string;
    systemPrompt: string;
    goals?: { type: string; title: string; description: string; priority: number }[];
  };
}

/**
 * Run one turn of the conversational onboarding agent.
 * Returns { done: true, config } when the agent has gathered enough info and generated a config.
 */
export async function runConverseAgent(params: {
  apiKey: string;
  messages: ConverseMessage[];
}): Promise<ConverseResult> {
  const { apiKey, messages } = params;
  const anthropic = new Anthropic({ apiKey });

  // Phase 1 research: include web_search tool only on the first user message
  const isFirstMessage = messages.length === 1;
  const tools = isFirstMessage ? [getWebSearchToolDef()] : undefined;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: CONVERSE_SYSTEM_PROMPT,
    messages,
    ...(tools ? { tools } : {}),
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const configMatch = text.match(/<config>([\s\S]*?)<\/config>/);
  if (configMatch) {
    try {
      const config = JSON.parse(configMatch[1].trim()) as {
        name: string;
        systemPrompt: string;
        goals?: { type: string; title: string; description: string; priority: number }[];
      };
      const reply = text.replace(/<config>[\s\S]*?<\/config>/, '').trim();
      return { done: true, reply, config };
    } catch (parseErr) {
      const hint = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return {
        done: false,
        reply: text.replace(/<config>[\s\S]*?<\/config>/, '').trim()
          + `\n\n_(Config parse error — please try again: ${hint})_`,
      };
    }
  }

  return { done: false, reply: text };
}

// ── Plan flows ────────────────────────────────────────────────────────────────

const PLAN_FLOWS_SYSTEM_PROMPT = `You are a flow architect for AgentSpawner, a browser-automation platform.
Given an agent's system prompt and description, design the minimal set of atomic flows it needs.

FLOW RULES (CRITICAL):
- Each flow does exactly ONE thing: open one URL/page, perform one action or read, return result
- ATOMIC only — no sequences, no campaigns, no multi-step workflows
- Mix scrape (read-only, safe to repeat) and action (has side effects, needs dedup guard)
- 3-6 flows total. Quality over quantity.
- snake_case names
- Descriptions MUST describe a single-target operation using parameterized inputs — never list multiple specific targets (e.g. NOT "searches 7 subreddits", but "searches one subreddit given a {{subreddit}} input")
- The agent calling a flow handles repetition externally; flows only handle one call at a time

SCRAPE flows (read-only, safe to repeat any time):
- Examples: check_dms, search_leads, scrape_profile_bio, check_notifications, search_posts, get_dm_thread

ACTION flows (real-world side effects — need dedup guard pattern):
- Examples: send_dm, reply_to_dm, follow_user, like_post, comment_on_post, unfollow_user

SMART CONTENT FLOWS (MANDATORY):
Any action flow that writes text content to an external platform (post comment, reply to comment,
send DM, publish post) MUST be described as a "Smart content flow". Start the description with
"Smart content flow:" — e.g. "Smart content flow: posts a comment to {{post_url}} after hydrating
context and generating text with Sonnet". This signals to the flow builder that raw text inputs
are forbidden and the __hydrate__ + __generate__ pipeline must be used.
WRONG: "Posts a comment with {{comment_body}} to a Reddit post"
RIGHT: "Smart content flow: posts a comment to {{post_url}} using the hydration pipeline"

RESPONSE FORMAT (JSON only, no markdown fences):
{
  "flows": [
    {
      "name": "snake_case_name",
      "type": "scrape" | "action",
      "description": "One sentence: what it does and what data it returns/sends",
      "purpose": "One sentence: why this agent specifically needs it"
    }
  ]
}`;

export interface PlanFlowsResult {
  flows: { name: string; type: 'scrape' | 'action'; description: string; purpose: string }[];
  platformConstraints: { platform: string; area: string; severity: string; reason: string }[];
}

/**
 * Propose an atomic flow set for an agent based on its system prompt and description.
 */
export async function runPlanFlowsAgent(params: {
  apiKey: string;
  systemPrompt: string;
  description?: string;
  briefFlows?: { name: string; type: 'scrape' | 'action'; description: string; purpose: string }[];
  feedback?: string;
}): Promise<PlanFlowsResult> {
  const { apiKey, systemPrompt, description = '', briefFlows, feedback } = params;
  const anthropic = new Anthropic({ apiKey });

  const detectedConstraints = getConstraintsForPlatform(systemPrompt, description);
  const constraintBlock = buildConstraintBlock(detectedConstraints);
  const planSystemPrompt = constraintBlock
    ? `${PLAN_FLOWS_SYSTEM_PROMPT}\n\n${constraintBlock}`
    : PLAN_FLOWS_SYSTEM_PROMPT;

  const isRefine = briefFlows && briefFlows.length > 0 && feedback?.trim();
  const userContent = isRefine
    ? `Agent system prompt:\n${systemPrompt}\n\nAgent description/context: ${description || '(not provided)'}\n\nCurrent proposed flows:\n${JSON.stringify(briefFlows, null, 2)}\n\nUser feedback on these flows:\n${feedback}\n\nPlease revise the flow set based on this feedback. Return the full updated list — not just the changed flows.`
    : `Agent system prompt:\n${systemPrompt}\n\nAgent description/context: ${description || '(not provided)'}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: planSystemPrompt,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    flows?: { name: string; type: 'scrape' | 'action'; description: string; purpose: string }[];
  };

  return {
    flows: parsed.flows ?? [],
    platformConstraints: detectedConstraints.flatMap(e => e.constraints.map(c => ({
      platform: e.platform,
      area: c.area,
      severity: c.severity,
      reason: c.reason,
    }))),
  };
}

// ── Amend ─────────────────────────────────────────────────────────────────────

const AMEND_SYSTEM_PROMPT = `You are helping a user iteratively amend an AI agent's system prompt.
The CURRENT system prompt will be provided at the start of the conversation.
When the user describes changes they want, propose a complete updated system prompt.

Respond with valid JSON only (no markdown fences):
{"proposedPrompt": "...", "explanation": "..."}

Where:
- "proposedPrompt" is the full updated system prompt (not a diff — the complete text)
- "explanation" is 1-2 sentences describing what you changed and why

Rules for the system prompt:
- Write in second person ("You are a...")
- 150-300 words
- Keep everything that is still relevant from the original
- Only change what the user explicitly asked to change
- No placeholder text or template variables`;

export interface AmendResult {
  proposedPrompt: string;
  explanation: string;
}

/**
 * Run one turn of the iterative system-prompt amendment agent.
 */
export async function runAmendAgent(params: {
  apiKey: string;
  currentPrompt: string;
  messages: ConverseMessage[];
}): Promise<AmendResult> {
  const { apiKey, currentPrompt, messages } = params;
  const anthropic = new Anthropic({ apiKey });

  const messagesWithContext: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: `Here is the CURRENT system prompt to amend:\n\n---\n${currentPrompt}\n---\n\nNow I'll describe the changes I want.`,
    },
    {
      role: 'assistant',
      content: '{"proposedPrompt": "", "explanation": "Understood. Please describe the changes you\'d like and I\'ll propose an updated system prompt."}',
    },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: AMEND_SYSTEM_PROMPT,
    messages: messagesWithContext,
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]) as { proposedPrompt?: string; explanation?: string };
  return {
    proposedPrompt: parsed.proposedPrompt ?? '',
    explanation: parsed.explanation ?? '',
  };
}

// ── Retrospective ─────────────────────────────────────────────────────────────

const RETROSPECTIVE_SYSTEM_PROMPT = `You are helping a user update their AI agent's configuration after a flow turned out to be impossible.

A flow failed or was found to be infeasible (e.g. because of platform limitations like Shadow DOM, rate limits, or unavailable APIs).

Your job is to:
1. Acknowledge what didn't work and why (briefly)
2. Ask what the user wants to focus on instead
3. Propose updates to the system prompt and goals that reflect the new scope
4. When you have enough information, generate an updated config

When generating config, respond with a JSON block inside <retrospective-config> tags:
<retrospective-config>
{
  "systemPrompt": "updated full system prompt",
  "goals": [
    { "type": "objective|task", "title": "...", "description": "...", "priority": 1 }
  ],
  "explanation": "1-2 sentences describing what changed and why"
}
</retrospective-config>

Rules:
- Keep everything that still works — only remove/replace what the failed flow was responsible for
- Be concrete about what the agent CAN do instead
- System prompt: 200-400 words, second person, no placeholder text`;

export interface RetrospectiveResult {
  done: boolean;
  reply: string;
  config?: {
    systemPrompt: string;
    goals?: { type: string; title: string; description: string; priority: number }[];
    explanation?: string;
  };
}

/**
 * Run one turn of the retrospective agent to adjust an agent's scope after a failed flow.
 */
export async function runRetrospectiveAgent(params: {
  apiKey: string;
  failedFlowName: string;
  failedFlowReason: string;
  currentSystemPrompt: string;
  currentGoals: { title: string; type: string; description: string }[];
  messages: ConverseMessage[];
}): Promise<RetrospectiveResult> {
  const { apiKey, failedFlowName, failedFlowReason, currentSystemPrompt, currentGoals, messages } = params;
  const anthropic = new Anthropic({ apiKey });

  const contextMessage = `The "${failedFlowName}" flow was found to be infeasible: ${failedFlowReason}

Current system prompt:
---
${currentSystemPrompt}
---

Current goals: ${currentGoals.map(g => g.title).join(', ') || 'none'}

How should we update this agent's scope given that this capability isn't available?`;

  const messagesWithContext: Anthropic.Messages.MessageParam[] = messages.length === 0
    ? [{ role: 'user', content: contextMessage }]
    : [
        { role: 'user', content: contextMessage },
        { role: 'assistant', content: 'Understood. Let me help you adjust the agent\'s focus.' },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: RETROSPECTIVE_SYSTEM_PROMPT,
    messages: messagesWithContext,
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const configMatch = text.match(/<retrospective-config>([\s\S]*?)<\/retrospective-config>/);
  if (configMatch) {
    try {
      const config = JSON.parse(configMatch[1].trim()) as {
        systemPrompt: string;
        goals?: { type: string; title: string; description: string; priority: number }[];
        explanation?: string;
      };
      const reply = text.replace(/<retrospective-config>[\s\S]*?<\/retrospective-config>/, '').trim();
      return { done: true, reply, config };
    } catch {
      return { done: false, reply: text };
    }
  }

  return { done: false, reply: text };
}
