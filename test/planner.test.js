import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlannerService } from '../src/planner.js';
import { createState } from '../src/store.js';
import { ConflictError, ForbiddenError, StateError, ValidationError } from '../src/errors.js';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/dataset.json', import.meta.url)));

function makeService() {
  let tick = 0;
  const service = new PlannerService(createState(dataset), {
    now: () => `2026-09-17T09:00:${String(++tick).padStart(2, '0')}Z`,
  });
  return service;
}

const admin = { role: 'admin', id: 'admin' };
const adminB = { role: 'admin', id: 'admin-b' };
const teacher = (id) => ({ role: 'teacher', id });

// 走完 草案→求解→邀请→回应→发布 的完整流程；decliners 中的教师会谢绝邀请
function publishFlow(service, { decliners = [] } = {}) {
  const plan = service.createPlan(admin, { name: '2026 秋季结对' });
  service.solvePlan(admin, plan.id, { expectedVersion: 1 });
  const invitations = service.openInvitations(admin, plan.id, { expectedVersion: 2 });
  for (const c of invitations) {
    service.respondToConfirmation(teacher(c.teacherId), c.id, { accept: !decliners.includes(c.teacherId) });
  }
  const current = service.getPlan(plan.id);
  service.publishPlan(admin, plan.id, { expectedVersion: current.version });
  return service.getPlan(plan.id);
}

test('草案可反复试排，锁定后求解剩余人员', () => {
  const service = makeService();
  const plan = service.createPlan(admin, { name: '草案A' });
  const first = service.solvePlan(admin, plan.id, { expectedVersion: 1 });
  assert.equal(first.assignments.length, 7);
  assert.deepEqual(first.unmatched.map((u) => u.teacherId), ['T-105']);

  // 锁定 T-101→M-202（人工安排），重新求解剩余人员
  service.lockAssignment(admin, plan.id, { teacherId: 'T-101', mentorId: 'M-202', expectedVersion: 2 });
  const second = service.solvePlan(admin, plan.id, { expectedVersion: 3 });
  const locked = second.assignments.find((a) => a.teacherId === 'T-101');
  assert.equal(locked.mentorId, 'M-202');
  assert.equal(locked.source, 'manual');
  // 锁定后果可解释：M-202 被占，T-103 无处可去
  assert.deepEqual(second.unmatched.map((u) => u.teacherId), ['T-103']);
  assert.match(second.unmatched[0].summary, /容量已满/);
});

test('锁定违反硬约束被拒绝，允许显式覆盖并留痕', () => {
  const service = makeService();
  const plan = service.createPlan(admin, { name: '草案' });
  // T-103 与 M-201 存在登记回避
  assert.throws(
    () => service.lockAssignment(admin, plan.id, { teacherId: 'T-103', mentorId: 'M-201', expectedVersion: 1 }),
    ValidationError,
  );
  const lock = service.lockAssignment(admin, plan.id, {
    teacherId: 'T-103', mentorId: 'M-201', allowOverride: true, expectedVersion: 1,
  });
  assert.equal(lock.overrideViolations[0].kind, 'avoidance');
});

test('两位管理员同时修改时，后到者收到版本冲突而不是悄悄覆盖', () => {
  const service = makeService();
  const plan = service.createPlan(admin, { name: '草案' });
  // 管理员A先求解，版本变为 2
  service.solvePlan(admin, plan.id, { expectedVersion: 1 });
  // 管理员B仍基于读到的版本 1 提交锁定 → 冲突
  assert.throws(
    () => service.lockAssignment(adminB, plan.id, { teacherId: 'T-104', mentorId: 'M-203', expectedVersion: 1 }),
    (err) => err instanceof ConflictError && err.details.currentVersion === 2,
  );
  // B 刷新后基于最新版本重试成功
  service.lockAssignment(adminB, plan.id, { teacherId: 'T-104', mentorId: 'M-203', expectedVersion: 2 });
  const view = service.getPlanView(admin, plan.id);
  assert.equal(view.locks.length, 1);
  assert.equal(view.locks[0].by, 'admin-b');
});

test('不同草案的未匹配原因可以比较', () => {
  const service = makeService();
  const planA = service.createPlan(admin, { name: '草案A' });
  service.solvePlan(admin, planA.id, { expectedVersion: 1 });
  const planB = service.createPlan(admin, { name: '草案B' });
  service.lockAssignment(admin, planB.id, { teacherId: 'T-101', mentorId: 'M-202', expectedVersion: 1 });
  service.solvePlan(admin, planB.id, { expectedVersion: 2 });

  const diff = service.comparePlans(admin, planA.id, planB.id);
  assert.deepEqual(diff.plans[0].unmatched, ['T-105']);
  assert.deepEqual(diff.plans[1].unmatched, ['T-103']);
  assert.deepEqual(diff.onlyUnmatchedInA, ['T-105']);
  assert.deepEqual(diff.onlyUnmatchedInB, ['T-103']);
  const t103 = diff.rows.find((r) => r.teacherId === 'T-103');
  assert.equal(t103.mentorInA, 'M-202');
  assert.equal(t103.mentorInB, null);
  assert.ok(t103.unmatchedInB.reasons.capacity >= 1);
});

test('发布流程：邀请→确认→发布→候补名单', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  assert.equal(plan.state, 'published');
  assert.equal(plan.publishedNumber, 1);
  // T-105 未匹配、T-106 谢绝 → 都进入候补
  const view = service.getPlanView(admin, plan.id);
  assert.deepEqual(view.waitlist.map((w) => w.teacherId), ['T-105', 'T-106']);
  assert.equal(view.waitlist[0].reasons.kind, 'unmatched');
  assert.equal(view.waitlist[1].reasons.kind, 'confirmation-declined');
  // 生效安排 = 已接受的确认
  assert.equal(view.effectiveAssignments.length, 6);
});

test('有待回应邀请时不能发布', () => {
  const service = makeService();
  const plan = service.createPlan(admin, { name: '草案' });
  service.solvePlan(admin, plan.id, { expectedVersion: 1 });
  const invitations = service.openInvitations(admin, plan.id, { expectedVersion: 2 });
  assert.throws(() => service.publishPlan(admin, plan.id, { expectedVersion: 3 }), StateError);
  // 作废剩余邀请后即可发布
  for (const c of invitations) service.expireConfirmation(admin, c.id, {});
  const current = service.getPlan(plan.id);
  const published = service.publishPlan(admin, plan.id, { expectedVersion: current.version });
  assert.equal(published.state, 'published');
});

test('候补提升：空出名额后候补教师上位', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  // T-105 不能提升到 M-203（同校回避）
  assert.throws(
    () => service.promoteFromWaitlist(admin, plan.id, { teacherId: 'T-105', mentorId: 'M-203', expectedVersion: plan.version }),
    ValidationError,
  );
  // 调换 T-101→M-201 后 M-204 空出一个名额
  const change = service.changeMentor(admin, plan.id, {
    teacherId: 'T-101', newMentorId: 'M-201', reason: '学科组统筹', expectedVersion: plan.version,
  });
  const changeConfirmation = service.getConfirmation(change.confirmationId);
  service.respondToConfirmation(teacher('T-101'), changeConfirmation.id, { accept: true });
  const after = service.getPlan(plan.id);
  const promotion = service.promoteFromWaitlist(admin, plan.id, {
    teacherId: 'T-105', mentorId: 'M-204', expectedVersion: after.version,
  });
  service.respondToConfirmation(teacher('T-105'), promotion.confirmationId, { accept: true });
  const view = service.getPlanView(admin, plan.id);
  assert.deepEqual(view.waitlist.map((w) => w.teacherId), ['T-106']);
  const t105 = view.effectiveAssignments.find((a) => a.teacherId === 'T-105');
  assert.equal(t105.mentorId, 'M-204');
  assert.equal(t105.origin, 'waitlist-promotion');
});

test('调换导师保留原承诺，接受后才替换，全程可追溯', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  const before = service.getPlanView(admin, plan.id);
  const original = before.effectiveAssignments.find((a) => a.teacherId === 'T-101');
  assert.equal(original.mentorId, 'M-204');

  const change = service.changeMentor(admin, plan.id, {
    teacherId: 'T-101', newMentorId: 'M-201', reason: '导师研究方向更匹配', expectedVersion: plan.version,
  });
  // 新邀请未接受前，原承诺仍然生效
  const during = service.getPlanView(admin, plan.id);
  assert.equal(during.effectiveAssignments.find((a) => a.teacherId === 'T-101').mentorId, 'M-204');

  service.respondToConfirmation(teacher('T-101'), change.confirmationId, { accept: true });
  const after = service.getPlanView(admin, plan.id);
  assert.equal(after.effectiveAssignments.find((a) => a.teacherId === 'T-101').mentorId, 'M-201');

  // 追溯：原确认被新确认取代，调换记录挂在发布版本上
  const trace = service.getTeacherTrace(admin, 'T-101');
  const previous = trace.confirmations.find((c) => c.id === original.confirmationId);
  assert.equal(previous.supersededBy, change.confirmationId);
  assert.equal(previous.publishedNumber, 1);
  const record = trace.changes.find((c) => c.id === change.id);
  assert.equal(record.status, 'accepted');
  assert.equal(record.publishedNumber, 1);
  assert.equal(record.reason, '导师研究方向更匹配');
});

test('调换被拒绝时原安排继续生效', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  const change = service.changeMentor(admin, plan.id, {
    teacherId: 'T-101', newMentorId: 'M-201', reason: '尝试调换', expectedVersion: plan.version,
  });
  service.respondToConfirmation(teacher('T-101'), change.confirmationId, { accept: false });
  const view = service.getPlanView(admin, plan.id);
  assert.equal(view.effectiveAssignments.find((a) => a.teacherId === 'T-101').mentorId, 'M-204');
  assert.equal(view.changes.find((c) => c.id === change.id).status, 'declined');
});

test('教师退出不破坏已完成的培养记录', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  // T-102 完成培养，留下培养记录
  const record = service.completeMentorship(admin, { teacherId: 'T-102', note: '考核通过' });
  // T-107 退出：生效安排结束；T-106 在候补中也被移除
  service.withdrawTeacher(admin, 'T-107', { reason: '离职' });
  service.withdrawTeacher(admin, 'T-106', {});

  const trace107 = service.getTeacherTrace(admin, 'T-107');
  const ended = trace107.confirmations.find((c) => c.state === 'accepted');
  assert.equal(ended.endCause, 'teacher-withdrawn');
  assert.ok(ended.endedAt);

  // 培养记录原样保留
  const trace102 = service.getTeacherTrace(admin, 'T-102');
  assert.equal(trace102.trainingRecords.length, 1);
  assert.deepEqual(trace102.trainingRecords[0], record);
  assert.equal(trace102.trainingRecords[0].publishedNumber, 1);

  const view = service.getPlanView(admin, plan.id);
  assert.ok(!view.waitlist.some((w) => w.teacherId === 'T-106'));
  assert.ok(!view.effectiveAssignments.some((a) => a.teacherId === 'T-107'));
});

test('导师暂停：待回应邀请作废，生效安排与培养记录保留', () => {
  const service = makeService();
  const plan = publishFlow(service, { decliners: ['T-106'] });
  service.completeMentorship(admin, { teacherId: 'T-102' });
  service.pauseMentor(admin, 'M-201', { reason: '本学期停带' });

  const mentor = service.getMentor('M-201');
  assert.equal(mentor.status, 'paused');
  // T-102 的培养记录与已结束的确认不受影响
  const record = service.getTeacherTrace(admin, 'T-102').trainingRecords[0];
  assert.equal(record.mentorId, 'M-201');
  // 暂停的导师不参与新的求解
  const draft = service.createPlan(admin, { name: '下一轮' });
  const solution = service.solvePlan(admin, draft.id, { expectedVersion: 1 });
  assert.ok(!solution.assignments.some((a) => a.mentorId === 'M-201'));
  service.resumeMentor(admin, 'M-201');
  assert.equal(service.getMentor('M-201').status, 'active');
});

test('新方案发布后旧方案作废，历史确认保留', () => {
  const service = makeService();
  const first = publishFlow(service, { decliners: ['T-106'] });
  const second = service.createPlan(admin, { name: '春季调整' });
  service.solvePlan(admin, second.id, { expectedVersion: 1 });
  const invitations = service.openInvitations(admin, second.id, { expectedVersion: 2 });
  for (const c of invitations) service.respondToConfirmation(teacher(c.teacherId), c.id, { accept: true });
  const current = service.getPlan(second.id);
  service.publishPlan(admin, second.id, { expectedVersion: current.version });

  assert.equal(service.getPlan(first.id).state, 'superseded');
  assert.equal(service.getPlan(second.id).publishedNumber, 2);
  // 旧方案的确认记录仍可查（追溯链不断）
  const trace = service.getTeacherTrace(admin, 'T-101');
  assert.ok(trace.confirmations.some((c) => c.planId === first.id && c.publishedNumber === 1));
});

test('教师只能看到与自己有关的结果', () => {
  const service = makeService();
  publishFlow(service, { decliners: ['T-106'] });
  const mine = service.getMyResult(teacher('T-105'));
  assert.equal(mine.teacher.id, 'T-105');
  assert.equal(mine.plans.length, 1);
  assert.equal(mine.plans[0].waitlistPosition, 1);
  // 教师不能访问管理接口，也不能替别人回应
  assert.throws(() => service.getPlanView(teacher('T-105'), 'P-1'), ForbiddenError);
  assert.throws(() => service.createPlan(teacher('T-105'), { name: 'x' }), ForbiddenError);
  const other = service.state.confirmations.find((c) => c.teacherId === 'T-101');
  assert.throws(() => service.respondToConfirmation(teacher('T-105'), other.id, { accept: true }), ForbiddenError);
});

test('教师不能重复回应同一份邀请', () => {
  const service = makeService();
  const plan = service.createPlan(admin, { name: '草案' });
  service.solvePlan(admin, plan.id, { expectedVersion: 1 });
  const [invitation] = service.openInvitations(admin, plan.id, { expectedVersion: 2 });
  service.respondToConfirmation(teacher(invitation.teacherId), invitation.id, { accept: true });
  assert.throws(
    () => service.respondToConfirmation(teacher(invitation.teacherId), invitation.id, { accept: false }),
    StateError,
  );
});
