/**
 * Validation and enforcement layers — why prompts are not sufficient.
 *
 * A prompt can GUIDE a model toward safe behavior. It cannot ENFORCE anything,
 * because the model is a probabilistic system and the prompt is input it can
 * misunderstand, ignore, or be injected past. For high-stakes paths, the
 * mandatory controls live here, in deterministic code:
 *
 *   1. schema validation     — malformed actions are unrepresentable;
 *   2. policy enforcement    — unauthorized actions are blocked, not advised;
 *   3. budget guards         — cost/iteration ceilings trip in code;
 *   4. postcondition checks  — claimed effects are verified independently.
 *
 * An action passes ALL layers or it does not run. Denials are typed
 * PolicyErrors with evidence, so refusals are auditable, not vibes.
 */

import type { z } from "zod";
import { PolicyError, ReasoningError } from "../errors/taxonomy.js";

export interface ActionProposal<A = unknown> {
  /** What the agent intends to do, e.g. "refund.create", "file.delete". */
  readonly kind: string;
  readonly actor: string;
  readonly payload: A;
}

/**
 * Layers are deliberately non-generic: they compose in one ordered pipeline.
 * Put schemaLayer FIRST so later layers can narrow the payload safely —
 * the ordering is part of the design, not a convention.
 */
export interface EnforcementLayer {
  readonly name: string;
  /** Return undefined to allow, or a reason string to deny. */
  readonly check: (action: ActionProposal) => string | undefined | Promise<string | undefined>;
}

export interface EnforcementDecision {
  readonly allowed: boolean;
  readonly deniedBy?: string;
  readonly reason?: string;
}

/** Run layers in order; first denial wins. Order: cheapest, most certain first. */
export async function enforce<A>(
  action: ActionProposal<A>,
  layers: readonly EnforcementLayer[],
): Promise<EnforcementDecision> {
  for (const layer of layers) {
    const reason = await layer.check(action);
    if (reason !== undefined) {
      return { allowed: false, deniedBy: layer.name, reason };
    }
  }
  return { allowed: true };
}

/** Enforce or throw. Use at the point of no return, not three calls earlier. */
export async function enforceOrThrow<A>(action: ActionProposal<A>, layers: readonly EnforcementLayer[]): Promise<void> {
  const decision = await enforce(action, layers);
  if (!decision.allowed) {
    throw new PolicyError(
      `Action "${action.kind}" by "${action.actor}" denied at layer "${decision.deniedBy ?? "unknown"}": ${decision.reason ?? "no reason recorded"}`,
      {
        sideEffect: "none",
        blastRadius: "local",
        code: "policy.enforcement_denied",
        evidence: [`kind=${action.kind}`, `actor=${action.actor}`, `layer=${decision.deniedBy ?? "?"}`],
      },
    );
  }
}

/** Layer factory: payload schema validation. */
export function schemaLayer(name: string, schema: z.ZodType<unknown>): EnforcementLayer {
  return {
    name,
    check: (action) => {
      const parsed = schema.safeParse(action.payload);
      if (parsed.success) return undefined;
      return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    },
  };
}

/** Layer factory: allowlist of action kinds per actor. */
export function authorizationLayer(permissions: Readonly<Record<string, readonly string[]>>): EnforcementLayer {
  return {
    name: "authorization",
    check: (action) => {
      const allowed = permissions[action.actor] ?? [];
      return allowed.includes(action.kind)
        ? undefined
        : `actor "${action.actor}" may not perform "${action.kind}" (allowed: ${allowed.join(", ") || "nothing"})`;
    },
  };
}

/**
 * Layer factory: deterministic budget ceiling, e.g. max refund amount.
 * `extractAmount` narrows the payload — safe when a schemaLayer ran first.
 */
export function budgetLayer(
  name: string,
  extractAmount: (payload: unknown) => number,
  ceiling: number,
): EnforcementLayer {
  return {
    name,
    check: (action) => {
      const amount = extractAmount(action.payload);
      return amount <= ceiling
        ? undefined
        : `amount ${String(amount)} exceeds deterministic ceiling ${String(ceiling)}`;
    },
  };
}

/**
 * Postcondition verification AFTER a high-stakes action ran. The action's
 * own success response is not evidence; this re-reads the world.
 */
export async function verifyPostcondition(description: string, check: () => Promise<true | string>): Promise<void> {
  const verdict = await check();
  if (verdict !== true) {
    throw new ReasoningError(`Postcondition failed: ${description} — ${verdict}`, {
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "workflow",
      code: "reasoning.postcondition_failed",
      evidence: [verdict],
    });
  }
}
