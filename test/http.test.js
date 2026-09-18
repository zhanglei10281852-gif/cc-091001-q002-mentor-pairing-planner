import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';

async function startServer() {
  const service = new Service(new Store(null), { invitationTtlDays: 14 });
  await service.importData(
    {
      teachers: [
        { id: 'T-1', name: '王一', subject: 'physics', school: 'S-01', token: 'tok-t1' },
        { id: 'T-2', name: '王二', subject: 'physics', school: 'S-02', token: 'tok-t2' },
      ],
      mentors: [{ id: 'M-1', name: '导师甲', subjects: ['physics'], school: 'S-07', capacity: 2, token: 'tok-m1' }],
      compatibility: {},
      avoidances: [],
      preferences: [],
    },
    'admin'
  );
  const server = createApp(service, { adminToken: 'test-admin' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, service };
}

test('管理端需要令牌；健康检查公开', async () => {
  const { server, base } = await startServer();
  try {
    const noToken = await fetch(`${base}/api/admin/plans`);
    assert.equal(noToken.status, 401);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const ok = await fetch(`${base}/api/admin/plans`, { headers: { 'x-admin-token': 'test-admin' } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test('两位管理员并发编辑：同版本只有一个成功，另一个 409，不发生覆盖', async () => {
  const { server, base } = await startServer();
  try {
    const admin = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/admin/plans`, { method: 'POST', headers: admin, body: JSON.stringify({}) });
    assert.equal(created.status, 201);
    const etag = created.headers.get('etag');
    assert.match(etag, /W\/"\d+"/);
    const { plan } = await created.json();

    const update = (strategy) =>
      fetch(`${base}/api/admin/plans/${plan.id}/strategy`, {
        method: 'PUT',
        headers: { ...admin, 'if-match': etag },
        body: JSON.stringify({ strategy }),
      });

    const [a, b] = await Promise.all([update('preference-first'), update('max-match')]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    server.close();
  }
});

test('发布与确认全链路经 HTTP 完成；教师只看到本人数据且不能代答他人邀请', async () => {
  const { server, base, service } = await startServer();
  try {
    const admin = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' };
    const created = await (await fetch(`${base}/api/admin/plans`, { method: 'POST', headers: admin, body: JSON.stringify({}) })).json();
    const pid = created.plan.id;
    const ver = created.plan.version;

    const pub = await fetch(`${base}/api/admin/plans/${pid}/publish`, { method: 'POST', headers: { ...admin, 'if-match': `"${ver}"` } });
    assert.equal(pub.status, 200);
    const published = await pub.json();
    const inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');

    // 教师本人视图
    const me = await (await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer tok-t1' } })).json();
    assert.equal(me.invitations.length, 1);
    assert.equal(me.invitations[0].id, inv.id);
    const me2 = await (await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer tok-t2' } })).json();
    assert.ok(!me2.invitations.some((i) => i.id === inv.id));

    const respond = (token, response, version) =>
      fetch(`${base}/api/invitations/${inv.id}/respond`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': `"${version}"` },
        body: JSON.stringify({ response }),
      });

    // T-2 不能代答 T-1 的邀请
    const forbidden = await respond('tok-t2', 'accepted', 1);
    assert.equal(forbidden.status, 403);
    // 缺少 If-Match → 428
    const noVersion = await fetch(`${base}/api/invitations/${inv.id}/respond`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-m1', 'content-type': 'application/json' },
      body: JSON.stringify({ response: 'accepted' }),
    });
    assert.equal(noVersion.status, 428);

    const mentorOk = await respond('tok-m1', 'accepted', 1);
    assert.equal(mentorOk.status, 200);
    const teacherOk = await respond('tok-t1', 'accepted', 2);
    assert.equal(teacherOk.status, 200);
    const finalInv = await teacherOk.json();
    assert.equal(finalInv.overallStatus, 'accepted');

    // 再答一次：邀请已结束 → 409
    const again = await respond('tok-t1', 'accepted', 3);
    assert.equal(again.status, 409);

    const enrollments = service.teacherView('T-1').enrollments;
    assert.equal(enrollments.length, 1);
    assert.equal(enrollments[0].releaseVersion, 1);
  } finally {
    server.close();
  }
});

test('换导师接口要求依据，成功后审计可查', async () => {
  const { server, base, service } = await startServer();
  try {
    const admin = { 'x-admin-token': 'test-admin', 'content-type': 'application/json' };
    const created = await (await fetch(`${base}/api/admin/plans`, { method: 'POST', headers: admin, body: JSON.stringify({}) })).json();
    const published = await (
      await fetch(`${base}/api/admin/plans/${created.plan.id}/publish`, {
        method: 'POST',
        headers: { ...admin, 'if-match': `"${created.plan.version}"` },
      })
    ).json();
    const inv = published.createdInvitations[0];
    const respond = async (token, response, version) => {
      const r = await fetch(`${base}/api/invitations/${inv.id}/respond`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': `"${version}"` },
        body: JSON.stringify({ response }),
      });
      assert.equal(r.status, 200);
    };
    await respond('tok-m1', 'accepted', 1);
    await respond('tok-t1', 'accepted', 2);

    // 新增 M-2
    service.store.state.mentors.push({ id: 'M-2', name: '导乙', subjects: ['physics'], school: 'S-09', capacity: 1, status: 'active', token: 'tok-m2' });

    const noReason = await fetch(`${base}/api/admin/reassign`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ teacherId: 'T-1', mentorId: 'M-2' }),
    });
    assert.equal(noReason.status, 400);

    const ok = await fetch(`${base}/api/admin/reassign`, {
      method: 'POST',
      headers: { 'x-admin-token': 'test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ teacherId: 'T-1', mentorId: 'M-2', reason: '学科方向调整', actor: '负责人' }),
    });
    assert.equal(ok.status, 200);
    const newInv = await ok.json();
    assert.equal(newInv.reason, '学科方向调整');

    const auditRes = await fetch(`${base}/api/admin/audit?entity=${newInv.id}`, { headers: { 'x-admin-token': 'test-admin' } });
    const { audit } = await auditRes.json();
    assert.ok(audit.some((e) => e.action === 'reassignment' && e.actor === '负责人'));
  } finally {
    server.close();
  }
});
