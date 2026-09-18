import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

test('状态写盘后重载：审计、版本与培养记录完整保留', async () => {
  const file = join(tmpdir(), `planner-${process.pid}-${Date.now()}.json`);
  const store = await Store.load(file);
  const service = new Service(store);
  await service.importData(
    {
      teachers: [{ id: 'T-1', subject: 'physics', school: 'S-01', token: 'a' }],
      mentors: [{ id: 'M-1', subjects: ['physics'], school: 'S-02', capacity: 1, token: 'b' }],
      compatibility: {},
      avoidances: [],
      preferences: [],
    },
    'admin'
  );
  const draft = await service.createDraft();
  await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = service.store.state.invitations[0];
  await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });

  const reloaded = await Store.load(file);
  assert.ok(reloaded.state.version >= store.state.version);
  assert.equal(reloaded.state.enrollments.length, 1);
  assert.equal(reloaded.state.enrollments[0].status, 'active');
  assert.ok(reloaded.state.audit.some((e) => e.action === 'plan-publish'));
  assert.ok(reloaded.state.audit.some((e) => e.action === 'enrollment-activate'));

  const service2 = new Service(reloaded);
  const view = service2.teacherView('T-1');
  assert.equal(view.enrollments[0].releaseVersion, 1);
});

test('审计只追加：任意业务操作后历史长度单调增长', async () => {
  const store = new Store(null);
  const service = new Service(store);
  await service.importData(
    {
      teachers: [{ id: 'T-1', subject: 'physics', school: 'S-01' }],
      mentors: [{ id: 'M-1', subjects: ['physics'], school: 'S-02', capacity: 1 }],
      compatibility: {},
      avoidances: [],
      preferences: [],
    },
    'admin'
  );
  const before = store.state.audit.length;
  const draft = await service.createDraft();
  await service.lockPair(draft.plan.id, draft.plan.version, 'T-1', 'M-1');
  await service.unlockPair(draft.plan.id, draft.plan.version + 1, 'T-1');
  assert.ok(store.state.audit.length > before);
  assert.deepEqual(
    store.state.audit.map((e) => e.action),
    [...store.state.audit.map((e) => e.action)].sort() // 顺序不要求，但无删除/改写：对象 id 唯一
  );
  const ids = store.state.audit.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
