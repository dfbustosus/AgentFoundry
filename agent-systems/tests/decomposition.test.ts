import { describe, expect, it } from "vitest";
import { executeGraph, TaskGraph, type TaskNode } from "../src/core/decomposition/graph.js";
import { parallel, sequential } from "../src/core/decomposition/patterns.js";

function node(id: string, dependsOn: readonly string[], run: () => Promise<unknown>): TaskNode {
  return { id, objective: `do ${id}`, dependsOn, run };
}

describe("TaskGraph validation", () => {
  it("computes topological layers", () => {
    const graph = new TaskGraph()
      .add(node("a", [], async () => 1))
      .add(node("b", ["a"], async () => 2))
      .add(node("c", ["a"], async () => 3))
      .add(node("d", ["b", "c"], async () => 4));
    expect(graph.layers()).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("rejects dependencies on unknown tasks", () => {
    const graph = new TaskGraph().add(node("a", ["ghost"], async () => 1));
    expect(() => graph.layers()).toThrowError(/unknown tasks/);
  });

  it("rejects cycles", () => {
    const graph = new TaskGraph()
      .add(node("a", ["b"], async () => 1))
      .add(node("b", ["a"], async () => 2));
    expect(() => graph.layers()).toThrowError(/cycle/);
  });

  it("rejects duplicate ids", () => {
    const graph = new TaskGraph().add(node("a", [], async () => 1));
    expect(() => graph.add(node("a", [], async () => 2))).toThrowError(/Duplicate/);
  });
});

describe("executeGraph", () => {
  it("passes dependency outputs to dependents", async () => {
    const graph = new TaskGraph()
      .add(node("a", [], async () => 2))
      .add({
        id: "b",
        objective: "double a",
        dependsOn: ["a"],
        run: async (inputs) => (inputs["a"] as number) * 2,
      });
    const result = await executeGraph(graph);
    expect(result.ok).toBe(true);
    expect(result.outputs["b"]).toBe(4);
  });

  it("skips dependents of a failed task but continues unrelated branches", async () => {
    const order: string[] = [];
    const graph = new TaskGraph()
      .add({
        id: "bad",
        objective: "fails",
        dependsOn: [],
        run: async () => {
          throw new Error("boom");
        },
      })
      .add(node("child-of-bad", ["bad"], async () => "never"))
      .add({
        id: "independent",
        objective: "fine",
        dependsOn: [],
        run: async () => {
          order.push("independent");
          return "ok";
        },
      });
    const result = await executeGraph(graph);
    expect(result.failed).toEqual(["bad"]);
    expect(result.skipped).toEqual(["child-of-bad"]);
    expect(result.records["child-of-bad"]?.reason).toContain('"bad" failed');
    expect(result.outputs["independent"]).toBe("ok");
    expect(result.ok).toBe(false);
  });

  it("abort-graph stops scheduling subsequent layers", async () => {
    const graph = new TaskGraph()
      .add({
        id: "fatal",
        objective: "fails fatally",
        dependsOn: [],
        onFailure: "abort-graph",
        run: async () => {
          throw new Error("fatal");
        },
      })
      .add(node("later", ["fatal"], async () => "never"));
    const result = await executeGraph(graph);
    expect(result.records["later"]?.reason).toContain("aborted");
  });

  it("bounds concurrency within a layer", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const graph = new TaskGraph();
    for (let i = 0; i < 6; i++) {
      graph.add({
        id: `t${i}`,
        objective: "work",
        dependsOn: [],
        run: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight -= 1;
          return i;
        },
      });
    }
    await executeGraph(graph, { concurrency: 2 });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("pattern constructors", () => {
  it("sequential chains stage outputs", async () => {
    const graph = sequential([
      { id: "fetch", objective: "get number", run: async () => 5 },
      { id: "double", objective: "double it", run: async (n) => (n as number) * 2 },
      { id: "label", objective: "label it", run: async (n) => `value=${String(n)}` },
    ]);
    const result = await executeGraph(graph);
    expect(result.outputs["label"]).toBe("value=10");
  });

  it("parallel fans out into a fan-in barrier receiving all branch outputs", async () => {
    const graph = parallel(
      [
        { id: "left", objective: "l", run: async () => 1 },
        { id: "right", objective: "r", run: async () => 2 },
      ],
      {
        id: "merge",
        objective: "sum branches",
        run: async (inputs) => (inputs["left"] as number) + (inputs["right"] as number),
      },
    );
    const result = await executeGraph(graph);
    expect(result.outputs["merge"]).toBe(3);
  });
});
