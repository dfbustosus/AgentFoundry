/**
 * Clean-room package consumer verification.
 *
 * Proves the generated tarball — not workspace source — can be installed,
 * typechecked under strict TypeScript, and executed by a separate Node app.
 * Temporary artifacts are deleted even when a check fails.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumerTypeScriptVersion = process.env.CONSUMER_TYPESCRIPT_VERSION ?? "5.9.3";

if (!/^\d+\.\d+\.\d+$/.test(consumerTypeScriptVersion)) {
  throw new Error(`CONSUMER_TYPESCRIPT_VERSION must be an exact version, received: ${consumerTypeScriptVersion}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), "agent-systems-consumer-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}\n${detail}`);
  }
  return result.stdout ?? "";
}

try {
  await mkdir(packDir);
  await mkdir(consumerDir);

  console.log("[package] packing publishable tarball");
  const packOutput = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", packDir],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const filename = packOutput.trim().split("\n").at(-1);
  if (!filename?.endsWith(".tgz")) throw new Error(`npm pack returned no tarball: ${packOutput}`);
  const tarball = join(packDir, filename);

  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "agent-systems-foundry-consumer-contract",
        private: true,
        type: "module",
        dependencies: {
          "agent-systems-foundry": `file:${tarball}`,
          zod: "4.4.3",
        },
        devDependencies: {
          "@types/node": "24.13.3",
          typescript: consumerTypeScriptVersion,
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          outDir: "dist",
        },
        include: ["index.ts"],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(consumerDir, "index.ts"),
    `import {
  ApprovalGate,
  TaskGraph,
  defineContractTool,
  executeGraph,
  loadEnv,
  RetryAbortedError,
  withRetry,
  type ContractToolOptions,
  type LoopTransition,
  type RetryPolicy,
  type RetrySleep,
  type Tool,
} from "agent-systems-foundry";
import { z } from "zod";

const toolOptions: ContractToolOptions = { context: { agentId: "consumer", writeScopes: [] } };
const retryPolicy: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 10,
  maxDelayMs: 100,
  maxElapsedMs: 1_000,
  sideEffectSafe: true,
};
const retrySleep: RetrySleep = async () => {};

const double = defineContractTool<{ n: number }, { result: number }>({
  name: "double",
  description: "Doubles a number.",
  input: z.object({ n: z.number() }),
  output: z.object({ result: z.number() }),
  sideEffect: "read-only",
  idempotent: true,
  execute: async ({ n }, _context, signal) => {
    if (!(signal instanceof AbortSignal)) throw new Error("Tool execution signal missing");
    return { result: n * 2 };
  },
}, toolOptions);

const typedTool: Tool<{ n: number }, { result: number }> = double;
const executePackagedTool = (typedTool as {
  execute?: (input: { n: number }, options: unknown) => Promise<{ result: number }>;
}).execute;
if (executePackagedTool === undefined) throw new Error("Packaged tool execute export missing");
const doubled = await executePackagedTool({ n: 21 }, { toolCallId: "consumer-tool", messages: [] });
if (doubled.result !== 42) throw new Error("Packaged tool runtime contract failed");

const retried = await withRetry(
  "consumer-retry",
  async ({ signal }) => {
    if (!(signal instanceof AbortSignal)) throw new Error("Retry signal missing");
    return 7;
  },
  retryPolicy,
  retrySleep,
);
if (retried.value !== 7 || retried.attempts !== 1) throw new Error("Packaged retry runtime contract failed");

// @ts-expect-error — public union must reject unknown transitions.
const invalidTransition: LoopTransition = "keep-going";
void invalidTransition;

const graph = new TaskGraph().add({
  id: "answer",
  objective: "Produce an inspectable output",
  dependsOn: [],
  run: async () => 42,
});
const graphResult = await executeGraph(graph);
if (graphResult.outputs.answer !== 42) throw new Error("TaskGraph runtime contract failed");

const approval = new ApprovalGate(async (request) => ({
  requestId: request.id,
  approved: true,
  approver: "consumer-test",
  decidedAt: new Date().toISOString(),
}));
await approval.requireApproval(
  { kind: "consumer.verify", actor: "consumer", payload: {} },
  "verify packaged approval API",
);

const env = loadEnv({ AGENT_SYSTEMS_MOCK: "1" });
if (env.AGENT_SYSTEMS_MODEL !== "gpt-4o-mini") throw new Error("Config runtime contract failed");
if (typeof RetryAbortedError !== "function") throw new Error("RetryAbortedError runtime export missing");

console.log("consumer-contract: OK");
`,
  );

  console.log("[package] installing tarball in clean consumer");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerDir);

  const tsc = join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const compiler = run(tsc, ["--version"], consumerDir, { capture: true }).trim();
  console.log(`[package] typechecking public API from clean consumer with ${compiler}`);
  run(tsc, ["-p", "tsconfig.json"], consumerDir);

  console.log("[package] executing compiled consumer");
  run(process.execPath, [join(consumerDir, "dist", "index.js")], consumerDir);

  console.log("[package] consumer contract verified");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
