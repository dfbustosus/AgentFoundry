/**
 * MCP (Model Context Protocol) client wiring.
 *
 * MCP servers expose tools over stdio or HTTP. Every enabled server increases
 * context size AND attack surface, so this module forces two decisions to be
 * explicit:
 *
 * 1. an allowlist of tool names (`allowedTools`) — least privilege by default;
 *    omitting it is a conscious choice, not an accident;
 * 2. treating MCP tool output as UNTRUSTED data: it can instruct, but it
 *    cannot override system policy (enforced by the tool/enforcement layers,
 *    not by hoping the model resists injection).
 */

import { createMCPClient, type MCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

export interface McpServerHandle {
  readonly client: MCPClient;
  /** AI SDK ToolSet, filtered to the allowlist when one was provided. */
  readonly tools: ToolSet;
  /** Names of all tools the server advertised (before filtering). */
  readonly advertised: readonly string[];
  /** Names actually exposed to agents (after filtering). */
  readonly exposed: readonly string[];
  readonly close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Stdio transport: command + args, e.g. { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }. */
  readonly stdio?: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Record<string, string>;
  };
  /** HTTP transport: base URL of a remote MCP server. */
  readonly url?: string;
  readonly headers?: Record<string, string>;
  /**
   * Least-privilege allowlist. When provided, ONLY these tool names are
   * exposed to agents. When omitted, everything the server offers is exposed —
   * the caller owns that risk decision.
   */
  readonly allowedTools?: readonly string[];
  /** Passed to the MCP client for transient tools/call retries. Default 0: retries are our layer's job. */
  readonly maxRetries?: number;
}

export async function connectMcpServer(options: ConnectOptions): Promise<McpServerHandle> {
  if (options.stdio === undefined && options.url === undefined) {
    throw new Error("connectMcpServer requires either a stdio command or a url.");
  }

  let transport: MCPClientConfig["transport"];
  if (options.stdio !== undefined) {
    // Lazy import: stdio transport spawns a child process and must not load in
    // browser-like or test environments that only use HTTP servers.
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: options.stdio.command,
      args: [...(options.stdio.args ?? [])],
      ...(options.stdio.env !== undefined ? { env: options.stdio.env } : {}),
    });
  } else {
    transport = {
      type: "http" as const,
      url: options.url as string,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    };
  }

  const client = await createMCPClient({
    transport,
    maxRetries: options.maxRetries ?? 0,
    clientName: "agent-systems-foundry",
  });

  const allTools = await client.tools();
  const advertised = Object.keys(allTools);

  const exposed =
    options.allowedTools === undefined
      ? advertised
      : advertised.filter((name) => options.allowedTools?.includes(name) ?? false);

  const tools: ToolSet = Object.fromEntries(Object.entries(allTools).filter(([name]) => exposed.includes(name)));

  return {
    client,
    tools,
    advertised,
    exposed,
    close: () => client.close(),
  };
}
