import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePair, solve, subjectsCompatible, explainCandidates, diffUnmatched } from '../src/matching.js';

const data = {
  teachers: [
    { id: 'T-101', name: '赵', subject: 'physics', school: 'S-01', active: true },
    { id: 'T-102', name: '钱', subject: 'physics', school: 'S-03', active: true },
    { id: 'T-103', name: '孙', subject: 'math', school: 'S-01', active: true },
    { id: 'T-104', name: '李', subject: 'chemistry', school: 'S-05', active: true },
  ],
  mentors: [
    { id: 'M-201', name: '导A', subjects: ['physics'], school: 'S-02', capacity: 2, status: 'active' },
    { id: 'M-202', name: '导B', subjects: ['physics'], school: 'S-03', capacity: 1, status: 'active' },
    { id: 'M-203', name: '导C', subjects: ['math'], school: 'S-01', capacity: 1, status: 'active' },
    { id: 'M-204', name: '导D', subjects: ['math'], school: 'S-04', capacity: 2, status: 'active' },
    { id: 'M-205', name: '导E', subjects: ['chemistry'], school: 'S-05', capacity: 1, status: 'active' },
  ],
  compatibility: {},
  avoidances: [{ teacherId: 'T-101', mentorId: 'M-202', reason: '历史矛盾' }],
  preferences: [{ teacherId: 'T-101', mentorId: 'M-201', kind: 'prior-collaboration' }],
};

const emptyPlan = () => ({ locks: [], excludedTeacherIds: [], excludedMentorIds: [], strategy: 'max-match' });

test('学科兼容：直接相等、兼容表正反向均成立', () => {
  assert.ok(subjectsCompatible('physics', ['physics']));
  assert.ok(subjectsCompatible('a', ['b'], { a: ['b'] }));
  assert.ok(subjectsCompatible('a', ['b'], { b: ['a'] })); // 反向登记
  assert.ok(!subjectsCompatible('a', ['c'], { a: ['b'] }));
});

test('硬约束逐条判定：学科/同校/回避/停带/退出', () => {
  const t101 = data.teachers[0];
  assert.deepEqual(evaluatePair(t101, data.mentors[0], data).kinds, []);
  assert.deepEqual(evaluatePair(t101, data.mentors[1], data).kinds, ['avoidance']);
  // T-102 与 M-202 同校
  assert.deepEqual(evaluatePair(data.teachers[1], data.mentors[1], data).kinds, ['school-conflict']);
  // T-104 化学 vs 物理导师：学科不兼容
  assert.deepEqual(evaluatePair(data.teachers[3], data.mentors[0], data).kinds, ['subject']);
  // 停带 / 退出
  assert.deepEqual(evaluatePair(t101, { ...data.mentors[0], status: 'paused' }, data).kinds, ['mentor-paused']);
  assert.deepEqual(evaluatePair({ ...t101, active: false }, data.mentors[0], data).kinds, ['teacher-inactive']);
});

test('偏好只命中打分，绝不放宽硬约束', () => {
  const ev = evaluatePair(data.teachers[0], data.mentors[0], data);
  assert.ok(ev.ok);
  assert.deepEqual(ev.preferenceHits, ['prior-collaboration']);
  const bad = evaluatePair(data.teachers[0], data.mentors[1], data);
  assert.ok(!bad.ok);
  assert.equal(bad.preferenceScore, 0);
});

test('最大匹配尊重容量：两名物理教师都只能进 M-201', () => {
  const r = solve(data, emptyPlan(), new Map(), 'max-match');
  const pairs = new Map(r.matches.map((m) => [m.teacherId, m.mentorId]));
  assert.equal(pairs.get('T-101'), 'M-201');
  assert.equal(pairs.get('T-102'), 'M-201');
  assert.equal(pairs.get('T-103'), 'M-204');
  assert.equal(r.summary.matchedCount, 3);
  // T-104 未匹配，原因里 M-205 是同校、其余是学科
  const t104 = r.unmatched.find((u) => u.teacherId === 'T-104');
  assert.ok(t104);
  assert.ok(t104.kindCounts['school-conflict'] >= 1);
  assert.ok(t104.kindCounts['subject'] >= 4);
});

test('容量被已发布在培/待处理邀请预占时，求解器不再超配', () => {
  const commitments = new Map([['M-201', 2]]); // M-201 已满
  const r = solve(data, emptyPlan(), commitments, 'max-match');
  const matched = new Set(r.matches.map((m) => m.teacherId));
  assert.ok(!matched.has('T-101')); // M-202 被回避，无可行导师
  assert.ok(!matched.has('T-102')); // M-202 同校
  const t101 = r.unmatched.find((u) => u.teacherId === 'T-101');
  // M-201 对她只剩容量原因
  const m201 = t101.blockers.find((b) => b.mentorId === 'M-201');
  assert.deepEqual(m201.kinds, ['capacity']);
});

test('人工锁定后只对剩余人员求解，且锁定超容量会被报为 lockProblems', () => {
  const plan = { ...emptyPlan(), locks: [{ teacherId: 'T-103', mentorId: 'M-204', source: 'manual-lock' }] };
  const r = solve(data, plan, new Map(), 'max-match');
  const lock = r.matches.find((m) => m.teacherId === 'T-103');
  assert.equal(lock.source, 'manual-lock');
  assert.equal(r.summary.matchedCount, 3);

  const full = new Map([['M-204', 2]]);
  const bad = solve(data, plan, full, 'max-match');
  assert.equal(bad.lockProblems.length, 1);
  assert.equal(bad.lockProblems[0].teacherId, 'T-103');
  assert.ok(bad.lockProblems[0].kinds.includes('capacity'));
});

test('同等匹配数下 preference-first 按偏好总分择优，max-match 平局确定', () => {
  const d = {
    teachers: [
      { id: 'X1', subject: 's', school: 'a', active: true },
      { id: 'X2', subject: 's', school: 'a', active: true },
    ],
    mentors: [
      { id: 'MA', subjects: ['s'], school: 'b', capacity: 1, status: 'active' },
      { id: 'MB', subjects: ['s'], school: 'c', capacity: 1, status: 'active' },
    ],
    compatibility: {},
    avoidances: [],
    preferences: [{ teacherId: 'X1', mentorId: 'MB', kind: 'preferred-school' }],
  };
  const maxMatch = solve(d, emptyPlan(), new Map(), 'max-match');
  // 平局按导师序号：X1->MA, X2->MB
  assert.deepEqual(new Map(maxMatch.matches.map((m) => [m.teacherId, m.mentorId])).get('X1'), 'MA');
  const pref = solve(d, emptyPlan(), new Map(), 'preference-first');
  const pairs = new Map(pref.matches.map((m) => [m.teacherId, m.mentorId]));
  assert.equal(pairs.get('X1'), 'MB'); // 偏好被满足
  assert.equal(pairs.get('X2'), 'MA'); // 匹配数不变
  assert.equal(pref.summary.matchedCount, 2);
  assert.ok(pref.summary.preferenceScore > maxMatch.summary.preferenceScore);
});

test('排除的导师/教师生效并给出可解释原因', () => {
  const plan = { ...emptyPlan(), excludedMentorIds: ['M-201'] };
  const r = solve(data, plan, new Map(), 'max-match');
  assert.ok(!r.matches.some((m) => m.mentorId === 'M-201'));
  const plan2 = { ...emptyPlan(), excludedTeacherIds: ['T-101'] };
  const r2 = solve(data, plan2, new Map(), 'max-match');
  assert.ok(r2.unmatched.find((u) => u.teacherId === 'T-101' && u.excluded));
});

test('增广交替路：需要撤换中间配对时仍能达到最大匹配', () => {
  // T-103 先占 M-202 后，T-104 必须把 T-103 挤到 M-203 才能全匹配。
  const d = {
    teachers: [
      { id: 'T-101', subject: 's', school: 'a', active: true },
      { id: 'T-102', subject: 's', school: 'a', active: true },
      { id: 'T-103', subject: 's', school: 'a', active: true },
      { id: 'T-104', subject: 's', school: 'a', active: true },
    ],
    mentors: [
      { id: 'M-201', subjects: ['s'], school: 'b', capacity: 2, status: 'active' },
      { id: 'M-202', subjects: ['s'], school: 'c', capacity: 1, status: 'active' },
      { id: 'M-203', subjects: ['s'], school: 'd', capacity: 1, status: 'active' },
      { id: 'M-204', subjects: ['s'], school: 'e', capacity: 1, status: 'active' },
    ],
    compatibility: {},
    avoidances: [],
    preferences: [],
  };
  // 可行边：T101/T102（学科 x）只有 M201；T103 -> M202,M203；T104 只有 M202
  // （与 M203 同校、对 M204 登记回避），因此 T104 必须把 T103 挤到 M203。
  d.teachers[0].subject = 'x';
  d.teachers[1].subject = 'x';
  d.mentors[0].subjects = ['x'];
  d.teachers[3].school = 'd'; // 同校回避 M203
  d.avoidances = [{ teacherId: 'T-104', mentorId: 'M-204' }];
  const r = solve(d, emptyPlan(), new Map(), 'max-match');
  assert.equal(r.summary.matchedCount, 4);
  const pairs = new Map(r.matches.map((m) => [m.teacherId, m.mentorId]));
  assert.equal(pairs.get('T-101'), 'M-201');
  assert.equal(pairs.get('T-102'), 'M-201');
  assert.equal(pairs.get('T-103'), 'M-203');
  assert.equal(pairs.get('T-104'), 'M-202');
});

test('explainCandidates：单个教师的候选清单含可行性、原因与剩余名额', () => {
  const c = explainCandidates(data, emptyPlan(), new Map(), 'T-104');
  assert.equal(c.feasibleCount, 0);
  const m205 = c.candidates.find((x) => x.mentorId === 'M-205');
  assert.deepEqual(m205.kinds, ['school-conflict']);
  assert.ok(m205.details[0].includes('同校回避'));
  const c101 = explainCandidates(data, emptyPlan(), new Map(), 'T-101');
  assert.equal(c101.feasibleCount, 1);
  assert.equal(c101.candidates.find((x) => x.mentorId === 'M-201').remaining, 2);
});

test('diffUnmatched 比较两版草案的未匹配原因', () => {
  const a = solve(data, emptyPlan(), new Map(), 'max-match');
  const b = solve(data, { ...emptyPlan(), excludedMentorIds: ['M-201'] }, new Map(), 'max-match');
  const diff = diffUnmatched(a, b);
  assert.equal(diff.matchedA, 3);
  assert.ok(diff.matchedB < 3);
  const t101 = diff.rows.find((r) => r.teacherId === 'T-101');
  assert.equal(t101.statusA, 'matched');
  assert.equal(t101.statusB, 'unmatched');
});
