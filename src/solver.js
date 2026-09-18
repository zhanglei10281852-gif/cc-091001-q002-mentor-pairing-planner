import { preferenceWeights } from './domain.js';
import { ValidationError } from './errors.js';

export function avoidanceKey(teacherId, mentorId) {
  return `${teacherId}::${mentorId}`;
}

export function buildAvoidanceMap(avoidance) {
  const map = new Map();
  for (const entry of avoidance ?? []) {
    map.set(avoidanceKey(entry.teacherId, entry.mentorId), entry.reason ?? '登记回避');
  }
  return map;
}

// 逐条评估一对师生是否违反硬约束；remainingCapacity 省略时不检查容量
export function evaluatePair(teacher, mentor, avoidanceMap, remainingCapacity = undefined) {
  const violations = [];
  if (!mentor.subjects.includes(teacher.subject)) {
    violations.push({ kind: 'subject', detail: `导师科目[${mentor.subjects.join(',')}]不含${teacher.subject}` });
  }
  if (mentor.school === teacher.school) {
    violations.push({ kind: 'school-conflict', detail: `同校回避：双方均属${teacher.school}` });
  }
  const avoidReason = avoidanceMap.get(avoidanceKey(teacher.id, mentor.id));
  if (avoidReason !== undefined) {
    violations.push({ kind: 'avoidance', detail: `登记回避：${avoidReason}` });
  }
  if (remainingCapacity !== undefined && remainingCapacity <= 0) {
    violations.push({ kind: 'capacity', detail: `容量已用完（上限${mentor.capacity}）` });
  }
  return violations;
}

// 偏好仅用于同等可行方案之间的选择
export function scorePair(teacher, mentor) {
  const prefs = teacher.preferences ?? {};
  const applied = [];
  if (Array.isArray(prefs.preferredSchools) && prefs.preferredSchools.includes(mentor.school)) {
    applied.push({ kind: 'preferred-school', points: preferenceWeights['preferred-school'], detail: `偏好学校${mentor.school}` });
  }
  if (Array.isArray(prefs.preferredSubjects) && prefs.preferredSubjects.some((s) => mentor.subjects.includes(s))) {
    applied.push({ kind: 'preferred-subject', points: preferenceWeights['preferred-subject'], detail: '偏好科目匹配' });
  }
  if (Array.isArray(prefs.priorCollaborators) && prefs.priorCollaborators.includes(mentor.id)) {
    applied.push({ kind: 'prior-collaboration', points: preferenceWeights['prior-collaboration'], detail: `曾与${mentor.id}合作` });
  }
  return { score: applied.reduce((sum, item) => sum + item.points, 0), applied };
}

// 在“匹配人数最多”的方案中取偏好权重最大者。
// 建模为最小费用最大流：源→教师(1)→导师(容量)→汇，师生边费用为 -权重，
// 逐次最短路增广保证每一步都是当前流量下的最优解，且对相同输入结果确定。
function maxWeightMatching(teacherIds, mentorIds, edges, capacityByMentor) {
  const nT = teacherIds.length;
  const nM = mentorIds.length;
  const N = nT + nM + 2;
  const S = N - 2;
  const T = N - 1;
  const tIndex = new Map(teacherIds.map((id, i) => [id, i]));
  const mIndex = new Map(mentorIds.map((id, i) => [id, i]));
  const graph = Array.from({ length: N }, () => []);
  const addEdge = (from, to, cap, cost) => {
    const fwd = { to, rev: graph[to].length, cap, cost };
    const bwd = { to: from, rev: graph[from].length, cap: 0, cost: -cost };
    graph[from].push(fwd);
    graph[to].push(bwd);
    return fwd;
  };
  for (let i = 0; i < nT; i += 1) addEdge(S, i, 1, 0);
  const pairEdges = edges.map((e) => ({
    teacherId: e.teacherId,
    mentorId: e.mentorId,
    edge: addEdge(tIndex.get(e.teacherId), nT + mIndex.get(e.mentorId), 1, -e.weight),
  }));
  for (let j = 0; j < nM; j += 1) {
    const cap = capacityByMentor.get(mentorIds[j]) ?? 0;
    if (cap > 0) addEdge(nT + j, T, cap, 0);
  }

  for (;;) {
    const dist = new Array(N).fill(Infinity);
    const prevNode = new Array(N).fill(-1);
    const prevEdge = new Array(N).fill(null);
    dist[S] = 0;
    let updated = true;
    for (let iter = 0; iter < N - 1 && updated; iter += 1) {
      updated = false;
      for (let v = 0; v < N; v += 1) {
        if (dist[v] === Infinity) continue;
        for (const e of graph[v]) {
          if (e.cap > 0 && dist[v] + e.cost < dist[e.to]) {
            dist[e.to] = dist[v] + e.cost;
            prevNode[e.to] = v;
            prevEdge[e.to] = e;
            updated = true;
          }
        }
      }
    }
    if (dist[T] === Infinity) break;
    let v = T;
    while (v !== S) {
      const e = prevEdge[v];
      e.cap -= 1;
      graph[v][e.rev].cap += 1;
      v = prevNode[v];
    }
  }

  return pairEdges.filter((p) => p.edge.cap === 0).map((p) => ({ teacherId: p.teacherId, mentorId: p.mentorId }));
}

function summarizeUnmatched(teacher, candidates, reasons) {
  const parts = [];
  if (reasons.subject > 0) parts.push(`${reasons.subject}位科目不符`);
  if (reasons['school-conflict'] > 0) parts.push(`${reasons['school-conflict']}位同校回避`);
  if (reasons.avoidance > 0) parts.push(`${reasons.avoidance}位登记回避`);
  if (reasons.capacity > 0) parts.push(`${reasons.capacity}位容量已满`);
  if (parts.length === 0) return `${teacher.id} 没有可评估的导师`;
  return `评估${candidates.length}位导师：${parts.join('，')}`;
}

// 求解入口。locked 为管理员锁定的人工安排 [{teacherId, mentorId}]，
// 锁定结果占用导师容量且必须满足硬约束，剩余人员由求解器补齐。
export function solve({ teachers, mentors, avoidance = [], locked = [] }) {
  const avoidanceMap = buildAvoidanceMap(avoidance);
  const teacherById = new Map(teachers.map((t) => [t.id, t]));
  const mentorById = new Map(mentors.map((m) => [m.id, m]));
  const activeTeachers = teachers.filter((t) => t.status !== 'withdrawn');
  const activeMentors = mentors.filter((m) => m.status !== 'paused');

  const lockedAssignments = [];
  const lockedByTeacher = new Map();
  const lockedCountByMentor = new Map();
  for (const lock of locked) {
    const teacher = teacherById.get(lock.teacherId);
    const mentor = mentorById.get(lock.mentorId);
    if (!teacher) throw new ValidationError(`锁定的教师不存在：${lock.teacherId}`);
    if (!mentor) throw new ValidationError(`锁定的导师不存在：${lock.mentorId}`);
    if (teacher.status === 'withdrawn') throw new ValidationError(`教师 ${teacher.id} 已退出，不能锁定`);
    if (mentor.status === 'paused') throw new ValidationError(`导师 ${mentor.id} 已暂停带教，不能锁定`);
    if (lockedByTeacher.has(teacher.id)) throw new ValidationError(`教师 ${teacher.id} 重复锁定`);
    const violations = evaluatePair(teacher, mentor, avoidanceMap);
    if (violations.length > 0 && !lock.overrideViolations) {
      throw new ValidationError(`锁定 ${teacher.id}→${mentor.id} 违反硬约束：${violations.map((v) => v.detail).join('；')}`, { violations });
    }
    lockedByTeacher.set(teacher.id, mentor.id);
    lockedCountByMentor.set(mentor.id, (lockedCountByMentor.get(mentor.id) ?? 0) + 1);
    lockedAssignments.push({ teacherId: teacher.id, mentorId: mentor.id, source: 'manual' });
  }
  for (const [mentorId, count] of lockedCountByMentor) {
    const mentor = mentorById.get(mentorId);
    if (count > mentor.capacity) {
      throw new ValidationError(`导师 ${mentorId} 的锁定数量 ${count} 超过容量 ${mentor.capacity}`);
    }
  }

  const remainingCapacity = new Map(
    activeMentors.map((m) => [m.id, m.capacity - (lockedCountByMentor.get(m.id) ?? 0)]),
  );
  const freeTeachers = activeTeachers.filter((t) => !lockedByTeacher.has(t.id));

  const explanations = {};
  const edges = [];
  for (const teacher of freeTeachers) {
    const entry = { chosen: null, source: null, candidates: [] };
    explanations[teacher.id] = entry;
    for (const mentor of activeMentors) {
      const violations = evaluatePair(teacher, mentor, avoidanceMap, remainingCapacity.get(mentor.id));
      if (violations.length > 0) {
        entry.candidates.push({ mentorId: mentor.id, status: 'excluded', violations });
      } else {
        const { score, applied } = scorePair(teacher, mentor);
        entry.candidates.push({ mentorId: mentor.id, status: 'available', score, preferences: applied });
        edges.push({ teacherId: teacher.id, mentorId: mentor.id, weight: score });
      }
    }
  }
  for (const lock of lockedAssignments) {
    explanations[lock.teacherId] = { chosen: lock.mentorId, source: 'manual', candidates: [] };
  }

  const matched = maxWeightMatching(
    freeTeachers.map((t) => t.id),
    activeMentors.map((m) => m.id),
    edges,
    remainingCapacity,
  );
  const matchedByTeacher = new Map(matched.map((p) => [p.teacherId, p.mentorId]));

  const assignments = [...lockedAssignments];
  for (const teacher of freeTeachers) {
    const mentorId = matchedByTeacher.get(teacher.id);
    if (!mentorId) continue;
    const entry = explanations[teacher.id];
    entry.chosen = mentorId;
    entry.source = 'solver';
    const chosen = entry.candidates.find((c) => c.mentorId === mentorId);
    if (chosen) chosen.status = 'selected';
    assignments.push({
      teacherId: teacher.id,
      mentorId,
      source: 'solver',
      score: chosen?.score ?? 0,
      preferences: chosen?.preferences ?? [],
    });
  }

  // 用最终占用情况补充“容量已满”的具体说明，便于解释未匹配原因
  const occupantsByMentor = new Map();
  for (const a of assignments) {
    if (!occupantsByMentor.has(a.mentorId)) occupantsByMentor.set(a.mentorId, []);
    occupantsByMentor.get(a.mentorId).push(a.teacherId);
  }
  for (const entry of Object.values(explanations)) {
    for (const candidate of entry.candidates) {
      for (const violation of candidate.violations ?? []) {
        if (violation.kind === 'capacity') {
          const occupants = occupantsByMentor.get(candidate.mentorId) ?? [];
          violation.detail += occupants.length > 0 ? `，已分配给 ${occupants.join('、')}` : '，被锁定安排占用';
        }
      }
    }
  }

  const unmatched = [];
  for (const teacher of freeTeachers) {
    if (matchedByTeacher.has(teacher.id)) continue;
    const entry = explanations[teacher.id];
    // 未匹配教师“可选但未选”的导师，实际是名额在求解中被占满（否则最大流必会选中），回填为容量原因
    for (const candidate of entry.candidates) {
      if (candidate.status !== 'available') continue;
      const mentor = mentorById.get(candidate.mentorId);
      const occupants = occupantsByMentor.get(mentor.id) ?? [];
      if (occupants.length >= mentor.capacity) {
        candidate.status = 'excluded';
        candidate.violations = [
          { kind: 'capacity', detail: `容量已用完（上限${mentor.capacity}），已分配给 ${occupants.join('、')}` },
        ];
      }
    }
    const reasons = { subject: 0, capacity: 0, 'school-conflict': 0, avoidance: 0 };
    const candidates = entry.candidates;
    for (const candidate of candidates) {
      for (const violation of candidate.violations ?? []) reasons[violation.kind] += 1;
    }
    unmatched.push({
      teacherId: teacher.id,
      reasons,
      summary: summarizeUnmatched(teacher, candidates, reasons),
    });
  }

  return { assignments, unmatched, explanations };
}
