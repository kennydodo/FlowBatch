import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from '../lib/json.js';
import { nowIso } from '../lib/time.js';

export const STATUS = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

/**
 * Per-job progress that survives restarts, so `--resume` can skip finished work.
 */
export class RunState {
  constructor(filePath, { jobName, jobPath, items }) {
    this.filePath = filePath;
    this.data = {
      jobName,
      jobPath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: {},
    };
    for (const item of items) {
      this.data.items[item.id] = {
        status: STATUS.pending,
        attempts: 0,
        files: [],
        error: null,
        updatedAt: nowIso(),
      };
    }
  }

  static open(filePath, meta) {
    const state = new RunState(filePath, meta);
    const existing = readJson(filePath, { required: false });
    if (existing && existing.jobName === meta.jobName) {
      state.data.createdAt = existing.createdAt ?? state.data.createdAt;
      for (const [id, entry] of Object.entries(existing.items ?? {})) {
        if (id in state.data.items) {
          state.data.items[id] = { ...state.data.items[id], ...entry };
        }
      }
    }
    return state;
  }

  get(id) {
    return this.data.items[id];
  }

  isDone(id) {
    return this.data.items[id]?.status === STATUS.done;
  }

  update(id, patch) {
    const entry = this.data.items[id];
    if (!entry) return;
    Object.assign(entry, patch, { updatedAt: nowIso() });
    this.data.updatedAt = nowIso();
  }

  save() {
    writeJson(this.filePath, this.data);
  }

  counts() {
    const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const entry of Object.values(this.data.items)) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
  }

  reset(ids) {
    for (const id of ids) {
      this.update(id, { status: STATUS.pending, attempts: 0, files: [], error: null });
    }
  }

  static pathFor(stateDir, jobName) {
    return path.join(stateDir, `${jobName}.json`);
  }

  static exists(stateDir, jobName) {
    return fs.existsSync(RunState.pathFor(stateDir, jobName));
  }
}
