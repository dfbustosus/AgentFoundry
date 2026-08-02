/**
 * Example smoke tests: every example executes end-to-end, offline.
 *
 * AGENT_SYSTEMS_MOCK=1 substitutes a deterministic mock model (see
 * examples/lib/shared.ts), so these runs exercise the real wiring — imports,
 * loop, orchestration, handoffs, state — without a key or network.
 *
 * Example 14 (MCP) is intentionally excluded: it spawns an external MCP
 * server package via npx, which requires network access and a local
 * directory argument. It is type-checked like everything else; run it
 * manually per its header instructions. This boundary is recorded as R4.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const EXAMPLES_DIR = join(__dirname, "..", "examples");
const OFFLINE_EXCLUDED = new Set(["14-mcp-tools.ts"]);

const examples = readdirSync(EXAMPLES_DIR)
  .filter((f) => /^\d{2}-.+\.ts$/.test(f))
  .filter((f) => !OFFLINE_EXCLUDED.has(f))
  .sort();

describe("example smoke tests (offline, mocked model)", () => {
  it("discovers the expected example set", () => {
    expect(examples.length).toBe(17);
    expect(examples).toContain("01-prao-loop.ts");
    expect(examples).toContain("18-evals.ts");
  });

  for (const file of examples) {
    it(
      `${file} runs to completion with exit code 0`,
      async () => {
        const { stdout, stderr } = await execFileAsync(
          "npx",
          ["tsx", join(EXAMPLES_DIR, file)],
          {
            env: { ...process.env, AGENT_SYSTEMS_MOCK: "1" },
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        expect(stdout.length).toBeGreaterThan(0);
        expect(stdout).not.toContain("Example failed:");
        expect(stderr).not.toContain("OPENAI_API_KEY");
      },
      90_000,
    );
  }
});
