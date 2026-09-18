import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlannerService } from '../src/planner.js';
import { createState } from '../src/store.js';
import { createApp, defaultTokens } from '../src/server.js';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/dataset.json', import.meta.url)));

async function startServer() {
  const service = new PlannerService(createState(dataset));
  const server = createApp(service, { tokens: defaultTokens(service.state) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function api(base, method, path, { token = 'admin-token', body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test('API：未认证与被越权访问被拒绝', async () => {
  const { server, base } = await startServer();
  try {
    assert.equal((await api(base, 'GET', '/plans', { token: null })).status, 401);
    assert.equal((await api(base, 'GET', '/plans', { token: 't-T-101' })).status, 403);
    assert.equal((await api(base, 'GET', '/nope')).status, 404);
  } finally {
    server.close();
  }
});

test('API：If-Match 版本冲突返回 409 与当前版本', async () => {
  const { server, base } = await startServer();
  try {
    const created = await api(base, 'POST', '/plans', { body: { name: '草案A' } });
    const planId = created.body.data.id;
    const solved = await api(base, 'POST', `/plans/${planId}/solve`, { headers: { 'if-match': '1' } });
    assert.equal(solved.status, 201);
    // 另一位管理员基于过期版本提交 → 409
    const stale = await api(base, 'POST', `/plans/${planId}/locks`, {
      headers: { 'if-match': '1' },
      body: { teacherId: 'T-104', mentorId: 'M-203' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.details.currentVersion, 2);
    // 基于最新版本重试成功
    const retry = await api(base, 'POST', `/plans/${planId}/locks`, {
      headers: { 'if-match': '2' },
      body: { teacherId: 'T-104', mentorId: 'M-203' },
    });
    assert.equal(retry.status, 201);
  } finally {
    server.close();
  }
});

test('API：完整流程与教师视角隔离', async () => {
  const { server, base } = await startServer();
  try {
    const created = await api(base, 'POST', '/plans', { body: { name: '2026 秋季结对' } });
    const planId = created.body.data.id;
    await api(base, 'POST', `/plans/${planId}/solve`, { body: {} });
    const invitations = (await api(base, 'POST', `/plans/${planId}/invitations`, { body: {} })).body.data;
    assert.equal(invitations.length, 7);

    // 教师不能回应别人的邀请
    const t101Invite = invitations.find((c) => c.teacherId === 'T-101');
    const wrongTeacher = await api(base, 'POST', `/confirmations/${t101Invite.id}/respond`, {
      token: 't-T-102',
      body: { accept: true },
    });
    assert.equal(wrongTeacher.status, 403);

    for (const c of invitations) {
      const res = await api(base, 'POST', `/confirmations/${c.id}/respond`, {
        token: `t-${c.teacherId}`,
        body: { accept: c.teacherId !== 'T-106' },
      });
      assert.equal(res.status, 201);
    }
    const published = await api(base, 'POST', `/plans/${planId}/publish`, { body: {} });
    assert.equal(published.body.data.state, 'published');

    // 教师视角：只能看到自己的结果
    const mine = await api(base, 'GET', '/me/result', { token: 't-T-105' });
    assert.equal(mine.body.data.teacher.id, 'T-105');
    assert.equal(mine.body.data.plans[0].waitlistPosition, 1);
    const serialized = JSON.stringify(mine.body.data);
    assert.ok(!serialized.includes('T-101'), '不应看到其他教师');

    // 审计轨迹记录关键事件
    const audit = await api(base, 'GET', `/plans/${planId}/audit`);
    const kinds = audit.body.data.map((e) => e.kind);
    assert.ok(kinds.includes('plan-solved'));
    assert.ok(kinds.includes('invitations-opened'));
    assert.ok(kinds.includes('plan-published'));
  } finally {
    server.close();
  }
});
