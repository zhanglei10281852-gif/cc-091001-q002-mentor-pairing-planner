import test from 'node:test';
import assert from 'node:assert/strict';
import { Service, ConflictError, ValidationError } from '../src/service.js';
import { Store } from '../src/store.js';

function makeService() {
  const service = new Service(new Store(null), { invitationTtlDays: 14 });
  return service;
}

async function seed(service) {
  await service.importData(
    {
      teachers: [
        { id: 'T-1', name: '王一', subject: 'physics', school: 'S-01', token: 'tok-t1' },
        { id: 'T-2', name: '王二', subject: 'physics', school: 'S-02', token: 'tok-t2' },
        { id: 'T-3', name: '王三', subject: 'math', school: 'S-03', token: 'tok-t3' },
        { id: 'T-4', name: '王四', subject: 'physics', school: 'S-09', token: 'tok-t4' },
      ],
      mentors: [
        { id: 'M-1', name: '导师甲', subjects: ['physics'], school: 'S-07', capacity: 2, token: 'tok-m1' },
        { id: 'M-2', name: '导师乙', subjects: ['math'], school: 'S-08', capacity: 1, token: 'tok-m2' },
      ],
      compatibility: {},
      avoidances: [],
      preferences: [{ teacherId: 'T-1', mentorId: 'M-1', kind: 'prior-collaboration' }],
    },
    'admin'
  );
}

test('草案试排：求解结果即时返回，不改变计划版本', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft({ name: 'A版' });
  const v = draft.plan.version;
  const preview = service.previewPlan(draft.plan.id);
  assert.equal(preview.result.summary.matchedCount, 3); // T-4 无物理容量/无对应导师则看容量
  const after = service.getPlan(draft.plan.id);
  assert.equal(after.plan.version, v);
});

test('锁定人工安排后继续求解剩余人员；硬约束不允许的锁定被拒绝', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const updated = await service.lockPair(draft.plan.id, draft.plan.version, 'T-3', 'M-2');
  assert.equal(updated.plan.version, draft.plan.version + 1);
  const preview = service.previewPlan(draft.plan.id);
  const locked = preview.result.matches.find((m) => m.teacherId === 'T-3');
  assert.equal(locked.mentorId, 'M-2');
  assert.equal(locked.source, 'manual-lock');

  // 同校回避：T-1 与任何同校导师——这里构造不兼容锁定（学科不符）
  await assert.rejects(() => service.lockPair(draft.plan.id, updated.plan.version, 'T-1', 'M-2'), ValidationError);
});

test('排除设置写入后即时求解生效；与锁定冲突时被拒绝', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const updated = await service.setExcluded(draft.plan.id, draft.plan.version, { mentorIds: ['M-1'] });
  const preview = service.previewPlan(draft.plan.id);
  assert.ok(!preview.result.matches.some((m) => m.mentorId === 'M-1'));
  // M-1 被排除后物理教师无导师可配
  assert.ok(preview.result.unmatched.some((u) => u.teacherId === 'T-1'));
  // 锁定与排除冲突：即使版本正确也拒绝，避免锁定悄悄失效
  const locked = await service.lockPair(draft.plan.id, updated.plan.version, 'T-3', 'M-2');
  await assert.rejects(() => service.setExcluded(draft.plan.id, locked.plan.version, { mentorIds: ['M-2'] }), ConflictError);
});

test('两位管理员同时调整：旧版本写入被拒绝，不会悄悄覆盖', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const v = draft.plan.version;
  await service.setStrategy(draft.plan.id, v, 'preference-first', '管理员甲');
  // 管理员乙仍拿着 v
  await assert.rejects(() => service.lockPair(draft.plan.id, v, 'T-1', 'M-1', '管理员乙'), ConflictError);
});

test('完整流程：发布→双方独立确认→接受→培养记录生成并追溯发布版本', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  assert.equal(published.plan.state, 'collecting-confirmations');
  assert.ok(published.plan.releaseVersion === 1);
  // T-4 无对应可行导师（M-1 容量2 已被 T-1/T-2 占满），应进候补
  const waiting = service.waitlist().filter((w) => w.status === 'waiting').map((w) => w.teacherId);
  assert.ok(waiting.includes('T-4'));

  const inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');
  // 导师先接受
  const afterMentor = await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  assert.equal(afterMentor.overallStatus, 'pending'); // 教师尚未确认
  assert.equal(afterMentor.mentorResponse.state, 'accepted');
  assert.equal(afterMentor.teacherResponse, null); // 不覆盖教师字段
  assert.equal(afterMentor.version, 2);

  // 教师用旧版本确认 → 冲突
  await assert.rejects(
    () => service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 1, actor: 'T-1' }),
    ConflictError
  );
  const done = await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });
  assert.equal(done.overallStatus, 'accepted');
  assert.ok(done.enrollmentId);

  const view = service.teacherView('T-1');
  const enr = view.enrollments.find((e) => e.id === done.enrollmentId);
  assert.equal(enr.status, 'active');
  assert.equal(enr.releaseVersion, 1);
  assert.equal(enr.invitationId, inv.id); // 任何调换都能追溯到确认过程
});

test('一方拒绝：邀请终结且教师进入候补；原确认结果保留在历史中', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = published.createdInvitations.find((i) => i.teacherId === 'T-2');
  await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  // 导师改主意：改答拒绝，原接受进入历史
  const declined = await service.respondInvitation(inv.id, 'mentor', 'declined', { expectedVersion: 2, actor: 'M-1' });
  assert.equal(declined.overallStatus, 'declined');
  const raw = service.store.state.invitations.find((i) => i.id === inv.id);
  assert.equal(raw.mentorHistory.length, 1);
  assert.equal(raw.mentorHistory[0].state, 'accepted');
  assert.ok(service.waitlist().some((w) => w.teacherId === 'T-2' && w.status === 'waiting'));
  // 尚未生成培养记录
  assert.equal(service.teacherView('T-2').enrollments.length, 0);
});

test('候补再分配：成功接受后候补 fulfilled；再被拒绝则回到 waiting', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  await service.publishDraft(draft.plan.id, draft.plan.version);
  // T-4 已在候补；导师扩容后补排
  service.store.state.mentors.find((m) => m.id === 'M-1').capacity = 3;
  const w = service.waitlist().find((x) => x.teacherId === 'T-4');
  const inv = await service.assignFromWaitlist(w.id, 'M-1');
  assert.equal(inv.source, 'waitlist-assignment');
  assert.equal(service.waitlist().find((x) => x.id === w.id).status, 'fulfilled');
  await service.respondInvitation(inv.id, 'mentor', 'declined', { expectedVersion: 1, actor: 'M-1' });
  assert.equal(service.waitlist().find((x) => x.id === w.id).status, 'waiting');
});

test('换导师：原培养记录终结保留，新邀请带依据(reason)，审计链完整', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');
  await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });
  const enrId = service.getInvitation(inv.id).enrollmentId;

  // 无理由的调换被拒绝
  await assert.rejects(() => service.reassign('T-1', 'M-1', ''), ValidationError);
  // 新增物理导师 M-3 后调换
  await service.importData(
    {
      teachers: service.store.state.teachers,
      mentors: [
        ...service.store.state.mentors,
        { id: 'M-3', name: '导师丙', subjects: ['physics'], school: 'S-05', capacity: 1, token: 'tok-m3' },
      ],
    },
    'admin'
  );
  const newInv = await service.reassign('T-1', 'M-3', '原导师临时工作调整');
  assert.equal(newInv.source, 'reassignment');
  assert.equal(newInv.reason, '原导师临时工作调整');

  await service.respondInvitation(newInv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-3' });
  await service.respondInvitation(newInv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });

  const freshInv = service.getInvitation(inv.id);
  const old = service.store.state.enrollments.find((e) => e.id === freshInv.enrollmentId);
  assert.equal(old.status, 'ended');
  assert.equal(old.endReason, 'reassignment');
  assert.equal(old.endHistory[0].newMentorId, 'M-3');

  const view = service.teacherView('T-1');
  assert.equal(view.enrollments.length, 2); // 旧记录仍在
  assert.equal(view.enrollments.filter((e) => e.status === 'active').length, 1);
  assert.equal(view.enrollments.find((e) => e.status === 'active').mentorId, 'M-3');

  const audit = service.audit({ entityId: newInv.id });
  assert.ok(audit.some((e) => e.action === 'reassignment'));
  assert.ok(audit.some((e) => e.details.reason === '原导师临时工作调整'));
});

test('教师退出：取消待处理邀请、终结在培记录，已完成的历史记录不删除', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');
  await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });
  await service.teacherExit('T-1', '个人原因离职');
  const view = service.teacherView('T-1');
  assert.equal(view.teacher.active, false);
  assert.equal(view.enrollments[0].status, 'ended');
  assert.equal(view.enrollments[0].endReason, 'teacher-exit');
  assert.ok(view.enrollments[0].startedAt); // 培养记录仍可查
});

test('导师临时停带：取消待处理邀请，在培培养记录不受破坏；恢复后可继续', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');
  await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-1' });
  await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-1' });
  const enrId = service.getInvitation(inv.id).enrollmentId;

  // T-3 对 M-2 的邀请还挂着时 M-2 停带
  const pending = published.createdInvitations.find((i) => i.teacherId === 'T-3');
  await service.mentorPause('M-2', '出差一学期');
  assert.equal(service.getInvitation(pending.id).lifecycleStatus, 'cancelled');
  assert.ok(service.waitlist().some((w) => w.teacherId === 'T-3' && w.status === 'waiting'));
  // T-1 已在培，记录不变
  const enr = service.store.state.enrollments.find((e) => e.id === enrId);
  assert.equal(enr.status, 'active');
  assert.equal(enr.mentorId, 'M-1'); // T-1 的在培记录不受 M-2 停带影响
  await service.mentorResume('M-2');
  assert.equal(service.store.state.mentors.find((m) => m.id === 'M-2').status, 'active');
});

test('过期邀请进入候补', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const inv = service.store.state.invitations.find(
    (i) => i.teacherId === 'T-3' && i.planId === published.plan.id
  );
  const expired = await service.expireInvitations(new Date(Date.now() + 20 * 24 * 3600 * 1000));
  assert.ok(expired.includes(inv.id));
  assert.equal(service.getInvitation(inv.id).overallStatus, 'expired');
  assert.ok(service.waitlist().some((w) => w.teacherId === 'T-3'));
});

test('全部邀请有结果后可定稿为 published；仍有 pending 时被拒绝', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  await assert.rejects(() => service.finalizeRelease(published.plan.id), ConflictError);
  for (const inv of published.createdInvitations) {
    const raw = service.store.state.invitations.find((i) => i.id === inv.id);
    await service.respondInvitation(inv.id, 'mentor', 'accepted', { expectedVersion: raw.version, actor: inv.mentorId });
    const v2 = service.getInvitation(inv.id).version;
    await service.respondInvitation(inv.id, 'teacher', 'accepted', { expectedVersion: v2, actor: inv.teacherId });
  }
  const finalized = await service.finalizeRelease(published.plan.id);
  assert.equal(finalized.plan.state, 'published');
});

test('教师只能看到与自己有关的结果', async () => {
  const service = makeService();
  await seed(service);
  const draft = await service.createDraft();
  const published = await service.publishDraft(draft.plan.id, draft.plan.version);
  const t1Inv = published.createdInvitations.find((i) => i.teacherId === 'T-1');
  const t2View = service.teacherView('T-2');
  assert.ok(!t2View.invitations.some((i) => i.id === t1Inv.id));
});
