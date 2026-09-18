// 匹配引擎：
// 1) 硬约束逐条解释（学科 / 容量 / 同校 / 回避，以及运行期的停带、退出、排除）；
// 2) 偏好只打分、不放宽硬约束；
// 3) 求解器先保证最大匹配数，再在同等匹配数的方案之间按偏好总分择优，
//    人工锁定的结对作为固定边参与并预留容量，剩余人员继续求解。

import { allRejectKinds, REASON_DETAIL } from './domain.js';

export function subjectsCompatible(teacherSubject, mentorSubjects, compatibility = {}) {
  if (mentorSubjects.includes(teacherSubject)) return true;
  const linked = compatibility[teacherSubject] ?? [];
  if (linked.some((s) => mentorSubjects.includes(s))) return true;
  // 兼容表可能只登记了反向。
  return mentorSubjects.some((ms) => (compatibility[ms] ?? []).includes(teacherSubject));
}

// 静态配对理由（不含容量——容量取决于整体分配）。
// 返回 { ok, kinds:Set, hits:Set(偏好命中), preferenceScore }
export function evaluatePair(teacher, mentor, data, { isExcluded = false } = {}) {
  const kinds = [];
  if (!teacher.active) kinds.push('teacher-inactive');
  if (mentor.status === 'paused') kinds.push('mentor-paused');
  if (isExcluded) kinds.push('excluded');
  if (!subjectsCompatible(teacher.subject, mentor.subjects ?? [], data.compatibility)) {
    kinds.push('subject');
  }
  if (teacher.school && teacher.school === mentor.school) kinds.push('school-conflict');
  if (data.avoidances.some((a) => a.teacherId === teacher.id && a.mentorId === mentor.id)) {
    kinds.push('avoidance');
  }
  const hits = (data.preferences ?? [])
    .filter((p) => p.teacherId === teacher.id && p.mentorId === mentor.id)
    .map((p) => p.kind);
  return {
    ok: kinds.length === 0,
    kinds,
    preferenceHits: hits,
    preferenceScore: hits.length,
  };
}

function byId(list) {
  return new Map(list.map((x) => [x.id, x]));
}

// 计算求解所需的固定占用：{ mentorId: {committed, locked} }
export function planLoads(data, plan, commitments = new Map()) {
  const loads = new Map();
  for (const m of data.mentors) loads.set(m.id, { committed: commitments.get(m.id) ?? 0, locked: 0, matched: 0 });
  for (const lock of plan.locks ?? []) {
    const l = loads.get(lock.mentorId);
    if (l) l.locked += 1;
  }
  return loads;
}

/**
 * 求解一个草案。
 * data: 完整资料库（teachers/mentors/compatibility/avoidances/preferences）
 * plan: { locks:[{teacherId, mentorId, source}], excludedTeacherIds:[], excludedMentorIds:[] }
 * commitments: Map<mentorId, number> 已发布且仍在培的结对（教师退出/换导师后由服务层扣减）
 * strategy: 'max-match' | 'preference-first'
 * options.busyTeacherIds: 已有生效结对、不应再参与本轮求解的教师
 */
export function solve(data, plan, commitments = new Map(), strategy = 'max-match', options = {}) {
  const busyTeacherIds = options.busyTeacherIds ?? new Set();
  const teachers = byId(data.teachers);
  const mentors = byId(data.mentors);
  const loads = planLoads(data, plan, commitments);
  const lockedTeacherIds = new Set((plan.locks ?? []).map((l) => l.teacherId));

  const matches = [];
  const lockProblems = [];

  // 1) 人工/求解锁定的结对：固定边。锁定时服务层已校验，这里防御性复检。
  for (const lock of plan.locks ?? []) {
    const t = teachers.get(lock.teacherId);
    const m = mentors.get(lock.mentorId);
    if (!t || !m) {
      lockProblems.push({ teacherId: lock.teacherId, mentorId: lock.mentorId, kinds: ['excluded'] });
      continue;
    }
    const ev = evaluatePair(t, m, data);
    const load = loads.get(m.id);
    const overCapacity = load.committed + load.locked > m.capacity;
    if (!ev.ok || overCapacity) {
      lockProblems.push({
        teacherId: t.id,
        mentorId: m.id,
        kinds: overCapacity && ev.ok ? [...ev.kinds, 'capacity'] : ev.kinds,
      });
      continue;
    }
    matches.push({
      teacherId: t.id,
      mentorId: m.id,
      source: lock.source ?? 'manual-lock',
      preferenceHits: ev.preferenceHits,
    });
  }

  // 2) 剩余教师与可用名额建图。
  const freeTeacherIds = data.teachers
    .filter((t) => t.active)
    .map((t) => t.id)
    .filter((id) => !lockedTeacherIds.has(id))
    .filter((id) => !busyTeacherIds.has(id))
    .filter((id) => !(plan.excludedTeacherIds ?? []).includes(id))
    .sort();

  const openMentorIds = data.mentors
    .filter((m) => !(plan.excludedMentorIds ?? []).includes(m.id))
    .map((m) => m.id)
    .sort();

  const edges = []; // {t, m, feasible, kinds, score}
  const adjacency = new Map();
  for (const tid of freeTeacherIds) adjacency.set(tid, []);
  for (const tid of freeTeacherIds) {
    const t = teachers.get(tid);
    for (const mid of openMentorIds) {
      const m = mentors.get(mid);
      const ev = evaluatePair(t, m, data);
      const edge = { teacherId: tid, mentorId: mid, feasible: ev.ok, kinds: ev.kinds, score: ev.preferenceScore, hits: ev.preferenceHits };
      edges.push(edge);
      if (ev.ok) adjacency.get(tid).push(edge);
    }
  }

  const slots = new Map();
  for (const mid of openMentorIds) {
    const m = mentors.get(mid);
    const l = loads.get(mid);
    slots.set(mid, Math.max(0, m.capacity - l.committed - l.locked));
  }

  const assignment = minCostMaxMatch(freeTeacherIds, openMentorIds, adjacency, slots, strategy);

  for (const [tid, mid] of assignment) {
    const edge = edges.find((e) => e.teacherId === tid && e.mentorId === mid);
    matches.push({ teacherId: tid, mentorId: mid, source: 'solver', preferenceHits: edge?.hits ?? [] });
    loads.get(mid).matched += 1;
  }

  // 3) 未匹配教师的可解释原因。
  const unmatched = [];
  for (const tid of freeTeacherIds) {
    if (assignment.has(tid)) continue;
    const blockers = [];
    const kindCounts = Object.fromEntries(allRejectKinds.map((k) => [k, 0]));
    for (const e of edges.filter((e) => e.teacherId === tid)) {
      const kinds = e.kinds.length ? e.kinds : ['capacity'];
      blockers.push({ mentorId: e.mentorId, kinds });
      for (const k of kinds) kindCounts[k] += 1;
    }
    unmatched.push({ teacherId: tid, blockers, kindCounts });
  }
  // 被排除的教师同样给出原因，方便草案对比。
  for (const tid of plan.excludedTeacherIds ?? []) {
    unmatched.push({ teacherId: tid, excluded: true, blockers: [], kindCounts: { excluded: 1 } });
  }

  const mentorLoads = [...loads.entries()].map(([mentorId, l]) => {
    const m = mentors.get(mentorId);
    return {
      mentorId,
      capacity: m.capacity,
      committed: l.committed,
      locked: l.locked,
      matched: l.matched,
      remaining: Math.max(0, m.capacity - l.committed - l.locked - l.matched),
    };
  });

  const totalScore = matches.reduce((sum, x) => sum + (x.preferenceHits?.length ?? 0), 0);
  return {
    strategy,
    matches: matches.sort((a, b) => a.teacherId.localeCompare(b.teacherId)),
    unmatched: unmatched.sort((a, b) => a.teacherId.localeCompare(b.teacherId)),
    mentorLoads,
    lockProblems,
    summary: {
      teacherCount: freeTeacherIds.length + lockedTeacherIds.size,
      matchedCount: matches.length,
      unmatchedCount: unmatched.length + lockProblems.length,
      preferenceScore: totalScore,
    },
  };
}

// 最小费用最大流（逐次最短路，Bellman-Ford；规模小、含负费用与残量反向边）。
// 保证最大匹配数；strategy=preference-first 时费用含偏好，使同匹配数下偏好总分最高。
// 等费用时按 mentor 序号打破平局，保证结果确定。
function minCostMaxMatch(teacherIds, mentorIds, adjacency, slots, strategy) {
  const TIE_BASE = 100000; // 远大于单条增广路上序号之和
  const S = 0;
  const tNode = (i) => 1 + i;
  const mNode = (j) => 1 + teacherIds.length + j;
  const SINK = 1 + teacherIds.length + mentorIds.length;
  const N = SINK + 1;

  const graph = Array.from({ length: N }, () => []);
  const addEdge = (from, to, cap, cost) => {
    const f = { to, cap, cost, rev: graph[to].length };
    const r = { to: from, cap: 0, cost: -cost, rev: graph[from].length };
    graph[from].push(f);
    graph[to].push(r);
    return f;
  };

  teacherIds.forEach((_, i) => addEdge(S, tNode(i), 1, 0));
  mentorIds.forEach((mid, j) => addEdge(mNode(j), SINK, slots.get(mid) ?? 0, 0));
  teacherIds.forEach((tid, i) => {
    for (const e of adjacency.get(tid) ?? []) {
      const j = mentorIds.indexOf(e.mentorId);
      if ((slots.get(e.mentorId) ?? 0) <= 0) continue;
      const pref = strategy === 'preference-first' ? e.score : 0;
      addEdge(tNode(i), mNode(j), 1, -pref * TIE_BASE + j);
    }
  });

  const flow = new Map(); // teacherId -> mentorId
  while (true) {
    const dist = Array(N).fill(Infinity);
    const prev = Array(N).fill(null);
    dist[S] = 0;
    // Bellman-Ford：最多 N-1 轮松弛（边按固定顺序扫描，平局确定）。
    // 该残量网络按最短增广路推进时不存在可达负环。
    for (let pass = 0; pass < N - 1; pass++) {
      let changed = false;
      for (let v = 0; v < N; v++) {
        if (dist[v] === Infinity) continue;
        for (let ei = 0; ei < graph[v].length; ei++) {
          const e = graph[v][ei];
          if (e.cap > 0 && dist[e.to] > dist[v] + e.cost) {
            dist[e.to] = dist[v] + e.cost;
            prev[e.to] = { v, ei };
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (dist[SINK] === Infinity) break;
    // 先收集增广路再按 S→汇点的正向应用：交替路上"撤销旧配对(m→t)"后
    // 紧跟"建立新配对(t→m')"，反向处理会把刚写入的新分配误删。
    const steps = [];
    for (let v = SINK; v !== S; v = prev[v].v) steps.push(prev[v]);
    const isTeacherNode = (x) => x >= 1 && x <= teacherIds.length;
    const isMentorNode = (x) => x > teacherIds.length && x <= teacherIds.length + mentorIds.length;
    for (const { v: pv, ei } of steps.reverse()) {
      const e = graph[pv][ei];
      e.cap -= 1;
      graph[e.to][e.rev].cap += 1;
      if (isTeacherNode(pv) && isMentorNode(e.to)) {
        flow.set(teacherIds[pv - 1], mentorIds[e.to - 1 - teacherIds.length]);
      } else if (isMentorNode(pv) && isTeacherNode(e.to)) {
        flow.delete(teacherIds[e.to - 1]);
      }
    }
  }
  return flow;
}

// 单个教师视角的候选导师清单（管理界面"可解释候选方案"）。
export function explainCandidates(data, plan, commitments, teacherId) {
  const teacher = data.teachers.find((t) => t.id === teacherId);
  if (!teacher) throw new Error(`unknown teacher ${teacherId}`);
  const loads = planLoads(data, plan, commitments);
  const lockedMentorByTeacher = new Map((plan.locks ?? []).map((l) => [l.teacherId, l.mentorId]));
  const candidates = data.mentors
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((mentor) => {
      const excluded = (plan.excludedMentorIds ?? []).includes(mentor.id);
      const ev = evaluatePair(teacher, mentor, data, { isExcluded: excluded });
      const load = loads.get(mentor.id);
      const remaining = Math.max(0, mentor.capacity - load.committed - load.locked);
      const kinds = [...ev.kinds];
      if (ev.ok && remaining <= 0) kinds.push('capacity');
      return {
        mentorId: mentor.id,
        feasible: kinds.length === 0,
        kinds,
        details: kinds.map((k) => REASON_DETAIL[k]),
        preferenceHits: ev.preferenceHits,
        capacity: mentor.capacity,
        remaining,
        lockedByThisTeacher: lockedMentorByTeacher.get(teacher.id) === mentor.id,
      };
    });
  return {
    teacherId,
    feasibleCount: candidates.filter((c) => c.feasible).length,
    candidates,
  };
}

// 对比两版草案的未匹配原因，供负责人选版发布。
export function diffUnmatched(resultA, resultB) {
  const map = (r) => new Map(r.unmatched.map((u) => [u.teacherId, u.kindCounts ?? {}]));
  const a = map(resultA);
  const b = map(resultB);
  const matchedA = new Set(resultA.matches.map((m) => m.teacherId));
  const matchedB = new Set(resultB.matches.map((m) => m.teacherId));
  const ids = new Set([...a.keys(), ...b.keys(), ...matchedA, ...matchedB]);
  const rows = [];
  for (const id of [...ids].sort()) {
    rows.push({
      teacherId: id,
      statusA: a.has(id) ? 'unmatched' : 'matched',
      statusB: b.has(id) ? 'unmatched' : 'matched',
      kindCountsA: a.get(id) ?? null,
      kindCountsB: b.get(id) ?? null,
    });
  }
  return {
    matchedA: resultA.summary.matchedCount,
    matchedB: resultB.summary.matchedCount,
    rows,
  };
}
