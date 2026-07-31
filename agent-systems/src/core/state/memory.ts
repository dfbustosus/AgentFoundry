/**
 * State separated by lifetime.
 *
 * - In-context: the message history and small working sets. Never a database.
 * - Session state: the current task ledger, plan, recent observations —
 *   bounded, checkpointed, resumable.
 * - External memory: durable decisions, artifact pointers, business records.
 *   This module defines the store interface and two implementations.
 *
 * One source of truth per mutable field. Secrets and personal data do not
 * belong here without a defined need, access policy, and retention plan.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EnvironmentError } from "../errors/taxonomy.js";

export interface MemoryStore {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<readonly string[]>;
}

export class InMemoryStore implements MemoryStore {
  private readonly data = new Map<string, Map<string, unknown>>();

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.data.get(namespace)?.get(key) as T | undefined;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    let ns = this.data.get(namespace);
    if (ns === undefined) {
      ns = new Map<string, unknown>();
      this.data.set(namespace, ns);
    }
    ns.set(key, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.data.get(namespace)?.delete(key);
  }

  async keys(namespace: string): Promise<readonly string[]> {
    return [...(this.data.get(namespace)?.keys() ?? [])];
  }
}

/**
 * File-backed store: one JSON document per namespace, written atomically
 * (tmp file + rename) so a crash mid-write cannot corrupt prior state.
 */
export class FileStore implements MemoryStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(namespace: string): string {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(namespace)) {
      throw new EnvironmentError(`Invalid namespace "${namespace}".`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "environment.invalid_namespace",
        evidence: ["Namespaces map to file names; allowlist: [a-z0-9-_]"],
      });
    }
    return join(this.rootDir, `${namespace}.json`);
  }

  private async readAll(namespace: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.pathFor(namespace), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new EnvironmentError(`Corrupt store for namespace "${namespace}": expected a JSON object.`, {
          retryable: false,
          sideEffect: "none",
          blastRadius: "local",
          code: "environment.corrupt_store",
        });
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
      throw err;
    }
  }

  private async writeAll(namespace: string, data: Record<string, unknown>): Promise<void> {
    const path = this.pathFor(namespace);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path); // atomic on POSIX: readers see old or new, never partial
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const all = await this.readAll(namespace);
    return all[key] as T | undefined;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const all = await this.readAll(namespace);
    all[key] = value;
    await this.writeAll(namespace, all);
  }

  async delete(namespace: string, key: string): Promise<void> {
    const all = await this.readAll(namespace);
    if (key in all) {
      delete all[key];
      await this.writeAll(namespace, all);
    }
  }

  async keys(namespace: string): Promise<readonly string[]> {
    return Object.keys(await this.readAll(namespace));
  }
}
