// 端到端演示：载入脱敏样例，试排两版草案并比较，发布一版，
// 完成双方确认，再演示拒绝→候补→补排与换导师留痕。
// 运行：node scripts/demo.mjs

import { readFile } from 'node:fs/promises';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';

const ctx = JSON.parse(await readFile(new URL('../fixtures/matching-context.json', import.meta.url)));
const service = new Service(new Store(null), { invitationTtlDays: 14 });

await service.importData(
  {
    teachers: ctx.teachers,
    mentors: ctx.mentors,
    compatibility: ctx.compatibility,
    avoidances: ctx.avoidances,
    preferences: ctx.preferences,
  },
  '教师发展中心'
);

// 两版草案：A 最大匹配，B 偏好优先且试排时排除 M-202、M-203
const a = await service.createDraft({ name: 'A 最大匹配', strategy: 'max-match' });
const b = await service.createDraft({ name: 'B 偏好优先（仅用 M-201/M-204）', strategy: 'preference-first' });
await service.setExcluded(b.plan.id, b.plan.version, { mentorIds: ['M-202', 'M-203'] }, '负责人');

console.log('== A 版试排 ==');
for (const m of service.previewPlan(a.plan.id).result.matches) console.log(`  ${m.teacherId} -> ${m.mentorId} (${m.source})`);
console.log('未匹配：');
for (const u of service.previewPlan(a.plan.id).result.unmatched) {
  const reasons = Object.entries(u.kindCounts).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
  console.log(`  ${u.teacherId}: ${reasons.join(', ') || '—'}`);
}

// T-103 的候选导师解释
console.log('== T-103 候选解释 ==');
for (const c of service.previewPairCandidates(a.plan.id, 'T-103').candidates) {
  console.log(`  ${c.mentorId} 可行=${c.feasible} 剩余名额=${c.remaining}${c.kinds.length ? ' 原因=' + c.details.join('；') : ''}`);
}

console.log('== A/B 未匹配原因对比（节选）==');
const diff = service.compareDrafts(a.plan.id, b.plan.id);
for (const row of diff.rows.filter((r) => r.statusA !== r.statusB)) {
  console.log(`  ${row.teacherId}: A ${row.statusA} / B ${row.statusB}`);
}

// 锁定一个人工安排后发布 A 版
const planA = service.getPlan(a.plan.id);
await service.lockPair(planA.plan.id, planA.plan.version, 'T-103', 'M-203', '负责人');
const lockedView = service.getPlan(a.plan.id);
const published = await service.publishDraft(lockedView.plan.id, lockedView.plan.version, '负责人');
console.log(`== 发布 release v${published.plan.releaseVersion}，发出邀请 ${published.createdInvitations.length} 份 ==`);

// T-101 双方接受
const inv101 = service.store.state.invitations.find((i) => i.teacherId === 'T-101');
await service.respondInvitation(inv101.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-201' });
await service.respondInvitation(inv101.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-101' });
console.log(`T-101 结对确认完成，培养记录 ${service.getInvitation(inv101.id).enrollmentId}`);

// T-102 的邀请被导师拒绝 → 候补
const inv102 = service.store.state.invitations.find((i) => i.teacherId === 'T-102');
await service.respondInvitation(inv102.id, 'mentor', 'declined', { expectedVersion: 1, actor: 'M-201' });
console.log(`T-102 当前候补：${service.waitlist().filter((w) => w.status === 'waiting').map((w) => w.teacherId).join(', ')}`);

// M-201 扩容后从候补补排
service.store.state.mentors.find((m) => m.id === 'M-201').capacity = 3;
const w = service.waitlist().find((x) => x.teacherId === 'T-102');
const again = await service.assignFromWaitlist(w.id, 'M-201', '负责人');
await service.respondInvitation(again.id, 'mentor', 'accepted', { expectedVersion: 1, actor: 'M-201' });
await service.respondInvitation(again.id, 'teacher', 'accepted', { expectedVersion: 2, actor: 'T-102' });
console.log('T-102 候补补排成功');

// 换导师：有依据、原记录保留
await service.reassign('T-101', 'M-202', 'M-201 下学期学术休假', '负责人').catch((e) => {
  console.log(`换 M-202 被拒（硬约束生效）：${e.message}`);
});
// 演示资料：新增一位跨校物理导师
service.store.state.mentors.push({ id: 'M-205', name: '马知远', subjects: ['physics'], school: 'S-07', capacity: 1, status: 'active' });
const reassign = await service.reassign('T-101', 'M-205', '学科交叉培养需要', '负责人');
console.log(`T-101 换导师邀请 ${reassign.id}（M-201 -> M-205，带理由，等待双方确认）`);

console.log('== T-101 教师视图（仅本人相关）==');
const view = service.teacherView('T-101');
for (const e of view.enrollments) {
  console.log(`  培养记录 ${e.id}: ${e.mentorId} ${e.status}${e.endReason ? '（结束原因 ' + e.endReason + '）' : ''}，发布版本 v${e.releaseVersion}`);
}
console.log('== 追溯 T-101 的审计链 ==');
for (const ev of service.audit().filter((x) => x.details?.teacherId === 'T-101')) {
  console.log(`  ${ev.at} ${ev.actor} ${ev.action} ${JSON.stringify(ev.details)}`);
}
