import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve, evaluatePair, scorePair, buildAvoidanceMap } from '../src/solver.js';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/dataset.json', import.meta.url)));
const baseInput = {
  teachers: dataset.teachers.map((t) => ({ status: 'active', ...t })),
  mentors: dataset.mentors.map((m) => ({ status: 'active', ...m })),
  avoidance: dataset.avoidance,
  locked: [],
};

function assignmentMap(result) {
  return Object.fromEntries(result.assignments.map((a) => [a.teacherId, a.mentorId]));
}

test('硬约束逐条判定', () => {
  const avoidanceMap = buildAvoidanceMap(dataset.avoidance);
  const teacher = { id: 'T-X', subject: 'physics', school: 'S-01' };
  const wrongSubject = { id: 'M-X', subjects: ['math'], school: 'S-09', capacity: 1 };
  const sameSchool = { id: 'M-Y', subjects: ['physics'], school: 'S-01', capacity: 1 };
  const avoided = { id: 'M-201', subjects: ['physics'], school: 'S-02', capacity: 1 };
  const full = { id: 'M-Z', subjects: ['physics'], school: 'S-09', capacity: 1 };

  assert.deepEqual(evaluatePair(teacher, wrongSubject, avoidanceMap, 1).map((v) => v.kind), ['subject']);
  assert.deepEqual(evaluatePair(teacher, sameSchool, avoidanceMap, 1).map((v) => v.kind), ['school-conflict']);
  assert.deepEqual(evaluatePair({ ...teacher, id: 'T-103' }, avoided, avoidanceMap, 1).map((v) => v.kind), ['avoidance']);
  assert.deepEqual(evaluatePair(teacher, full, avoidanceMap, 0).map((v) => v.kind), ['capacity']);
  assert.deepEqual(evaluatePair(teacher, full, avoidanceMap, 1), []);
});

test('偏好打分只影响同等可行方案', () => {
  const teacher = dataset.teachers.find((t) => t.id === 'T-101');
  const m204 = dataset.mentors.find((m) => m.id === 'M-204');
  const m201 = dataset.mentors.find((m) => m.id === 'M-201');
  const preferred = scorePair(teacher, m204);
  const plain = scorePair(teacher, m201);
  assert.equal(preferred.score, 3); // 偏好学校 S-04
  assert.equal(plain.score, 0);
});

test('示例数据求解结果符合硬约束与容量', () => {
  const result = solve(baseInput);
  const map = assignmentMap(result);
  // 受迫分配：T-103 只能去 M-202（M-201 回避、M-204 同校）
  assert.equal(map['T-103'], 'M-202');
  // 偏好生效：T-101 偏好 M-204 所在学校，T-104 与 M-203 有既往合作，T-107 偏好 M-205 所在学校
  assert.equal(map['T-101'], 'M-204');
  assert.equal(map['T-104'], 'M-203');
  assert.equal(map['T-107'], 'M-205');
  // 容量不被突破
  const load = {};
  for (const a of result.assignments) load[a.mentorId] = (load[a.mentorId] ?? 0) + 1;
  for (const mentor of dataset.mentors) assert.ok((load[mentor.id] ?? 0) <= mentor.capacity, `${mentor.id} 超额`);
  // T-105 未匹配且原因可解释：M-201/M-203 同校、M-204 容量已满、其余科目不符
  const unmatched = result.unmatched.find((u) => u.teacherId === 'T-105');
  assert.ok(unmatched);
  assert.equal(unmatched.reasons['school-conflict'], 2);
  assert.equal(unmatched.reasons.capacity, 1);
  assert.equal(unmatched.reasons.subject, 3);
  assert.match(unmatched.summary, /同校回避/);
  assert.match(unmatched.summary, /容量已满/);
});

test('未匹配解释包含容量占用者名单', () => {
  const result = solve(baseInput);
  const t105 = result.explanations['T-105'];
  const m204 = t105.candidates.find((c) => c.mentorId === 'M-204');
  const capacityViolation = m204.violations.find((v) => v.kind === 'capacity');
  assert.match(capacityViolation.detail, /已分配给/);
});

test('锁定安排被保留且占用容量', () => {
  const result = solve({ ...baseInput, locked: [{ teacherId: 'T-101', mentorId: 'M-202' }] });
  const map = assignmentMap(result);
  assert.equal(map['T-101'], 'M-202');
  const locked = result.assignments.find((a) => a.teacherId === 'T-101');
  assert.equal(locked.source, 'manual');
  // M-202 容量为 1，被锁定占用后 T-103 无处可去
  assert.ok(result.unmatched.some((u) => u.teacherId === 'T-103'));
});

test('锁定违反硬约束时报错', () => {
  assert.throws(
    () => solve({ ...baseInput, locked: [{ teacherId: 'T-103', mentorId: 'M-201' }] }),
    /违反硬约束/,
  );
  assert.throws(
    () => solve({ ...baseInput, locked: [{ teacherId: 'T-101', mentorId: 'M-202' }, { teacherId: 'T-108', mentorId: 'M-202' }] }),
    /超过容量/,
  );
});

test('退出与暂停的人员不参与求解', () => {
  const teachers = baseInput.teachers.map((t) => (t.id === 'T-105' ? { ...t, status: 'withdrawn' } : t));
  const mentors = baseInput.mentors.map((m) => (m.id === 'M-205' ? { ...m, status: 'paused' } : m));
  const result = solve({ ...baseInput, teachers, mentors });
  assert.ok(!result.assignments.some((a) => a.teacherId === 'T-105'));
  assert.ok(!result.unmatched.some((u) => u.teacherId === 'T-105'));
  assert.ok(!result.assignments.some((a) => a.mentorId === 'M-205'));
});

test('相同输入求解结果确定', () => {
  const first = solve(baseInput);
  const second = solve(baseInput);
  assert.deepEqual(first, second);
});
