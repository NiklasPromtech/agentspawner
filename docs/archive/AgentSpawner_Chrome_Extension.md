AgentSpawner Chrome Extension Brief

Overview

The AgentSpawner project is a local, self‑hosted platform for creating and orchestrating AI agents that carry out web‑based tasks through a Chrome extension.  The goal is to provide a way to automate workflows that require a logged‑in browser session (for example scraping posts on X and extracting leads) without relying on expensive APIs.  Users can create agents, define tools and schedules, and view logs, all through a simple interface.  Agents run locally, using your own API keys, and interact with web pages via a custom extension that exposes safe, deterministic browser actions.

Objectives
	•	Local autonomy: run agents entirely on a local machine, using your own Anthropic API key for reasoning and personalising tasks.
	•	Browser automation: expose a comprehensive but safe set of browser primitives (open, navigate, click, type, scroll, extract DOM, etc.) so the AI can perform tasks in a logged‑in session using the extension.
	•	Tool creation with AI assistance: allow users to describe the desired behaviour of a tool in plain language; an AI assistant generates the tool’s code, parameters schema and description based on the available extension primitives.
	•	Flexible agent management: provide a UI to set up agents, monitor conversations, manage tools, schedule recurring tasks, and review logs.
	•	Data collection and storage: support creating tables for storing structured data (e.g. leads) and saving extracted information during agent runs.
	•	Scheduling: run agents automatically at defined times via cron expressions (e.g. daily at 10:00 Europe/Stockholm time).
	•	Transparency and safety: log every message, tool input and output; require confirmation for write actions if desired; allow read‑only mode; keep sensitive keys encrypted.

User Interface

The application is a React‑based dashboard served from localhost.  Key pages include:
	•	Home page: lists existing agents (showing last used and number of tools) and provides a button to create a new agent.
	•	Agent view: each agent has multiple tabs:
	1.	Setup: fields for Anthropic API key, Telegram key, the agent’s goal (e.g. “Generate web3 founders leads”), and personality type; optional toggles for safety modes (read‑only, no DMs, etc.).
	2.	Chat: shows the conversation history between the user and the agent.  Messages, tool calls and tool responses are displayed.  An input box allows you to send prompts to the agent and receive its replies.  A “run” button starts a new reasoning session, and a “stop” button cancels a long‑running loop.
	3.	Tool Manager: lists all tools created for this agent.  A “Create Tool” button opens the tool editor:
	•	Type select: choose extension, web search, web fetch or local.  Extension tools call the Chrome extension; web search/fetch wrap native Anthropic tools; local tools can read/write tables.
	•	Generate with AI: a textarea where the user describes what the tool should do.  The AI returns a tool name in snake_case, a description telling the agent when to use it, a JSON parameters schema, and the code body.  Users can edit these fields manually.
	•	Test runner: accepts JSON inputs for the tool and runs it to display the output.  The extension returns the page DOM after it fully loads, which helps debug scraping tasks.
	4.	Extension: shows installation instructions, connection status and diagnostics for the Chrome extension.  Indicates whether the extension is connected and lists permitted actions.
	5.	Schedule: a cron editor to run prompts on a recurring schedule.  Users specify the cron expression (e.g. “0 10 * * *”) and a message (the prompt to send).  The scheduler respects Europe/Stockholm timezone and writes results into tables or notifies the user via Telegram.
	6.	Librarian: reserved for future use; designed to tag and summarise conversation contexts for better retrieval.
	7.	Database: lists user‑defined tables and provides a table creation wizard (name and JSON schema).  Users can view, filter and delete rows.  Tools can insert into these tables during runs.
	8.	Logger: presents raw logs of agent runs, including timestamps, prompts, tool calls, tool inputs and outputs, and any errors.  A filter bar allows narrowing by agent, run, or tool.

Extension Capabilities

The Chrome extension (Manifest V3) acts as the agent’s “hands”.  It exposes a small set of deterministic, composable actions via a WebSocket or message‑passing API:
	•	Tab control: open a new tab (open_tab), close a tab (close_tab), switch to a specific tab (switch_tab).
	•	Navigation and waiting: navigate to a URL and wait for the page to load; wait for a selector to appear (wait_for).
	•	Element interaction: click an element (click), type text into an input (type), scroll up or down (scroll).
	•	Extraction: fetch the page’s outer HTML or visible text (get_dom), query multiple elements and return their attributes or text (query_all).
	•	Diagnostics: optionally capture screenshots for debugging.

Tools that call the extension string these primitives together, with proper error handling and timeouts.  The extension must enforce permission scoping, avoid unbounded loops, and respect user preferences (e.g. read‑only mode).

Tool Lifecycle
	1.	Creation: the user describes a desired task (e.g. “Search X for web3 founders and collect profiles”); the tool creator passes this description, along with the list of available extension primitives and constraints, to Anthropic.  The AI returns a tool definition including name, description, JSON schema and JavaScript function body.  Users can review and adjust the definition.
	2.	Testing: the tool can be run with sample inputs.  For an extension tool, the test will open tabs, perform actions, and return the output (often JSON or a plain‑text summary).  If the tool requires input (e.g. a search term), the test runner accepts that input.
	3.	Saving: once satisfied, the user saves the tool; it becomes available to the agent.  Agents can then call this tool during a conversation when their reasoning deems it necessary (based on the description).

Scheduling

A dedicated scheduler executes prompts on a recurring basis using cron expressions.  Each schedule includes:
	•	cron: defines when the task runs (e.g. 0 10 * * * for 10:00 every day).  The scheduler interprets times in the user’s timezone (Europe/Stockholm).
	•	prompt: the message sent to the agent when the schedule triggers (e.g. “Run today’s lead search for web3 founders”).
	•	agent: which agent the schedule belongs to.
	•	enabled flag: allows pausing schedules without deleting them.

On trigger, the scheduler initiates a new run, passes the prompt to the agent, and lets the agent use tools.  Outputs can be saved to tables or relayed via Telegram if configured.

Data Storage

SQLite (or another lightweight database) stores:
	•	agents: id, name, goal, API keys (encrypted), personality, created_at, last_used_at.
	•	tools: id, agent_id, name, type, description, params_schema, code, created_at.
	•	runs: id, agent_id, start and end timestamps, status.
	•	messages: id, run_id, role (user, assistant, tool), content, tool_name, tool_input, tool_output, timestamp.
	•	tables: id, name, schema; used for persistent storage of scraped data (e.g. leads).
	•	rows: id, table_id, data, created_at.
	•	schedules: id, agent_id, cron, prompt, enabled, next_run.

The system writes logs for every tool call and message for full traceability.

Sample Use Case: Generating Leads on X
	1.	Define a table: create a leads table with columns such as handle, name, bio, url, context, and captured_at.
	2.	Create a tool: use the AI assistant to generate a tool like search_x_web3_founders.  Its code might:
	•	Open https://x.com/search?q=%s in a new tab.
	•	Wait for search results.
	•	Scroll to load more results.
	•	Extract profile handles, names and bios via DOM selectors.
	•	Return a JSON string of the extracted profiles.
	3.	Create a save tool: a second tool could parse the JSON and insert new rows into the leads table, deduplicating by handle.
	4.	Schedule a daily run: set a schedule to run at 10:00 every day.  The prompt instructs the agent to run the search tool with specific queries and then save the results.  After completion, the agent might summarise the top leads and send a message via Telegram.
	5.	Review: using the Database and Logger tabs, the user can inspect saved leads and see detailed logs of what the agent did during each run.

Security and Privacy Considerations
	•	Local storage: all data and API keys are stored locally; nothing is sent to external services except Anthropic API calls.
	•	Encrypted credentials: API keys and sensitive tokens should be encrypted at rest, with optional password protection when starting the app.
	•	Permission control: the extension should request only the necessary Chrome permissions and expose only explicitly defined actions.  Restrict the agent from performing unapproved operations (e.g. sending messages) unless the user enables them.
	•	User confirmation: for actions that can have side effects (typing, clicking buttons, submitting forms), offer the option to require user confirmation.  A read‑only mode ensures the agent never performs write actions without consent.

Proposed Technology Stack
	•	Frontend: Next.js or Vite + React for a single‑page application.  Use CodeMirror or Monaco for the tool editor.
	•	Backend: Node.js with Express or Fastify to serve the API; run the orchestrator and scheduler here.  Use Zod for schema validation.
	•	Database: SQLite via Prisma or Drizzle ORM.  This provides a durable, embeddable database.
	•	Extension: Chrome MV3 extension with a background service worker and content scripts.  Communicate with the backend via a WebSocket or long‑lived port connection.  Use Manifest V3 restrictions to manage permissions.
	•	AI integration: Anthropic’s Claude API for tool generation and chat reasoning.
	•	Scheduling: node‑cron or Bree to parse cron expressions and trigger tasks.

Next Steps
	1.	Build a minimal vertical slice: create the extension with a few primitives (open_tab, get_dom, click), implement the backend orchestrator and tool runner, and develop the UI for creating one agent and one tool.
	2.	Add tool generation: integrate Anthropic to generate tool code from user descriptions.
	3.	Implement logging and database: store messages, tools and runs; build the Logger and Database pages.
	4.	Enhance extension capabilities: add scrolling, element query, typing and screenshot functions; harden error handling.
	5.	Introduce scheduling: allow users to set cron jobs and run agents automatically.
	6.	Add safety controls and librarian: implement read‑only mode, confirmation prompts, and a summarisation/tagging service for context management.

This brief outlines the vision, architecture and primary components needed to realise the AgentSpawner Chrome Extension edition.  It emphasises a secure, local system where users can create powerful automation agents tailored to their browser‑based workflows.