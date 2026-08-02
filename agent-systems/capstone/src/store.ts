/**
 * Capstone ticket store: the system of record for the triage agent.
 *
 * Deliberately boring: typed tickets, a seed set, and durable persistence via
 * the library's FileStore. The agent never gets direct access — it must use
 * the contract tools, which is the whole point.
 */

import { join } from "node:path";
import { FileStore } from "../../src/index.js";

export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketStatus = "open" | "triaged" | "refund-pending" | "closed";

export interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  /** Present when the customer is asking for money back. */
  readonly refundRequestUsd?: number;
}

const NAMESPACE = "tickets";

export const SEED_TICKETS: readonly Ticket[] = [
  {
    id: "T-1001",
    subject: "Charged twice this month",
    body: "Your billing system charged me twice on the 1st. I want my $49 back immediately. This is the second time.",
    status: "open",
    priority: "medium",
    refundRequestUsd: 49,
  },
  {
    id: "T-1002",
    subject: "How do I export my notes?",
    body: "I can't find the export button. Where is it?",
    status: "open",
    priority: "medium",
  },
  {
    id: "T-1003",
    subject: "Data loss after sync",
    body: "Three days of notes disappeared after the last sync. I run a business on this. Refund my annual plan ($240) and fix this NOW.",
    status: "open",
    priority: "medium",
    refundRequestUsd: 240,
  },
  {
    id: "T-1004",
    subject: "Dark mode request",
    body: "Any chance of a darker dark mode? The current one is a bit gray.",
    status: "open",
    priority: "medium",
  },
];

export class TicketStore {
  private readonly store: FileStore;

  constructor(dataDir: string) {
    this.store = new FileStore(dataDir);
  }

  private key(id: string): string {
    return id;
  }

  async seed(): Promise<void> {
    for (const ticket of SEED_TICKETS) {
      const existing = await this.store.get<Ticket>(NAMESPACE, this.key(ticket.id));
      if (existing === undefined) await this.store.set(NAMESPACE, this.key(ticket.id), ticket);
    }
  }

  async listOpen(): Promise<readonly Ticket[]> {
    const keys = await this.store.keys(NAMESPACE);
    const tickets = await Promise.all(keys.map((k) => this.store.get<Ticket>(NAMESPACE, k)));
    return tickets.filter((t): t is Ticket => t !== undefined && t.status !== "closed");
  }

  async get(id: string): Promise<Ticket | undefined> {
    return this.store.get<Ticket>(NAMESPACE, this.key(id));
  }

  async update(id: string, patch: Partial<Pick<Ticket, "status" | "priority">>): Promise<Ticket> {
    const ticket = await this.get(id);
    if (ticket === undefined) throw new Error(`unknown ticket ${id}`);
    const updated: Ticket = { ...ticket, ...patch };
    await this.store.set(NAMESPACE, this.key(id), updated);
    return updated;
  }
}

export function defaultDataDir(): string {
  return join(process.cwd(), ".capstone-data");
}
