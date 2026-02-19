import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_URL = "https://support-api.lauragift.workers.dev";

/**
 * MCP server that exposes the support agent's capabilities
 * to any MCP-compatible client (Claude Desktop, Cursor, VS Code, etc.)
 */
export class SupportMCP extends McpAgent<Env, object, Record<string, unknown>> {
  server = new McpServer({
    name: "customer-support",
    version: "1.0.0",
  });

  async init() {
    // Expose order lookup tool
    this.server.tool(
      "lookup-order",
      "Look up a customer order by order number",
      { orderId: z.string().describe("e.g. ORD-1234") },
      async ({ orderId }) => {
        const res = await fetch(`${API_URL}/api/orders/${orderId}`);
        const data = await res.json();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );

    // Expose knowledge base search tool
    this.server.tool(
      "search-knowledge",
      "Search the support knowledge base for answers",
      { query: z.string().describe("e.g. 'return policy'") },
      async ({ query }) => {
        const res = await fetch(
          `${API_URL}/api/knowledge?q=${encodeURIComponent(query)}`,
        );
        const data = await res.json();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );

    // Expose ticket creation tool
    this.server.tool(
      "create-ticket",
      "Create a new support ticket",
      {
        subject: z.string(),
        priority: z.enum(["low", "medium", "high"]),
        description: z.string(),
      },
      async (params) => {
        const res = await fetch(`${API_URL}/api/tickets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        const data = await res.json();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );
  }
}
