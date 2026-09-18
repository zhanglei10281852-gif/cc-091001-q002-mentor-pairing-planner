// 简单的 JSON 文件存储：所有写操作串行提交，整库带版本号；
// 计划级乐观锁在 service 层基于 plan.version 实现。
// 每次提交可附带审计事件，审计只追加、不修改、不删除。

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

export function emptyState() {
  return {
    version: 0,
    teachers: [], // {id, name, subject, school, active, exitAt, token}
    mentors: [], // {id, name, subjects, school, capacity, status:'active'|'paused', pausedAt, token}
    // 学科兼容：compatibility[from] 包含 to 时视为兼容（匹配时按对称关系处理）
    compatibility: {},
    avoidances: [], // {teacherId, mentorId, reason?}
    preferences: [], // {teacherId, mentorId, kind}
    plans: [],
    invitations: [], // 邀请（含双方各自的确认结果与历史）
    enrollments: [], // 培养记录：一旦生成只追加/终结，不删除
    waitlist: [], // {id, teacherId, planId, status:'waiting'|'fulfilled'|'cancelled', createdAt, history:[]}
    audit: [],
  };
}

export class Store {
  constructor(path, state = emptyState()) {
    this.path = path; // 可为 null：仅内存
    this.state = state;
    this._chain = Promise.resolve();
  }

  static async load(path) {
    let state;
    try {
      state = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      state = emptyState();
    }
    return new Store(path, state);
  }

  async save() {
    if (!this.path) return;
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.path);
  }

  // mutator 直接修改传入的状态对象，返回：
  //   { action, details, planId? } 或该对象数组（多条审计），或 undefined（不记审计）
  async revise(mutator, { actor = 'system' } = {}) {
    const release = await this._acquire();
    try {
      const produced = await mutator(this.state);
      this.state.version += 1;
      const events = produced == null ? [] : Array.isArray(produced) ? produced : [produced];
      for (const ev of events) {
        this.state.audit.push({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          version: this.state.version,
          ...ev,
        });
      }
      await this.save();
      return { version: this.state.version, events };
    } finally {
      release();
    }
  }

  // 串行化所有写操作，避免两个提交交错写盘/互相覆盖。
  _acquire() {
    let release;
    const prev = this._chain;
    this._chain = new Promise((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }
}
