// 完整演示：试排 → 比较草案 → 邀请确认 → 发布 → 候补提升 → 调换 → 退出/暂停 → 追溯
// 运行：npm run demo
import { readFileSync } from 'node:fs';
import { PlannerService } from '../src/planner.js';
import { createState } from '../src/store.js';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/dataset.json', import.meta.url)));
const service = new PlannerService(createState(dataset));
const admin = { role: 'admin', id: 'admin' };
const teacher = (id) => ({ role: 'teacher', id });

const show = (title, value) => {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

// 1. 草案 A：直接求解
const planA = service.createPlan(admin, { name: '草案A（系统求解）' });
const solutionA = service.solvePlan(admin, planA.id, { expectedVersion: 1 });
show('草案A 匹配结果', solutionA.assignments.map((a) => `${a.teacherId}→${a.mentorId}(${a.source})`));
show('草案A 未匹配原因', solutionA.unmatched);

// 2. 草案 B：锁定人工安排后求解剩余人员
const planB = service.createPlan(admin, { name: '草案B（锁定林晓→吴桐）' });
service.lockAssignment(admin, planB.id, { teacherId: 'T-101', mentorId: 'M-202', expectedVersion: 1 });
const solutionB = service.solvePlan(admin, planB.id, { expectedVersion: 2 });

// 3. 比较两个草案的未匹配原因
const diff = service.comparePlans(admin, planA.id, planB.id);
show('草案比较：未匹配差异', {
  仅A未匹配: diff.onlyUnmatchedInA,
  仅B未匹配: diff.onlyUnmatchedInB,
  B中T103原因: diff.rows.find((r) => r.teacherId === 'T-103').unmatchedInB.summary,
});

// 4. 选择草案A：邀请 → 确认（T-106 谢绝）→ 发布
const invitations = service.openInvitations(admin, planA.id, { expectedVersion: 2 });
for (const c of invitations) {
  service.respondToConfirmation(teacher(c.teacherId), c.id, { accept: c.teacherId !== 'T-106' });
}
let plan = service.getPlan(planA.id);
service.publishPlan(admin, planA.id, { expectedVersion: plan.version });
plan = service.getPlan(planA.id);
show('发布后候补名单', service.getPlanView(admin, planA.id).waitlist.map(
  (w) => `${w.position}. ${w.teacherName}（${w.reasons.detail}）`,
));

// 5. 调换：T-101 从 M-204 调到 M-201（原承诺保留到新邀请被接受）
const change = service.changeMentor(admin, planA.id, {
  teacherId: 'T-101', newMentorId: 'M-201', reason: '学科组统筹，释放许静名额', expectedVersion: plan.version,
});
service.respondToConfirmation(teacher('T-101'), change.confirmationId, { accept: true });

// 6. 候补提升：M-204 空出名額，T-105 上位
plan = service.getPlan(planA.id);
const promotion = service.promoteFromWaitlist(admin, planA.id, {
  teacherId: 'T-105', mentorId: 'M-204', expectedVersion: plan.version,
});
service.respondToConfirmation(teacher('T-105'), promotion.confirmationId, { accept: true });
show('提升后的生效安排', service.getPlanView(admin, planA.id).effectiveAssignments.map(
  (a) => `${a.teacherName}→${a.mentorName}（${a.origin}）`,
));

// 7. T-102 完成培养；T-107 退出；M-203 暂停带教
service.completeMentorship(admin, { teacherId: 'T-102', note: '考核通过' });
service.withdrawTeacher(admin, 'T-107', { reason: '离职' });
service.pauseMentor(admin, 'M-203', { reason: '本学期停带' });

// 8. 追溯与教师视角
const trace = service.getTeacherTrace(admin, 'T-101');
show('T-101 调换追溯（发布版本 + 确认过程）', trace.confirmations.map((c) => ({
  确认: c.id, 导师: c.mentorId, 状态: c.state, 发布版本: c.publishedNumber, 被取代: c.supersededBy,
})));
show('T-102 培养记录（退出/暂停不影响）', service.getTeacherTrace(admin, 'T-102').trainingRecords);
show('教师 T-105 的个人视角', service.getMyResult(teacher('T-105')));
