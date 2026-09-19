import { createTaskWorkerPool } from "../../../../rix/src/runtime/task-worker-pool.js";
/** Vite emits a local module worker; no network or file grants are inherited. */
export function createNotebookTaskWorkers() {
  if (typeof Worker === "undefined") return null;
  return createTaskWorkerPool({ workerFactory: () => new Worker(new URL("../../../../rix/src/runtime/task-worker-entry.js", import.meta.url), { type: "module" }), maxWorkers: 2, maxQueued: 64 });
}
