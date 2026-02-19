import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, type Schedule } from "agents";
import { scheduleSchema } from "agents/schedule";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";
import { z } from "zod";
import type { TicketResult } from "./workflows/ticket";

// Re-export the workflow and MCP agent so Cloudflare can find them
export { TicketWorkflow } from "./workflows/ticket";
import { SupportMCP } from "./mcp";
export { SupportMCP };

const mcpHandler = SupportMCP.serve("/mcp", { binding: "MCP" });

const API_URL = "https://support-api.lauragift.workers.dev";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal },
  ) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "support-agent" },
    });

    const result = streamText({
      // @ts-expect-error - model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a friendly and knowledgeable support agent. Help users troubleshoot issues, answer questions clearly, and guide them step by step. Always be concise and professional.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
      }),
      tools: {
        // Support tools - call the real Support API backed by D1
        lookupOrder: tool({
          description: "Look up a customer order by order number",
          inputSchema: z.object({
            orderId: z.string().describe("e.g. ORD-1234"),
          }),
          execute: async ({ orderId }) => {
            const res = await fetch(`${API_URL}/api/orders/${orderId}`);
            return res.json();
          },
        }),

        searchKnowledge: tool({
          description: "Search the support knowledge base for answers",
          inputSchema: z.object({
            query: z.string().describe("e.g. 'return policy'"),
          }),
          execute: async ({ query }) => {
            const res = await fetch(
              `${API_URL}/api/knowledge?q=${encodeURIComponent(query)}`,
            );
            return res.json();
          },
        }),

        createTicket: tool({
          description: "Create a support ticket for the customer",
          inputSchema: z.object({
            subject: z.string(),
            priority: z.enum(["low", "medium", "high"]),
            description: z.string(),
          }),
          needsApproval: async () => true,
          execute: async (params) => {
            const res = await fetch(`${API_URL}/api/tickets`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(params),
            });
            return res.json();
          },
        }),

        // Schedule tools
        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description);
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          },
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          },
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel"),
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          },
        }),

        // Workflow tools
        runTicketWorkflow: tool({
          description:
            "Run the ticket processing workflow to classify, attempt resolution, and escalate if needed. Use this when a support ticket needs to be processed.",
          inputSchema: z.object({
            ticketId: z.string().describe("The ticket ID to process"),
            subject: z.string().describe("The ticket subject"),
            priority: z
              .enum(["low", "medium", "high"])
              .describe("Ticket priority"),
          }),
          execute: async ({ ticketId, subject, priority }) => {
            try {
              const instanceId = await this.runWorkflow("TICKET_WORKFLOW", {
                ticketId,
                subject,
                priority,
              });
              return {
                status: "started",
                instanceId,
                message: `Workflow started for ticket ${ticketId}`,
              };
            } catch (error) {
              return { status: "error", message: `${error}` };
            }
          },
        }),

        getWorkflowStatus: tool({
          description: "Check the status of all running ticket workflows",
          inputSchema: z.object({}),
          execute: async () => {
            const { workflows } = this.getWorkflows();
            return workflows.map((w) => ({
              id: w.workflowId,
              name: w.workflowName,
              status: w.status,
              createdAt: w.createdAt.toISOString(),
            }));
          },
        }),

        approveWorkflowTool: tool({
          description:
            "Approve a workflow that is waiting for manager approval. Use this when a manager wants to approve a high-priority ticket.",
          inputSchema: z.object({
            instanceId: z
              .string()
              .describe("The workflow instance ID to approve"),
            approvedBy: z
              .string()
              .describe("Name or ID of the person approving"),
          }),
          execute: async ({ instanceId, approvedBy }) => {
            try {
              await this.approveWorkflow(instanceId, {
                reason: "Approved by manager",
                metadata: { approvedBy },
              });
              return {
                status: "approved",
                message: `Workflow ${instanceId} approved by ${approvedBy}`,
              };
            } catch (error) {
              return { status: "error", message: `${error}` };
            }
          },
        }),

        rejectWorkflowTool: tool({
          description:
            "Reject a workflow that is waiting for manager approval. Use this when a manager wants to reject a high-priority ticket.",
          inputSchema: z.object({
            instanceId: z
              .string()
              .describe("The workflow instance ID to reject"),
            reason: z.string().describe("Reason for rejection"),
          }),
          execute: async ({ instanceId, reason }) => {
            try {
              await this.rejectWorkflow(instanceId, { reason });
              return {
                status: "rejected",
                message: `Workflow ${instanceId} rejected: ${reason}`,
              };
            } catch (error) {
              return { status: "error", message: `${error}` };
            }
          },
        }),
      },
      onFinish,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  // Workflow lifecycle callbacks
  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: { step: string; status: string; message: string },
  ) {
    this.broadcast(
      JSON.stringify({
        type: "workflow-progress",
        workflowId,
        ...progress,
      }),
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: TicketResult,
  ) {
    console.log(`Workflow ${workflowId} completed:`, result);
    this.broadcast(
      JSON.stringify({
        type: "workflow-complete",
        workflowId,
        result,
      }),
    );
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string,
  ) {
    console.error(`Workflow ${workflowId} failed:`, error);
    this.broadcast(
      JSON.stringify({
        type: "workflow-error",
        workflowId,
        error,
      }),
    );
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);

    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Handle MCP requests at /mcp
    if (url.pathname.startsWith("/mcp")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
