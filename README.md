# Support Agent

**[Workshop Slides](https://agents-workshop.lauragift.workers.dev/)**

A customer support chat agent built on Cloudflare, powered by the [Agents SDK](https://developers.cloudflare.com/agents/). It looks up orders, searches a knowledge base, creates tickets with human-in-the-loop approval, processes tickets through a multi-step workflow, and exposes its capabilities as an MCP server.

## Features

- **AI Chat** -- Streaming responses via Workers AI (`AIChatAgent` + WebSocket)
- **Order Lookup** -- Fetch order details by order number from a D1-backed API
- **Knowledge Base Search** -- Search support articles to answer customer questions
- **Ticket Creation** -- Create support tickets with human-in-the-loop approval before execution
- **Ticket Processing Workflow** -- Multi-step workflow that classifies tickets with AI, attempts auto-resolution, escalates unresolved issues, and gates high-priority tickets behind manager approval
- **Scheduling** -- Delayed, one-time, and cron-based task scheduling (e.g. follow-up reminders)
- **MCP Server** -- Exposes order lookup, knowledge search, and ticket creation as tools for MCP-compatible clients (Claude Desktop, Cursor, VS Code, etc.) at `/mcp`
- **Debug Mode** -- Toggle in the header to inspect raw message JSON
- **Dark/Light Mode** -- Theme toggle via Cloudflare's Kumo design system

## Project structure

```
src/
  server.ts            # Chat agent with tools, scheduling, and workflow orchestration
  mcp.ts               # MCP server exposing support tools
  workflows/ticket.ts  # Multi-step ticket processing workflow
  app.tsx              # Chat UI built with Kumo components
  client.tsx           # React entry point
  styles.css           # Tailwind + Kumo styles
```

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to see the agent in action.

Try these prompts:

- **"What is the status of order ORD-1234?"** -- looks up the order via the support API
- **"What is your return policy?"** -- searches the knowledge base
- **"Create a ticket for my broken keyboard"** -- creates a ticket (asks for approval first)
- **"Remind me in 5 minutes to follow up"** -- schedules a delayed task

## How it works

### Chat Agent (`server.ts`)

The `ChatAgent` class extends `AIChatAgent` and defines tools that the AI model can call:

| Tool                  | Type         | Description                                      |
| --------------------- | ------------ | ------------------------------------------------ |
| `lookupOrder`         | Auto-execute | Fetches order details from the support API       |
| `searchKnowledge`     | Auto-execute | Searches the knowledge base                      |
| `createTicket`        | Approval     | Creates a ticket after user approves             |
| `scheduleTask`        | Auto-execute | Schedules a reminder or recurring task           |
| `runTicketWorkflow`   | Auto-execute | Kicks off the ticket processing workflow         |
| `approveWorkflowTool` | Auto-execute | Approves a workflow waiting for manager sign-off |
| `rejectWorkflowTool`  | Auto-execute | Rejects a workflow waiting for manager sign-off  |

### Ticket Workflow (`workflows/ticket.ts`)

A durable, multi-step workflow powered by `AgentWorkflow`:

1. **Classify** -- Uses Workers AI (Llama 3) to categorize the ticket (billing, technical, shipping, general). Retries up to 3 times with exponential backoff.
2. **Resolve** -- Searches the knowledge base for a matching article. If found, auto-resolves.
3. **Escalate** -- If unresolved, escalates to the support team.
4. **Approval Gate** -- High-priority escalated tickets pause and wait for manager approval (up to 7 days). Approved tickets result in a refund; rejected tickets are closed.

Each step is checkpointed -- if the workflow crashes, it resumes from the last completed step.

### MCP Server (`mcp.ts`)

The `SupportMCP` class exposes three tools over the Model Context Protocol at `/mcp`:

- `lookup-order` -- Look up a customer order
- `search-knowledge` -- Search the knowledge base
- `create-ticket` -- Create a support ticket

Connect any MCP-compatible client to `<your-worker-url>/mcp` to use these tools.

## Deploy

```bash
npm run deploy
```

## Learn more

- [Agents SDK documentation](https://developers.cloudflare.com/agents/)
- [Build a chat agent tutorial](https://developers.cloudflare.com/agents/getting-started/build-a-chat-agent/)
- [Workflows documentation](https://developers.cloudflare.com/agents/api-reference/agent-workflows/)
- [MCP Server documentation](https://developers.cloudflare.com/agents/api-reference/mcp-server/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)

## License

MIT
