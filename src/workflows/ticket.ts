import { AgentWorkflow, WorkflowRejectedError } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { ChatAgent } from "../server";

const API_URL = "https://support-api.lauragift.workers.dev";

export type TicketParams = {
  ticketId: string;
  subject: string;
  priority: "low" | "medium" | "high";
};

export type TicketResult = {
  ticketId: string;
  outcome:
    | "auto-resolved"
    | "escalated"
    | "refund-approved"
    | "refund-rejected";
  classification?: string;
};

/**
 * Multi-step ticket processing workflow.
 * Each step.do() is checkpointed - if the workflow crashes,
 * it resumes from the last completed step.
 */
export class TicketWorkflow extends AgentWorkflow<
  ChatAgent,
  TicketParams,
  { step: string; status: string; message: string }
> {
  async run(event: AgentWorkflowEvent<TicketParams>, step: AgentWorkflowStep) {
    const { ticketId, subject, priority } = event.payload;

    // Step 1: Classify the ticket (retries 3x with exponential backoff)
    const classification = await step.do(
      "classify",
      {
        retries: {
          limit: 3,
          delay: "5 seconds",
          backoff: "exponential"
        }
      },
      async () => {
        await this.reportProgress({
          step: "classify",
          status: "running",
          message: `Classifying ticket: ${subject}`
        });

        const res = (await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
          prompt: `Classify this support ticket into one category (billing, technical, shipping, general). Just respond with the category name.\n\nSubject: ${subject}\nPriority: ${priority}`
        })) as { response?: string };
        return { category: res.response ?? "general" };
      }
    );

    await this.reportProgress({
      step: "classify",
      status: "complete",
      message: `Classified as: ${classification.category}`
    });

    // Step 2: Attempt auto-resolution by searching knowledge base
    const resolution = await step.do("resolve", async () => {
      await this.reportProgress({
        step: "resolve",
        status: "running",
        message: "Searching knowledge base for resolution..."
      });

      const res = await fetch(
        `${API_URL}/api/knowledge?q=${encodeURIComponent(subject)}`
      );
      const data = (await res.json()) as {
        articles: { title: string; summary: string }[];
      };

      const hasMatch = data.articles && data.articles.length > 0;
      return {
        resolved: hasMatch,
        suggestion: hasMatch
          ? data.articles[0].summary
          : "No matching knowledge base article found"
      };
    });

    await this.reportProgress({
      step: "resolve",
      status: "complete",
      message: resolution.resolved
        ? `Auto-resolved: ${resolution.suggestion}`
        : "Could not auto-resolve, escalating..."
    });

    // Step 3: Escalate if unresolved
    if (!resolution.resolved) {
      await step.do("escalate", async () => {
        await this.reportProgress({
          step: "escalate",
          status: "running",
          message: "Escalating to support team..."
        });

        return { escalated: true, assignedTo: "support-team" };
      });
    }

    // Step 4: If high priority and escalated, require manager approval
    if (!resolution.resolved && priority === "high") {
      await this.reportProgress({
        step: "approval",
        status: "pending",
        message: `High-priority ticket ${ticketId} requires manager approval`
      });

      try {
        const approvalData = await this.waitForApproval<{
          approvedBy?: string;
        }>(step, {
          timeout: "7 days"
        });

        await this.reportProgress({
          step: "approval",
          status: "complete",
          message: `Approved by: ${approvalData?.approvedBy ?? "manager"}`
        });

        const result: TicketResult = {
          ticketId,
          outcome: "refund-approved",
          classification: classification.category
        };
        await step.reportComplete(result);
        return result;
      } catch (error) {
        if (error instanceof WorkflowRejectedError) {
          await this.reportProgress({
            step: "approval",
            status: "complete",
            message: "Approval rejected"
          });

          const result: TicketResult = {
            ticketId,
            outcome: "refund-rejected",
            classification: classification.category
          };
          await step.reportComplete(result);
          return result;
        }
        throw error;
      }
    }

    const result: TicketResult = {
      ticketId,
      outcome: resolution.resolved ? "auto-resolved" : "escalated",
      classification: classification.category
    };

    await step.reportComplete(result);

    return result;
  }
}
