/**
 * Example 02 — Tool contracts: the foundation of agency.
 *
 * Topics: tools · typed contracts · authorization in code · postconditions.
 *
 * A tool is a contract, not a function with a description. This example shows
 * all five enforcement points firing — including a write-scope denial that no
 * prompt could have guaranteed.
 *
 * Run: npm run example -- examples/02-tool-contracts.ts
 */

import { z } from "zod";
import { PolicyError, ReasoningError, defineContractTool } from "../src/index.js";
import { main, printSection } from "./lib/shared.js";

// A tiny in-memory ticket system — the "world" the tool acts on.
const tickets = new Map([
  ["T-1", { id: "T-1", status: "open" }],
  ["T-2", { id: "T-2", status: "open" }],
]);

const closeTicket = defineContractTool(
  {
    name: "close_ticket",
    description: "Closes a support ticket. Only for tickets the user explicitly resolved.",
    input: z.object({ id: z.string().regex(/^T-\d+$/) }),
    output: z.object({ id: z.string(), status: z.string() }),
    sideEffect: "mutating",
    idempotent: true, // closing an already-closed ticket has the same end state
    writeScope: "tickets",
    postcondition: (input) =>
      tickets.get(input.id)?.status === "closed" ? true : `ticket ${input.id} is not closed in the system of record`,
    execute: async ({ id }) => {
      const ticket = tickets.get(id);
      if (ticket === undefined) throw new Error(`unknown ticket ${id}`);
      ticket.status = "closed";
      return { id, status: ticket.status };
    },
  },
  { context: { agentId: "support-agent", writeScopes: ["tickets"] } },
);

const execute = async (tool: unknown, input: unknown): Promise<unknown> => {
  const exec = (tool as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  if (exec === undefined) throw new Error("no execute");
  return exec(input, { toolCallId: "demo", messages: [] });
};

await main(async () => {
  printSection("02 — Tool contracts: five enforcement points");

  console.log("\n1. Valid call within scope:");
  console.log(await execute(closeTicket, { id: "T-1" }));

  console.log("\n2. Invalid input rejected at the schema boundary:");
  try {
    await execute(closeTicket, { id: "not-a-ticket-id" });
  } catch (err) {
    if (err instanceof ReasoningError) console.log(`  blocked: [${err.code}] ${err.message}`);
  }

  console.log("\n3. Write-scope denial — enforced in code, not by the prompt:");
  const scopeless = defineContractTool(
    {
      name: "close_ticket",
      description: "Closes a support ticket.",
      input: z.object({ id: z.string().regex(/^T-\d+$/) }),
      sideEffect: "mutating",
      idempotent: true,
      writeScope: "tickets",
      execute: async ({ id }) => ({ id, status: "closed" }),
    },
    { context: { agentId: "rogue-agent", writeScopes: [] } },
  );
  try {
    await execute(scopeless, { id: "T-2" });
  } catch (err) {
    if (err instanceof PolicyError) {
      console.log(`  blocked: [${err.code}] ${err.message}`);
      console.log(`  evidence: ${err.evidence.join(" | ")}`);
    }
  }

  console.log("\n4. Postcondition verified against the system of record:");
  console.log(`  T-1 status in the world: ${tickets.get("T-1")?.status ?? "?"}`);
});
