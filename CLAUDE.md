# AgentSpawner

The user knows the system well. If a request is vague, ask for clarity.

> **THIS FILE IS MANDATORY READING AND MANDATORY MAINTENANCE.**
> Any change to file locations, call paths, agent responsibilities, feature structure, prompt file names, or coding conventions **must** be reflected here before the session ends. This is non-negotiable. An outdated CLAUDE.md is worse than no CLAUDE.md — it actively causes wrong decisions.

---

## The two paths — read this first

Every action routes through one of two paths. Confusing them wastes sessions.

**UI path** — user triggers an action in the frontend:

```
POST /api/setup          → features/agents/setup.routes.ts       → agents/ui/setup-agent.ts
POST /api/flows/generate → features/flows/flows-generate.routes.ts → agents/ui/flow-generator-agent.ts
WS   /chat               → orchestrator/index.ts (shim)          → agents/ui/chat-agent.ts
POST /api/tools/generate → features/tools/generate-tool.routes.ts → agents/ui/tool-forge-agent.ts
```

**Autonomous path** — scheduler or WebSocket command wakes an agent:

```
Scheduler / WS command
  → orchestrator/autonomous.ts (shim)
    → agents/manager-agent.ts              ← continuous loop, Haiku model
      → agents/autonomous/action-flow-agent.ts   ← builds action flows on demand
      → agents/autonomous/scrape-flow-agent.ts   ← builds scrape flows on demand
```

`orchestrator/index.ts` and `orchestrator/autonomous.ts` are **re-export shims only** — real logic lives in `agents/`.

---

## Directory map

```
packages/backend/src/
  agents/
    manager-agent.ts             ← autonomous orchestrator (Haiku)
    manager.prompt.md            ← manager review prompt
    generate-tool.prompt.md      ← tool generation prompt
    autonomous/
      action-flow-agent.ts       ← builds action flows (autonomous path only)
      scrape-flow-agent.ts       ← builds scrape flows (autonomous path only)
      meta.prompt.md             ← injected into every autonomous run
    ui/
      setup-agent.ts             ← agent setup wizard (UI path only)
      flow-generator-agent.ts    ← thin orchestrator: runs explorer then builder (UI path only)
      flow-explorer-agent.ts     ← freehand explorer: calls real tools, returns ExplorationReport
      flow-explorer.prompt.md    ← explorer system prompt
      chat-agent.ts              ← live agent chat (UI path only)
      tool-forge-agent.ts        ← AI tool generation (UI path only)
      flow-generator.prompt.md          ← shared flow builder rules (template)
      flow-generator.action.preamble.md ← action flow rules + MANDATORY hydration
      flow-generator.scrape.preamble.md ← scrape flow rules (no screenshot)

  features/                      ← vertical feature slices
    agents/      routes, service, repository + setup wizard routes
    flows/       routes, service, repository, flow-runner, hydration, validator
    runs/        run history, action log, reviews, flow-run explain, messages
    tools/       tool CRUD, API tools, tool generation
    schedules/   schedule CRUD
    goals/       goal tracking
    contacts/    contact management
    tables/      user-defined data tables
    analytics/   performance analytics
    memory/      memory search
    recording/   browser recording

  orchestrator/
    tool-runner.ts     ← dispatches a single tool call (extension / local / builtin)
    flow-runner.ts     ← RE-EXPORT SHIM only — real code in features/flows/flow-runner.ts
    autonomous.ts      ← RE-EXPORT SHIM only — real code in agents/manager-agent.ts
    index.ts           ← RE-EXPORT SHIM only — real code in agents/ui/chat-agent.ts
    tool-types/        ← extension, local, builtin, web-fetch, web-search dispatchers

  features/flows/
    flow-runner.ts     ← executes flows step by step (1,619 lines — the real engine)
    hydration.ts       ← re-fetches ActionBrief references (__hydrate__ step)

  memory/librarian.ts  ← reads/writes agent memory
  lib/tone.ts          ← injects agent voice into __generate__ calls
  lib/sse-stream.ts    ← SSE helpers
  features/runs/runs.routes.ts ← exports SseEmitter type (imported by all agents)

  features/flow-master/
    flow-master.routes.ts  ← POST /agents/:agentId/flow-master/chat (Haiku, agent's API key)

  routes/health.ts     ← the only remaining flat route (infra endpoint, not a feature)
  db/schema.ts         ← single source of truth for all table definitions
  scheduler/index.ts   ← cron scheduler, imports emitSseEvent from features/runs/
  websocket/server.ts  ← extension WebSocket bridge

packages/extension/src/
  background/index.ts  ← service worker: picker injection, primitive dispatch
  content/index.ts     ← content script: EXECUTE_PRIMITIVE handler
  popup/index.ts       ← popup UI (Picker / Runner / Flows tabs)
  primitives/index.ts  ← all browser primitives incl. get_dom_raw (no cap), get_dom_filtered

packages/frontend/src/
  components/flow-editor/
    FlowMasterPanel.tsx  ← right-side chat panel injected into FlowEditor

play_ground/
  html_output.html     ← HTML cleaning playground (drop HTML, toggle steps, preview output)
  clean.js             ← Node.js CLI equivalent
```

---

## Coding conventions

**Prompts live in `.md` files, never in `.ts` files.** Each agent has a companion `.prompt.md` (or `.preamble.md` for partial sections) next to it. The `.ts` file reads and interpolates at runtime via `readFileSync`. Changing a rule = editing a text file, not opening a 2,000-line TypeScript module.

**Feature slices are the unit of organisation.** Adding a new capability means a new `features/X/` folder with `X.routes.ts` at minimum. Routes at the flat `routes/` level are a sign something hasn't been moved yet.

---

## Flow builder architecture — explorer + builder pattern

The UI flow builder (triggered by `POST /api/flows/generate`) runs in two phases:

**Phase 1 — Explorer** (`flow-explorer-agent.ts`):
- Runs BEFORE the builder whenever `flowType` is specified and no recording is present
- Has access to real browser tools (open_tab, get_text, wait_for_any, etc.)
- Actually opens pages, calls tools, observes results, iterates until it finds a working sequence
- Emits `explorer_*` SSE events shown in the right-panel live log on the frontend
- Calls `finish_exploration` tool to crystallise findings into an `ExplorationReport`
- Tabs are cleaned up automatically on `finish_exploration`

**Phase 2 — Builder** (`flow-generator-agent.ts` main loop):
- Receives the `ExplorationReport` injected into its system prompt
- Builds flow JSON from confirmed observations, not guesswork
- Has access to: test_flow, submit_flow, request_test_inputs, rename_flow (NOT inspect_page — already done)
- Emits standard `thinking`, `tool_call`, `tool_result`, `flow_update`, `complete` events

**When explorer is skipped:**
- Recording-based flows (message contains `\d+\. navigate|click|type` pattern)
- No `flowType` specified (standalone chat-style builder)
- Agent has no browser tools installed

**Screenshot rule:**
- Action flows: screenshot step is MANDATORY second-to-last (confirms action succeeded)
- Scrape flows: NO screenshot step — the extracted data is the evidence of success

**SSE event routing on the frontend:**
- `explorer_*` events → right panel `ExplorerLogPanel` (live during exploration)
- Standard events → left panel chat
- `builder_start` → right panel transitions from explorer log to flow preview

---

## Hydration pipeline — MANDATORY for all content action flows

Any flow that posts, comments, replies, or sends text to an external platform MUST follow this pattern:

```
step 0: __hydrate__   — re-fetches all references in the ActionBrief → produces HydratedContext
step 1: __generate__  — calls Sonnet with HydratedContext → outputs final text (stored in entry.finalContent)
         ↑ ── REVIEW PAUSE HERE — action log entry is created as pending_review ── ↑
step 2: the actual action tool (e.g. post_comment), reading from step 1 output
```

**Critically:** the review layer sits between `__generate__` and the posting step — NOT before hydration. By the time a card appears in `ReviewActionsTab`, `entry.finalContent` is already populated with the Sonnet output and the flow run's `stepResults` already contain the `HydratedContext`. Pressing "Play" fires step 2 only.

Input schema must accept `action_brief` — **NEVER** raw `comment_body`, `reply_text`, or `message_text`.

`entry.input` stores the raw ActionBrief as `{ post_url, action_brief: "<JSON string>" }` — `action_brief` is double-encoded (a JSON string within JSON). `ReviewActionsTab` parses it by doing `JSON.parse(inputObj['action_brief'])`, then fetches the nearest flow run to retrieve the `HydratedContext` from `stepResults` for display.

The rule is enforced in `agents/ui/flow-generator.action.preamble.md` (UI-built flows) and `agents/autonomous/action-flow-agent.ts` (manager-built flows). See `PROTOCOL_HYDRA.md` for history.

---

## Extension architecture

The Chrome extension lives in `packages/extension/src/` and has four runtime contexts:

```
background/index.ts   ← service worker: picker injection, primitive dispatch, macro recorder
content/index.ts      ← content script: receives EXECUTE_PRIMITIVE, runs primitives in page context
popup/index.ts        ← popup UI: Picker tab, Runner tab, Flows tab
primitives/index.ts   ← all browser primitives (get_text, click, get_dom_raw, get_dom_filtered, …)
```

**DOM tool hierarchy** — agents and flows must follow this order:
1. `get_dom_filtered` — ALWAYS try first. Calls `get_dom_raw` then runs `applyDomFilter` server-side (strips head/script/style/svg/comments, collapses whitespace, 50k cap on output). Preserves semantic attrs: `href, src, alt, aria-label, aria-hidden, id, type, name, value, placeholder, title`.
2. `get_dom` — fallback only if filtered output is insufficient.
3. `get_dom_raw` — never use in flows. No character cap (cap was removed — raw HTML can be several MB).

`get_dom_filtered` is implemented both server-side (`applyDomFilter` in `orchestrator/tool-types/`) and client-side in the extension (`_applyDomFilter` in `primitives/index.ts`) so the Runner tab can call it directly without a server round-trip.

---

## Extension Picker tab

The picker injects `injectedPickerFn(mode, domMode)` into the active tab via `chrome.scripting.executeScript`.

**Modes** — `mode` param:
- `item` — returns the exact element hovered
- `object` — walks UP the DOM to the nearest meaningful container (`data-testid`, `role="article"`, etc.)

**DOM modes** — `domMode` param (persisted in `chrome.storage.local` as `pickerDomMode`):
- `filtered` — treats `data-display-contents="true"` and `style="display:contents"` elements as transparent when walking and collecting siblings. This mirrors what `get_dom_filtered` shows agents.
- `raw` — no transparency; every wrapper element is opaque.
- `stable` — builds selectors from `data-testid` / `data-cy` / `data-qa` / `id` anchors only, joined with spaces (descendant combinator). No tag names, no `:nth-of-type`. Most resilient to layout changes.

**Dual overlay system** — on every hover, both modes always show:
- **Green** overlay on the specific hovered element (what gets copied)
- **Blue** overlays on all logical siblings in the same container (visual "query_all" picture)

**Live badge** — the on-page badge updates on every mouseover showing:
- Line 1: `MODE [domMode] · Esc to cancel`
- Line 2: `…truncated-selector  ×N  ·  M similar` where ×N = `querySelectorAll` count of the copied selector, M similar = logical sibling count

**display:contents helpers** inside `injectedPickerFn` (used when `domMode !== 'raw'`):
- `isDisplayContents(el)` — true if element has `data-display-contents="true"` or `style.display === 'contents'`
- `logicalParentOf(el)` — walks up skipping display:contents wrappers
- `logicalChildrenOf(container)` — flattens display:contents children one level deep

---

## Flow Master panel

A chat panel embedded in the FlowEditor page (`/agents/:id/flows`) that lets users ask flow-building questions in context.

```
POST /agents/:agentId/flow-master/chat
  → features/flow-master/flow-master.routes.ts
    ← uses agent's own API key, Haiku model
    ← receives { message, history, flowContext: { name, description, flowType, steps } }
    ← returns { reply: string }
```

Frontend: `packages/frontend/src/components/flow-editor/FlowMasterPanel.tsx` — 320px right-side panel, renders alongside the main FlowEditor content via `display: flex` layout.

---

## DOM playground

`play_ground/html_output.html` — a standalone browser-based tool for experimenting with HTML cleaning pipelines before writing transformers. Drop or paste raw HTML, toggle cleaning steps, view code/rendered/pretty output.

`⚡ get_dom_filtered` preset enables: strip-class, strip-script, strip-style, strip-svg, strip-comments, strip-img, strip-display-contents, strip-style-attr, strip-aria-hidden, normalize-custom-tags, strip-empty-tags, collapse-whitespace. Does NOT enable `strip-attrs` (removing all attributes breaks transformer usability).

---

## Dev mode

```bash
pnpm dev   # tsx watch src/index.ts
```

TypeScript source runs directly — no compilation step. Changes to `.ts` **and** `.md` prompt files are live immediately on save. `dist/` is only used by `pnpm start` (production). Running `tsc` in dev is only useful for type-checking — it does not affect the running server.

---

## Active operations

| Document | Status | Purpose |
|----------|--------|---------|
| `PROTOCOL_HYDRA.md` | In progress — Task 1.3 pending | Enforce hydration pipeline for all content flows |
