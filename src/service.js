// 业务服务层：把匹配引擎与存储串成一致流程。
//
// 并发：store.revise 串行提交；计划与邀请各自带版本号，
//   写入必须带 expectedVersion，版本不符抛 ConflictError ——
//   两位管理员同时调整时后者会被拒绝而不是悄悄覆盖。
// 可追溯：每次状态变化写审计；培养记录只追加/终结，不删除。

import { randomUUID } from 'node:crypto';
import {
  changeKinds,
  deriveInvitationStatus,
  draftStrategies,
  endReasons,
  enrollmentStatuses,
  planStates,
  waitlistStatuses,
} from './domain.js';
import { diffUnmatched, evaluatePair, explainCandidates, solve } from './matching.js';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

export class Service {
  constructor(store, { invitationTtlDays = 14 } = {}) {
    this.store = store;
    this.ttl = invitationTtlDays * DAY_MS;
  }

  // ---------- 基础资料 ----------

  async importData(data, actor = 'admin') {
    return this.store.revise(
      (s) => {
        if (Array.isArray(data.teachers)) s.teachers = data.teachers.map(withActive);
        if (Array.isArray(data.mentors)) s.mentors = data.mentors.map(withStatus);
        if (data.compatibility) s.compatibility = data.compatibility;
        if (Array.isArray(data.avoidances)) s.avoidances = data.avoidances;
        if (Array.isArray(data.preferences)) s.preferences = data.preferences;
        return { action: 'data-import', details: { teachers: s.teachers.length, mentors: s.mentors.length } };
      },
      { actor }
    );
  }

  // ---------- 草案：试排 / 锁定 / 排除 ----------

  async createDraft({ name, strategy = 'max-match', actor = 'admin' } = {}) {
    if (!draftStrategies.includes(strategy)) throw new ValidationError(`unknown strategy ${strategy}`);
    let planId;
    await this.store.revise(
      (s) => {
        planId = `P-${s.plans.length + 1}-${randomUUID().slice(0, 8)}`;
        s.plans.push({
          id: planId,
          name: name ?? `草案 ${s.plans.length + 1}`,
          state: 'draft',
          strategy,
          version: 1,
          createdAt: now(),
          createdBy: actor,
          locks: [], // {teacherId, mentorId, source, at, by}
          excludedTeacherIds: [],
          excludedMentorIds: [],
          matches: null, // 发布时固化；草案期不缓存，始终即时求解
          publishedAt: null,
          supersedesPlanId: null,
        });
        return { action: 'draft-create', planId, details: { name, strategy } };
      },
      { actor }
    );
    return this.getPlan(planId);
  }

  // 即时求解（不落库），负责人可反复试排并比较不同草案。
  previewPlan(planId) {
    const s = this.store.state;
    const plan = mustFind(s.plans, planId);
    if (plan.state !== 'draft') throw new ConflictError(`plan ${planId} is ${plan.state}, not editable`);
    const busy = new Set(busyTeacherIds(s));
    const result = solve(s, plan, commitments(s), plan.strategy, { busyTeacherIds: busy });
    return { plan: planView(plan), result };
  }

  previewPairCandidates(planId, teacherId) {
    const s = this.store.state;
    const plan = mustFind(s.plans, planId);
    return explainCandidates(s, plan, commitments(s), teacherId);
  }

  compareDrafts(planIdA, planIdB) {
    const a = this.previewPlan(planIdA).result;
    const b = this.previewPlan(planIdB).result;
    return diffUnmatched(a, b);
  }

  async setStrategy(planId, expectedVersion, strategy, actor = 'admin') {
    if (!draftStrategies.includes(strategy)) throw new ValidationError(`unknown strategy ${strategy}`);
    return this._revisePlan(planId, expectedVersion, actor, 'draft-strategy', (plan) => {
      plan.strategy = strategy;
      return { strategy };
    });
  }

  // 管理员锁定一个人工安排：校验硬约束与容量；锁定后求解器固定保留该结对。
  async lockPair(planId, expectedVersion, teacherId, mentorId, actor = 'admin') {
    const s = this.store.state;
    const teacher = mustFind(s.teachers, teacherId, 'teacher');
    const mentor = mustFind(s.mentors, mentorId, 'mentor');
    const ev = evaluatePair(teacher, mentor, s);
    if (!ev.ok) throw new ValidationError(`hard constraints violated: ${ev.kinds.join(', ')}`);
    return this._revisePlan(planId, expectedVersion, actor, changeKinds[0] /* manual-lock */, (plan, state) => {
      if (busyTeacherIds(state).includes(teacherId)) {
        throw new ConflictError(`teacher ${teacherId} already has an active enrollment or pending invitation`);
      }
      if (plan.locks.some((l) => l.teacherId === teacherId)) {
        throw new ConflictError(`teacher ${teacherId} already locked in this draft`);
      }
      // 容量 = 已发布在培 + 本草案其他锁定（固化后会与在培一起占用名额）。
      const used = (commitments(state).get(mentorId) ?? 0) + plan.locks.filter((l) => l.mentorId === mentorId).length;
      if (used >= mentor.capacity) throw new ConflictError(`mentor ${mentorId} capacity exceeded`);
      plan.locks.push({ teacherId, mentorId, source: 'manual-lock', at: now(), by: actor });
      return { teacherId, mentorId };
    });
  }

  async unlockPair(planId, expectedVersion, teacherId, actor = 'admin') {
    return this._revisePlan(planId, expectedVersion, actor, 'manual-unlock', (plan) => {
      const before = plan.locks.length;
      plan.locks = plan.locks.filter((l) => l.teacherId !== teacherId);
      if (plan.locks.length === before) throw new NotFoundError(`no lock for teacher ${teacherId}`);
      return { teacherId };
    });
  }

  async setExcluded(planId, expectedVersion, { teacherIds: inTeacherIds = [], mentorIds: inMentorIds = [] }, actor = 'admin') {
    return this._revisePlan(planId, expectedVersion, actor, 'draft-exclusions', (plan) => {
      const teacherIds = [...new Set(inTeacherIds)].sort();
      const mentorIds = [...new Set(inMentorIds)].sort();
      // 排除与锁定冲突时拒绝，避免锁定悄悄失效（先校验后写入，失败不留脏状态）。
      for (const l of plan.locks) {
        if (teacherIds.includes(l.teacherId) || mentorIds.includes(l.mentorId)) {
          throw new ConflictError(`exclusion conflicts with lock ${l.teacherId}->${l.mentorId}`);
        }
      }
      plan.excludedTeacherIds = teacherIds;
      plan.excludedMentorIds = mentorIds;
      return { teacherIds, mentorIds };
    });
  }

  async _revisePlan(planId, expectedVersion, actor, action, fn) {
    await this.store.revise(
      (state) => {
        const plan = mustFind(state.plans, planId);
        if (plan.state !== 'draft') throw new ConflictError(`plan ${planId} is ${plan.state}, not editable`);
        if (plan.version !== expectedVersion) {
          throw new ConflictError(`version mismatch: draft is v${plan.version}, you edited v${expectedVersion}`);
        }
        const details = fn(plan, state) ?? {};
        plan.version += 1;
        return { action, planId, details };
      },
      { actor }
    );
    return this.getPlan(planId);
  }

  getPlan(planId) {
    const s = this.store.state;
    const plan = mustFind(s.plans, planId);
    if (plan.state === 'draft') {
      const busy = new Set(busyTeacherIds(s));
      return { plan: planView(plan), result: solve(s, plan, commitments(s), plan.strategy, { busyTeacherIds: busy }) };
    }
    return { plan: planView(plan), result: planSolutionView(plan) };
  }

  listPlans() {
    return this.store.state.plans
      .map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        strategy: p.strategy,
        version: p.version,
        createdAt: p.createdAt,
        publishedAt: p.publishedAt,
        supersedesPlanId: p.supersedesPlanId,
        matchedCount: p.matches?.length ?? null,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------- 发布 ----------

  async publishDraft(planId, expectedVersion, actor = 'admin') {
    let created = [];
    await this.store.revise(
      (state) => {
        const plan = mustFind(state.plans, planId);
        if (plan.state !== 'draft') throw new ConflictError(`plan ${planId} is ${plan.state}, cannot publish`);
        if (plan.version !== expectedVersion) {
          throw new ConflictError(`version mismatch: draft is v${plan.version}, you edited v${expectedVersion}`);
        }
        const busy = new Set(busyTeacherIds(state));
        const result = solve(state, plan, commitments(state), plan.strategy, { busyTeacherIds: busy });
        if (result.lockProblems.length) {
          throw new ConflictError(`locks violate current constraints: ${JSON.stringify(result.lockProblems)}`);
        }

        // 就地把草案转为"确认中"版本并固化求解结果；草案的调整过程由审计与 version 保留。
        const versionNo = state.plans.filter((p) => p.releaseVersion != null).length + 1;
        plan.state = 'collecting-confirmations';
        plan.version += 1;
        plan.publishedAt = now();
        plan.publishedBy = actor;
        plan.releaseVersion = versionNo;
        plan.locks = plan.locks.map((l) => ({ ...l }));
        plan.excludedTeacherIds = [...plan.excludedTeacherIds];
        plan.excludedMentorIds = [...plan.excludedMentorIds];
        plan.matches = result.matches.map((m) => ({
          teacherId: m.teacherId,
          mentorId: m.mentorId,
          source: m.source,
          preferenceHits: [...(m.preferenceHits ?? [])],
        }));
        plan.unmatched = result.unmatched;
        plan.summary = result.summary;

        // 未入选的其他草案作废，负责人只能发布其中一版。
        for (const p of state.plans) {
          if (p.id !== plan.id && p.state === 'draft') {
            p.state = 'superseded';
            p.supersededById = plan.id;
          }
        }

        // 为匹配教师发邀请（求解时已排除已有在培/待处理邀请的教师）。
        created = createInvitationsForRelease(state, plan, { ttl: this.ttl, actor });
        const events = [
          { action: 'plan-publish', planId: plan.id, details: { releaseVersion: versionNo, matches: plan.matches.length, invitations: created.length } },
          ...created.map((inv) => ({
            action: 'invitation-create',
            planId: plan.id,
            entityId: inv.id,
            details: { teacherId: inv.teacherId, mentorId: inv.mentorId },
          })),
        ];
        // 发布版未匹配的教师（人工排除的除外）直接进入候补，后续可补排。
        for (const u of result.unmatched) {
          if (u.excluded) continue;
          const w = {
            id: `W-${randomUUID().slice(0, 10)}`,
            teacherId: u.teacherId,
            planId: plan.id,
            preferredMentorId: null,
            status: 'waiting',
            createdAt: now(),
            createdBy: actor,
            history: [{ at: now(), reason: 'unmatched-in-release' }],
          };
          state.waitlist.push(w);
          events.push({ action: 'waitlist-join', planId: plan.id, entityId: w.id, details: { teacherId: u.teacherId, reason: 'unmatched-in-release' } });
        }
        return events;
      },
      { actor }
    );
    return { ...this.getPlan(planId), createdInvitations: created.map(invitationView) };
  }

  // 双方确认完成或管理员在收集结束后，将计划标记为已发布生效。
  async finalizeRelease(planId, actor = 'admin') {
    await this.store.revise(
      (state) => {
        const plan = mustFind(state.plans, planId);
        if (plan.state !== 'collecting-confirmations') {
          throw new ConflictError(`plan ${planId} is ${plan.state}`);
        }
        // 定稿前先把已过期的邀请扫掉，候补状态与实际一致。
        const events = sweepExpired(state, new Date(), actor);
        const pending = state.invitations.filter((i) => i.planId === planId && invitationOpen(i));
        if (pending.length > 0) throw new ConflictError(`${pending.length} invitations still pending`);
        plan.state = 'published';
        events.push({ action: 'plan-finalize', planId, details: {} });
        return events;
      },
      { actor }
    );
    return this.getPlan(planId);
  }

  // ---------- 确认：邀请 / 接受 / 拒绝 ----------

  async respondInvitation(invitationId, party, resp, { expectedVersion, actor } = {}) {
    if (!['mentor', 'teacher'].includes(party)) throw new ValidationError('party must be mentor or teacher');
    if (!['accepted', 'declined'].includes(resp)) throw new ValidationError('response must be accepted or declined');
    let result;
    await this.store.revise(
      (state) => {
        const inv = mustFind(state.invitations, invitationId, 'invitation');
        if (expectedVersion != null && inv.version !== expectedVersion) {
          throw new ConflictError(`invitation version mismatch: is v${inv.version}, you saw v${expectedVersion}`);
        }
        if (!invitationOpen(inv)) throw new ConflictError(`invitation is ${deriveInvitationStatus(inv)}`);
        // 双方各自独立存储：导师的确认永远不会覆盖教师已给出的结果，反之亦然。
        const slot = party === 'mentor' ? 'mentorResponse' : 'teacherResponse';
        const history = party === 'mentor' ? 'mentorHistory' : 'teacherHistory';
        inv[history] = inv[history] ?? [];
        // 已答复过的一方改答案：在未整体结束前允许改，但保留原承诺历史。
        if (inv[slot]) inv[history].push({ ...inv[slot], supersededAt: now() });
        inv[slot] = { state: resp, at: now(), by: actor ?? party };
        inv.version += 1;

        const events = [
          {
            action: 'invitation-respond',
            planId: inv.planId,
            entityId: inv.id,
            details: { party, state: resp },
          },
        ];

        const overall = deriveInvitationStatus(inv);
        if (overall === 'accepted') {
          activateEnrollment(state, inv, actor ?? party);
          events.push({ action: 'enrollment-activate', planId: inv.planId, entityId: inv.enrollmentId, details: { teacherId: inv.teacherId, mentorId: inv.mentorId, invitationId: inv.id } });
          // 该教师其他候补自动取消。
          for (const w of state.waitlist.filter((w) => w.teacherId === inv.teacherId && w.status === 'waiting')) {
            w.status = 'cancelled';
            w.history.push({ at: now(), to: 'cancelled', reason: 'enrollment-activated' });
            events.push({ action: 'waitlist-cancel', planId: inv.planId, entityId: w.id, details: { teacherId: inv.teacherId } });
          }
        } else if (overall === 'declined') {
          // 任一方拒绝：邀请终结，承诺不变（尚无培养记录），教师进入候补，保留原承诺可追溯。
          events.push(...waitlistReopenEvents(reopenWaitlistForInvitation(state, inv), inv));
          for (const e of waitlistAuditEvents(inv, ensureWaitlist(state, inv, actor ?? party))) events.push(e);
        }
        result = invitationView(findInv(state, inv.id));
        return events;
      },
      { actor: actor ?? party }
    );
    return result;
  }

  // 管理员过期处理（也可由定时任务调用）：过期邀请转入候补。
  async expireInvitations(nowTs = new Date(), actor = 'system') {
    const expired = [];
    await this.store.revise(
      (state) => {
        const events = sweepExpired(state, nowTs, actor, expired);
        return events;
      },
      { actor }
    );
    return expired;
  }

  // ---------- 发布后变更：换导师 / 退出 / 停带 / 候补 ----------

  // 换导师：每次调换都有依据（原因、审批人），原培养记录终结保留，
  // 向新导师发邀请；容量与硬约束按当前资料实时校验。
  async reassign(teacherId, newMentorId, reason, actor = 'admin') {
    if (!reason || !String(reason).trim()) throw new ValidationError('reason is required for reassignment');
    let invitationId;
    await this.store.revise(
      (state) => {
        const teacher = mustFind(state.teachers, teacherId, 'teacher');
        const mentor = mustFind(state.mentors, newMentorId, 'mentor');
        if (!teacher.active) throw new ConflictError('teacher has exited');
        const ev = evaluatePair(teacher, mentor, state);
        if (!ev.ok) throw new ValidationError(`hard constraints violated: ${ev.kinds.join(', ')}`);
        const active = activeEnrollmentsOf(state, teacherId);
        if (!active.length) throw new ConflictError('teacher has no active enrollment; use a published plan invitation flow');
        if (active.some((e) => e.mentorId === newMentorId)) throw new ConflictError('teacher already with that mentor');
        if ((commitments(state).get(newMentorId) ?? 0) >= mentor.capacity) {
          throw new ConflictError(`mentor ${newMentorId} at capacity`);
        }
        if (state.invitations.some((i) => i.teacherId === teacherId && invitationOpen(i))) {
          throw new ConflictError('teacher already has a pending invitation');
        }

        const planId = latestPublishedPlanId(state);
        const events = [];
        for (const enr of active) {
          endEnrollment(state, enr, 'reassignment', { reason, by: actor, newMentorId });
          events.push({
            action: 'enrollment-end',
            planId: enr.planId,
            entityId: enr.id,
            details: { teacherId, fromMentorId: enr.mentorId, reason: 'reassignment', note: reason },
          });
        }
        const inv = makeInvitation(state, {
          planId,
          teacherId,
          mentorId: newMentorId,
          source: 'reassignment',
          reason,
          ttl: this.ttl,
          by: actor,
        });
        invitationId = inv.id;
        events.push({
          action: changeKinds[1] /* reassignment */,
          planId,
          entityId: inv.id,
          details: { teacherId, fromMentorId: active[0].mentorId, toMentorId: newMentorId, reason },
        });
        return events;
      },
      { actor }
    );
    return this.getInvitation(invitationId);
  }

  // 教师退出：取消其待处理邀请，在培记录以 teacher-exit 终结，历史培养记录原样保留。
  async teacherExit(teacherId, reason, actor = 'admin') {
    await this.store.revise(
      (state) => {
        const teacher = mustFind(state.teachers, teacherId, 'teacher');
        const events = [];
        teacher.active = false;
        teacher.exitAt = now();
        for (const inv of state.invitations.filter((i) => i.teacherId === teacherId && invitationOpen(i))) {
          inv.lifecycleStatus = 'cancelled';
          inv.cancelReason = 'teacher-exit';
          inv.version += 1;
          events.push({ action: 'invitation-cancel', planId: inv.planId, entityId: inv.id, details: { teacherId, reason } });
        }
        for (const enr of activeEnrollmentsOf(state, teacherId)) {
          endEnrollment(state, enr, 'teacher-exit', { reason, by: actor });
          events.push({ action: changeKinds[3], planId: enr.planId, entityId: enr.id, details: { teacherId, mentorId: enr.mentorId, note: reason } });
        }
        for (const w of state.waitlist.filter((w) => w.teacherId === teacherId && w.status !== 'cancelled')) {
          w.status = 'cancelled';
          w.history.push({ at: now(), to: 'cancelled', reason: 'teacher-exit' });
          events.push({ action: 'waitlist-cancel', planId: w.planId, entityId: w.id, details: { teacherId } });
        }
        if (!events.length) return;
        return [{ action: changeKinds[3], details: { teacherId, note: reason } }, ...events];
      },
      { actor }
    );
  }

  // 导师临时停带：取消其待处理邀请（相关教师候补），在培记录保留。
  async mentorPause(mentorId, reason, actor = 'admin') {
    await this.store.revise(
      (state) => {
        const mentor = mustFind(state.mentors, mentorId, 'mentor');
        if (mentor.status === 'paused') throw new ConflictError('mentor already paused');
        mentor.status = 'paused';
        mentor.pausedAt = now();
        const events = [{ action: changeKinds[4], details: { mentorId, note: reason } }];
        for (const inv of state.invitations.filter((i) => i.mentorId === mentorId && invitationOpen(i))) {
          inv.lifecycleStatus = 'cancelled';
          inv.cancelReason = 'mentor-paused';
          inv.version += 1;
          events.push({ action: 'invitation-cancel', planId: inv.planId, entityId: inv.id, details: { mentorId, teacherId: inv.teacherId } });
          events.push(...waitlistReopenEvents(reopenWaitlistForInvitation(state, inv), inv));
          for (const e of waitlistAuditEvents(inv, ensureWaitlist(state, inv, actor))) events.push(e);
        }
        return events;
      },
      { actor }
    );
  }

  async mentorResume(mentorId, actor = 'admin') {
    await this.store.revise(
      (state) => {
        const mentor = mustFind(state.mentors, mentorId, 'mentor');
        if (mentor.status !== 'paused') throw new ConflictError('mentor not paused');
        mentor.status = 'active';
        mentor.resumedAt = now();
        return { action: changeKinds[5], details: { mentorId } };
      },
      { actor }
    );
  }

  // 候补教师获得新邀请（管理员指定导师，容量与硬约束实时校验）。
  async assignFromWaitlist(waitlistId, mentorId, actor = 'admin') {
    let invitationId;
    await this.store.revise(
      (state) => {
        const w = mustFind(state.waitlist, waitlistId, 'waitlist entry');
        if (w.status !== 'waiting') throw new ConflictError(`waitlist entry is ${w.status}`);
        const teacher = mustFind(state.teachers, w.teacherId, 'teacher');
        const mentor = mustFind(state.mentors, mentorId, 'mentor');
        if (!teacher.active) throw new ConflictError('teacher has exited');
        const ev = evaluatePair(teacher, mentor, state);
        if (!ev.ok) throw new ValidationError(`hard constraints violated: ${ev.kinds.join(', ')}`);
        if ((commitments(state).get(mentorId) ?? 0) >= mentor.capacity) throw new ConflictError('mentor at capacity');
        if (state.invitations.some((i) => i.teacherId === teacher.id && invitationOpen(i))) {
          throw new ConflictError('teacher already has a pending invitation');
        }
        const inv = makeInvitation(state, {
          planId: w.planId,
          teacherId: teacher.id,
          mentorId,
          source: 'waitlist-assignment',
          ttl: this.ttl,
          by: actor,
        });
        invitationId = inv.id;
        w.status = 'fulfilled';
        w.fulfilledBy = inv.id;
        w.history.push({ at: now(), to: 'fulfilled', mentorId, invitationId: inv.id });
        return [
          { action: changeKinds[2], planId: w.planId, entityId: inv.id, details: { teacherId: teacher.id, mentorId } },
          { action: 'waitlist-fulfill', planId: w.planId, entityId: w.id, details: { invitationId: inv.id } },
        ];
      },
      { actor }
    );
    return this.getInvitation(invitationId);
  }

  // ---------- 查询 ----------

  getInvitation(invitationId) {
    return invitationView(mustFind(this.store.state.invitations, invitationId, 'invitation'));
  }

  // 教师只看到与自己有关的结果：当前结对、邀请、候补、历史培养记录（可追溯到发布版本）。
  teacherView(teacherId) {
    const s = this.store.state;
    const teacher = mustFind(s.teachers, teacherId, 'teacher');
    return {
      teacher: { id: teacher.id, name: teacher.name, subject: teacher.subject, school: teacher.school, active: teacher.active },
      enrollments: s.enrollments.filter((e) => e.teacherId === teacherId).map(enrollmentView),
      invitations: s.invitations.filter((i) => i.teacherId === teacherId).map(invitationView),
      waitlist: s.waitlist.filter((w) => w.teacherId === teacherId).map(waitlistView),
    };
  }

  mentorView(mentorId) {
    const s = this.store.state;
    const mentor = mustFind(s.mentors, mentorId, 'mentor');
    return {
      mentor: { id: mentor.id, name: mentor.name, subjects: mentor.subjects, school: mentor.school, status: mentor.status },
      invitations: s.invitations.filter((i) => i.mentorId === mentorId).map(invitationView),
      activeMentees: s.enrollments
        .filter((e) => e.mentorId === mentorId && e.status === 'active')
        .map((e) => ({ teacherId: e.teacherId, since: e.startedAt, planId: e.planId })),
    };
  }

  waitlist() {
    return this.store.state.waitlist.map(waitlistView);
  }

  audit({ entityId, planId } = {}) {
    return this.store.state.audit
      .filter((e) => (entityId ? e.entityId === entityId : true))
      .filter((e) => (planId ? e.planId === planId : true));
  }
}

// ============ 纯函数辅助 ============

function withActive(t) {
  return { active: true, ...t };
}
function withStatus(m) {
  return { status: 'active', ...m };
}

function mustFind(list, id, label = 'plan') {
  const x = list.find((y) => y.id === id);
  if (!x) throw new NotFoundError(`${label} ${id} not found`);
  return x;
}
function findInv(state, id) {
  return state.invitations.find((i) => i.id === id);
}

function now() {
  return new Date().toISOString();
}

// 容量口径：当前在培 + 待处理邀请（已发出的承诺占名额）。
function commitmentMap(state) {
  const map = new Map();
  for (const e of state.enrollments) if (e.status === 'active') map.set(e.mentorId, (map.get(e.mentorId) ?? 0) + 1);
  for (const i of state.invitations) if (invitationOpen(i)) map.set(i.mentorId, (map.get(i.mentorId) ?? 0) + 1);
  return map;
}
const commitments = commitmentMap;

function busyTeacherIds(state) {
  const ids = [];
  for (const e of state.enrollments) if (e.status === 'active') ids.push(e.teacherId);
  for (const i of state.invitations) if (invitationOpen(i)) ids.push(i.teacherId);
  return ids;
}

function activeEnrollmentsOf(state, teacherId) {
  return state.enrollments.filter((e) => e.teacherId === teacherId && e.status === 'active');
}

function latestPublishedPlanId(state) {
  const p = state.plans
    .filter((x) => x.state === 'published' || x.state === 'collecting-confirmations')
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  return p?.id ?? null;
}

function invitationOpen(inv, nowTs = new Date()) {
  const st = deriveInvitationStatus(inv, nowTs);
  return st === 'pending';
}

// 扫描并过期所有已到时限的待处理邀请，返回审计事件。
function sweepExpired(state, nowTs, actor, expiredOut = null) {
  const events = [];
  for (const inv of state.invitations) {
    if (inv.lifecycleStatus !== 'pending') continue;
    const current = deriveInvitationStatus(inv);
    if (current === 'accepted' || current === 'declined') continue;
    if (new Date(inv.expiresAt).getTime() >= nowTs.getTime()) continue;
    inv.lifecycleStatus = 'expired';
    inv.version += 1;
    expiredOut?.push(inv.id);
    events.push({ action: 'invitation-expire', planId: inv.planId, entityId: inv.id, details: { teacherId: inv.teacherId } });
    events.push(...waitlistReopenEvents(reopenWaitlistForInvitation(state, inv), inv));
    for (const e of waitlistAuditEvents(inv, ensureWaitlist(state, inv, actor))) events.push(e);
  }
  return events;
}

function makeInvitation(state, { planId, teacherId, mentorId, source, reason = null, ttl, by }) {
  const inv = {
    id: `I-${randomUUID().slice(0, 10)}`,
    planId,
    releaseVersion: state.plans.find((p) => p.id === planId)?.releaseVersion ?? null,
    teacherId,
    mentorId,
    source, // 'release' | 'reassignment' | 'waitlist-assignment'
    reason,
    createdAt: now(),
    createdBy: by,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    lifecycleStatus: 'pending',
    cancelReason: null,
    version: 1,
    mentorResponse: null,
    teacherResponse: null,
    mentorHistory: [],
    teacherHistory: [],
    enrollmentId: null,
  };
  state.invitations.push(inv);
  return inv;
}

function createInvitationsForRelease(state, plan, { ttl, actor }) {
  const created = [];
  for (const match of plan.matches) {
    if (activeEnrollmentsOf(state, match.teacherId).length) continue; // 保留原承诺
    if (state.invitations.some((i) => i.teacherId === match.teacherId && invitationOpen(i))) continue;
    created.push(makeInvitation(state, { planId: plan.id, teacherId: match.teacherId, mentorId: match.mentorId, source: 'release', ttl, by: actor }));
  }
  return created;
}

function activateEnrollment(state, inv, by) {
  // 发布版上该教师若已有培养记录（例如拒绝后又通过候补重新结对），先终结旧的 pending 概念不存在：
  // enrollment 只在双方接受时创建，因此这里直接新建。
  const enr = {
    id: `E-${randomUUID().slice(0, 10)}`,
    teacherId: inv.teacherId,
    mentorId: inv.mentorId,
    planId: inv.planId,
    releaseVersion: inv.releaseVersion,
    invitationId: inv.id,
    status: 'active',
    startedAt: now(),
    startedBy: by,
    endedAt: null,
    endReason: null,
    endHistory: [], // 换导师/退出时追加，记录不删除
  };
  state.enrollments.push(enr);
  inv.enrollmentId = enr.id;
  return enr;
}

function endEnrollment(state, enr, reason, { by, newMentorId = null, note = null }) {
  if (!endReasons.includes(reason)) throw new Error(`bad end reason ${reason}`);
  enr.status = 'ended';
  enr.endedAt = now();
  enr.endReason = reason;
  enr.endHistory.push({ at: enr.endedAt, reason, by, newMentorId, note });
}

function ensureWaitlist(state, inv, actor) {
  const existing = state.waitlist.find((w) => w.teacherId === inv.teacherId && w.status === 'waiting');
  if (existing) {
    existing.history.push({ at: now(), reason: `invitation ${inv.id} ${deriveInvitationStatus(inv)}`, mentorId: inv.mentorId });
    return { entry: existing, created: false };
  }
  const w = {
    id: `W-${randomUUID().slice(0, 10)}`,
    teacherId: inv.teacherId,
    planId: inv.planId,
    preferredMentorId: inv.mentorId,
    status: 'waiting',
    createdAt: now(),
    createdBy: actor,
    history: [{ at: now(), reason: `invitation ${inv.id} did not confirm`, mentorId: inv.mentorId }],
  };
  state.waitlist.push(w);
  return { entry: w, created: true };
}

function waitlistAuditEvents(inv, { entry, created }) {
  if (!created) return [];
  return [{ action: 'waitlist-join', planId: inv.planId, entityId: entry.id, details: { teacherId: inv.teacherId, mentorId: inv.mentorId } }];
}

// 候补发出的邀请若最终没结成（拒绝/取消/过期），候补条目回到 waiting 继续等安排。
function reopenWaitlistForInvitation(state, inv) {
  const w = state.waitlist.find((x) => x.fulfilledBy === inv.id && x.status === 'fulfilled');
  if (!w) return null;
  w.status = 'waiting';
  w.fulfilledBy = null;
  w.history.push({ at: now(), to: 'waiting', reason: `invitation ${inv.id} ${deriveInvitationStatus(inv)}` });
  return w;
}
function waitlistReopenEvents(w, inv) {
  return w ? [{ action: 'waitlist-reopen', planId: inv.planId, entityId: w.id, details: { teacherId: inv.teacherId, invitationId: inv.id } }] : [];
}

// ============ 视图 ============

function planView(p) {
  return {
    id: p.id,
    name: p.name,
    state: p.state,
    strategy: p.strategy,
    version: p.version,
    createdAt: p.createdAt,
    createdBy: p.createdBy,
    publishedAt: p.publishedAt ?? null,
    publishedBy: p.publishedBy ?? null,
    releaseVersion: p.releaseVersion ?? null,
    supersedesPlanId: p.supersedesPlanId ?? null,
    supersededById: p.supersededById ?? null,
    locks: p.locks,
    excludedTeacherIds: p.excludedTeacherIds,
    excludedMentorIds: p.excludedMentorIds,
  };
}

function planSolutionView(p) {
  return {
    strategy: p.strategy,
    matches: p.matches,
    unmatched: p.unmatched,
    mentorLoads: null,
    lockProblems: [],
    summary: p.summary,
  };
}

function invitationView(i) {
  return {
    id: i.id,
    planId: i.planId,
    releaseVersion: i.releaseVersion,
    teacherId: i.teacherId,
    mentorId: i.mentorId,
    source: i.source,
    reason: i.reason,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    version: i.version,
    overallStatus: deriveInvitationStatus(i),
    lifecycleStatus: i.lifecycleStatus,
    cancelReason: i.cancelReason,
    mentorResponse: i.mentorResponse,
    teacherResponse: i.teacherResponse,
    enrollmentId: i.enrollmentId,
  };
}

function enrollmentView(e) {
  return {
    id: e.id,
    teacherId: e.teacherId,
    mentorId: e.mentorId,
    planId: e.planId,
    releaseVersion: e.releaseVersion,
    invitationId: e.invitationId,
    status: e.status,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    endReason: e.endReason,
    endHistory: e.endHistory,
  };
}

function waitlistView(w) {
  return {
    id: w.id,
    teacherId: w.teacherId,
    planId: w.planId,
    preferredMentorId: w.preferredMentorId,
    status: w.status,
    createdAt: w.createdAt,
    fulfilledBy: w.fulfilledBy ?? null,
    history: w.history,
  };
}

export const __test = {
  commitmentMap,
  busyTeacherIds,
  invitationOpen,
  deriveInvitationStatus,
  planStates,
  enrollmentStatuses,
  waitlistStatuses,
  changeKinds,
};
