import { solve, evaluatePair, buildAvoidanceMap } from './solver.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  StateError,
} from './errors.js';

const ID_PREFIXES = { plan: 'P', confirmation: 'C', change: 'CH', record: 'TR', event: 'E' };

export class PlannerService {
  constructor(state, options = {}) {
    this.state = state;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---------- 基础工具 ----------

  nextId(kind) {
    this.state.counters[kind] = (this.state.counters[kind] ?? 0) + 1;
    return `${ID_PREFIXES[kind]}-${this.state.counters[kind]}`;
  }

  emit(actor, kind, details = {}) {
    const event = {
      id: this.nextId('event'),
      at: this.now(),
      actor: { role: actor.role, id: actor.id },
      kind,
      ...details,
    };
    this.state.events.push(event);
    return event;
  }

  requireAdmin(actor) {
    if (actor?.role !== 'admin') throw new ForbiddenError('需要管理员权限');
  }

  getTeacher(teacherId) {
    const teacher = this.state.teachers.find((t) => t.id === teacherId);
    if (!teacher) throw new NotFoundError(`教师不存在：${teacherId}`);
    return teacher;
  }

  getMentor(mentorId) {
    const mentor = this.state.mentors.find((m) => m.id === mentorId);
    if (!mentor) throw new NotFoundError(`导师不存在：${mentorId}`);
    return mentor;
  }

  getPlan(planId) {
    const plan = this.state.plans.find((p) => p.id === planId);
    if (!plan) throw new NotFoundError(`方案不存在：${planId}`);
    return plan;
  }

  getConfirmation(confirmationId) {
    const confirmation = this.state.confirmations.find((c) => c.id === confirmationId);
    if (!confirmation) throw new NotFoundError(`确认记录不存在：${confirmationId}`);
    return confirmation;
  }

  // 乐观并发控制：调用方必须基于自己读到的版本修改，版本不符即拒绝，避免悄悄覆盖他人修改
  checkVersion(plan, expectedVersion) {
    if (expectedVersion === undefined || expectedVersion === null) return;
    if (plan.version !== expectedVersion) {
      throw new ConflictError(
        `方案版本冲突：当前版本为 ${plan.version}，请求基于版本 ${expectedVersion}，请刷新后重试`,
        { currentVersion: plan.version },
      );
    }
  }

  touch(plan) {
    plan.version += 1;
    plan.updatedAt = this.now();
  }

  assertPlanState(plan, allowed) {
    if (!allowed.includes(plan.state)) {
      throw new StateError(`方案 ${plan.id} 当前状态为 ${plan.state}，不允许该操作`, {
        state: plan.state,
        allowed,
      });
    }
  }

  // 导师在指定方案内的生效占用（已接受且未被取代/未结束）
  mentorActiveLoad(planId, mentorId) {
    return this.state.confirmations.filter(
      (c) => c.planId === planId && c.mentorId === mentorId && c.state === 'accepted' && !c.supersededBy && !c.endedAt,
    ).length;
  }

  activeConfirmationOf(planId, teacherId) {
    return this.state.confirmations.find(
      (c) => c.planId === planId && c.teacherId === teacherId && c.state === 'accepted' && !c.supersededBy && !c.endedAt,
    );
  }

  assertPairFeasible(teacher, mentor) {
    if (mentor.status === 'paused') throw new ValidationError(`导师 ${mentor.id} 已暂停带教`);
    const violations = evaluatePair(teacher, mentor, buildAvoidanceMap(this.state.avoidance));
    if (violations.length > 0) {
      throw new ValidationError(`违反硬约束：${violations.map((v) => v.detail).join('；')}`, { violations });
    }
  }

  // ---------- 草案与求解 ----------

  createPlan(actor, { name }) {
    this.requireAdmin(actor);
    if (!name?.trim()) throw new ValidationError('方案名称不能为空');
    const plan = {
      id: this.nextId('plan'),
      name: name.trim(),
      state: 'draft',
      version: 1,
      createdBy: actor.id,
      createdAt: this.now(),
      updatedAt: this.now(),
      locks: [],
      solution: null,
      publishedNumber: null,
      publishedAt: null,
      waitlist: [],
    };
    this.state.plans.push(plan);
    this.emit(actor, 'plan-created', { planId: plan.id, name: plan.name });
    return plan;
  }

  listPlans(actor) {
    this.requireAdmin(actor);
    return this.state.plans.map((p) => ({
      id: p.id,
      name: p.name,
      state: p.state,
      version: p.version,
      publishedNumber: p.publishedNumber,
      matched: p.solution?.assignments.length ?? 0,
      unmatched: p.solution?.unmatched.length ?? 0,
      waitlisted: p.waitlist.length,
      updatedAt: p.updatedAt,
    }));
  }

  solvePlan(actor, planId, { expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['draft']);
    this.checkVersion(plan, expectedVersion);
    const result = solve({
      teachers: this.state.teachers,
      mentors: this.state.mentors,
      avoidance: this.state.avoidance,
      locked: plan.locks,
    });
    plan.solution = { ranAt: this.now(), ...result };
    this.touch(plan);
    this.emit(actor, 'plan-solved', {
      planId: plan.id,
      matched: result.assignments.length,
      unmatched: result.unmatched.map((u) => u.teacherId),
    });
    return plan.solution;
  }

  lockAssignment(actor, planId, { teacherId, mentorId, allowOverride = false, expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['draft']);
    this.checkVersion(plan, expectedVersion);
    const teacher = this.getTeacher(teacherId);
    const mentor = this.getMentor(mentorId);
    if (teacher.status === 'withdrawn') throw new ValidationError(`教师 ${teacherId} 已退出`);
    if (mentor.status === 'paused') throw new ValidationError(`导师 ${mentorId} 已暂停带教`);
    if (plan.locks.some((l) => l.teacherId === teacherId)) {
      throw new ConflictError(`教师 ${teacherId} 已有锁定安排，请先解锁`);
    }
    const violations = evaluatePair(teacher, mentor, buildAvoidanceMap(this.state.avoidance));
    let overrideViolations = null;
    if (violations.length > 0) {
      if (!allowOverride) {
        throw new ValidationError(`锁定违反硬约束：${violations.map((v) => v.detail).join('；')}`, { violations });
      }
      overrideViolations = violations;
    }
    const lockedCount = plan.locks.filter((l) => l.mentorId === mentorId).length;
    if (lockedCount >= mentor.capacity) {
      throw new ValidationError(`导师 ${mentorId} 的容量 ${mentor.capacity} 已被其他锁定占满`);
    }
    const lock = { teacherId, mentorId, by: actor.id, at: this.now(), overrideViolations };
    plan.locks.push(lock);
    plan.solution = null; // 锁定变化后需重新求解
    this.touch(plan);
    this.emit(actor, 'assignment-locked', {
      planId: plan.id,
      teacherId,
      mentorId,
      override: Boolean(overrideViolations),
    });
    return lock;
  }

  unlockAssignment(actor, planId, { teacherId, expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['draft']);
    this.checkVersion(plan, expectedVersion);
    const index = plan.locks.findIndex((l) => l.teacherId === teacherId);
    if (index < 0) throw new NotFoundError(`教师 ${teacherId} 没有锁定安排`);
    const [lock] = plan.locks.splice(index, 1);
    plan.solution = null;
    this.touch(plan);
    this.emit(actor, 'assignment-unlocked', { planId: plan.id, teacherId, mentorId: lock.mentorId });
    return lock;
  }

  comparePlans(actor, planIdA, planIdB) {
    this.requireAdmin(actor);
    const a = this.getPlan(planIdA);
    const b = this.getPlan(planIdB);
    if (!a.solution || !b.solution) throw new StateError('两个方案都需要先求解才能比较');
    const assignA = new Map(a.solution.assignments.map((x) => [x.teacherId, x.mentorId]));
    const assignB = new Map(b.solution.assignments.map((x) => [x.teacherId, x.mentorId]));
    const unmatchedA = new Map(a.solution.unmatched.map((u) => [u.teacherId, u]));
    const unmatchedB = new Map(b.solution.unmatched.map((u) => [u.teacherId, u]));
    const teacherIds = [...new Set([...assignA.keys(), ...assignB.keys(), ...unmatchedA.keys(), ...unmatchedB.keys()])].sort();
    const rows = teacherIds.map((teacherId) => ({
      teacherId,
      mentorInA: assignA.get(teacherId) ?? null,
      mentorInB: assignB.get(teacherId) ?? null,
      unmatchedInA: unmatchedA.get(teacherId) ?? null,
      unmatchedInB: unmatchedB.get(teacherId) ?? null,
    }));
    return {
      plans: [
        { id: a.id, name: a.name, matched: assignA.size, unmatched: [...unmatchedA.keys()] },
        { id: b.id, name: b.name, matched: assignB.size, unmatched: [...unmatchedB.keys()] },
      ],
      onlyUnmatchedInA: rows.filter((r) => r.unmatchedInA && !r.unmatchedInB).map((r) => r.teacherId),
      onlyUnmatchedInB: rows.filter((r) => !r.unmatchedInA && r.unmatchedInB).map((r) => r.teacherId),
      reassigned: rows
        .filter((r) => r.mentorInA && r.mentorInB && r.mentorInA !== r.mentorInB)
        .map((r) => ({ teacherId: r.teacherId, from: r.mentorInA, to: r.mentorInB })),
      rows,
    };
  }

  // ---------- 邀请与确认 ----------

  openInvitations(actor, planId, { expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['draft']);
    this.checkVersion(plan, expectedVersion);
    if (!plan.solution) throw new StateError('请先求解再发起邀请');
    const created = plan.solution.assignments.map((a) => ({
      id: this.nextId('confirmation'),
      planId: plan.id,
      publishedNumber: null,
      teacherId: a.teacherId,
      mentorId: a.mentorId,
      origin: 'initial',
      previousConfirmationId: null,
      state: 'pending',
      cause: null,
      note: null,
      createdAt: this.now(),
      respondedAt: null,
      supersededBy: null,
      endedAt: null,
      endCause: null,
    }));
    this.state.confirmations.push(...created);
    plan.state = 'collecting-confirmations';
    this.touch(plan);
    this.emit(actor, 'invitations-opened', { planId: plan.id, count: created.length });
    return created;
  }

  applyResponseSideEffects(actor, plan, confirmation, accepted) {
    const change = this.state.changes.find((ch) => ch.confirmationId === confirmation.id);
    if (confirmation.origin === 'waitlist-promotion') {
      const entryIndex = plan.waitlist.findIndex((w) => w.teacherId === confirmation.teacherId);
      if (accepted) {
        if (entryIndex >= 0) plan.waitlist.splice(entryIndex, 1);
        if (change) change.status = 'accepted';
      } else {
        if (entryIndex >= 0) plan.waitlist[entryIndex].invitedConfirmationId = null;
        if (change) change.status = confirmation.state === 'expired' ? 'expired' : 'declined';
      }
    } else if (confirmation.origin === 'mentor-change') {
      if (accepted) {
        const previous = this.state.confirmations.find((c) => c.id === confirmation.previousConfirmationId);
        if (previous) previous.supersededBy = confirmation.id;
        if (change) change.status = 'accepted';
        this.emit(actor, 'mentor-change-accepted', {
          planId: plan.id,
          changeId: change?.id,
          teacherId: confirmation.teacherId,
          fromMentorId: change?.fromMentorId,
          toMentorId: confirmation.mentorId,
        });
      } else {
        if (change) change.status = confirmation.state === 'expired' ? 'expired' : 'declined';
        this.emit(actor, 'mentor-change-declined', {
          planId: plan.id,
          changeId: change?.id,
          teacherId: confirmation.teacherId,
        });
      }
    }
  }

  respondToConfirmation(actor, confirmationId, { accept, note } = {}) {
    if (actor?.role !== 'teacher') throw new ForbiddenError('仅教师本人可回应邀请');
    if (typeof accept !== 'boolean') throw new ValidationError('accept 必须为布尔值');
    const confirmation = this.getConfirmation(confirmationId);
    if (confirmation.teacherId !== actor.id) throw new ForbiddenError('只能回应发给自己的邀请');
    if (confirmation.state !== 'pending') {
      throw new StateError(`邀请当前状态为 ${confirmation.state}，不能重复回应`);
    }
    const plan = this.getPlan(confirmation.planId);
    this.assertPlanState(plan, ['collecting-confirmations', 'published']);
    if (accept && plan.state === 'published') {
      // 发布后的候补/调换邀请遵循先到先得，接受时再校验一次容量
      const mentor = this.getMentor(confirmation.mentorId);
      if (this.mentorActiveLoad(plan.id, mentor.id) >= mentor.capacity) {
        throw new ConflictError(`导师 ${mentor.id} 名额已满，无法接受该邀请`, { kind: 'capacity' });
      }
    }
    confirmation.state = accept ? 'accepted' : 'declined';
    confirmation.respondedAt = this.now();
    confirmation.note = note ?? null;
    this.applyResponseSideEffects(actor, plan, confirmation, accept);
    this.touch(plan);
    this.emit(actor, 'confirmation-responded', {
      planId: plan.id,
      confirmationId: confirmation.id,
      teacherId: confirmation.teacherId,
      mentorId: confirmation.mentorId,
      result: confirmation.state,
    });
    return confirmation;
  }

  expireConfirmation(actor, confirmationId, { cause = 'admin-expired' } = {}) {
    this.requireAdmin(actor);
    const confirmation = this.getConfirmation(confirmationId);
    if (confirmation.state !== 'pending') throw new StateError('仅待回应的邀请可以作废');
    confirmation.state = 'expired';
    confirmation.cause = cause;
    confirmation.respondedAt = this.now();
    const plan = this.getPlan(confirmation.planId);
    this.applyResponseSideEffects(actor, plan, confirmation, false);
    this.touch(plan);
    this.emit(actor, 'confirmation-expired', {
      planId: plan.id,
      confirmationId: confirmation.id,
      teacherId: confirmation.teacherId,
      cause,
    });
    return confirmation;
  }

  // ---------- 发布 ----------

  publishPlan(actor, planId, { expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['collecting-confirmations']);
    this.checkVersion(plan, expectedVersion);
    const pending = this.state.confirmations.filter((c) => c.planId === plan.id && c.state === 'pending');
    if (pending.length > 0) {
      throw new StateError(`仍有 ${pending.length} 份邀请待回应，请先等待回应或作废`, {
        pending: pending.map((c) => c.id),
      });
    }

    // 旧发布版本作废：生效中的确认记录标记结束，历史与培养记录保留
    for (const other of this.state.plans) {
      if (other.id === plan.id || other.state !== 'published') continue;
      other.state = 'superseded';
      this.touch(other);
      for (const c of this.state.confirmations) {
        if (c.planId === other.id && c.state === 'accepted' && !c.endedAt) {
          c.endedAt = this.now();
          c.endCause = 'superseded';
        }
      }
      this.emit(actor, 'plan-superseded', { planId: other.id, byPlanId: plan.id });
    }

    plan.publishedNumber = ++this.state.publishedCounter;
    plan.publishedAt = this.now();
    for (const c of this.state.confirmations.filter((c) => c.planId === plan.id)) {
      c.publishedNumber = plan.publishedNumber;
    }

    const acceptedTeacherIds = new Set(
      this.state.confirmations.filter((c) => c.planId === plan.id && c.state === 'accepted').map((c) => c.teacherId),
    );
    const waitlist = [];
    for (const u of plan.solution.unmatched) {
      waitlist.push({
        teacherId: u.teacherId,
        reasons: { kind: 'unmatched', detail: u.summary, breakdown: u.reasons },
        since: this.now(),
        invitedConfirmationId: null,
      });
    }
    for (const c of this.state.confirmations.filter(
      (c) => c.planId === plan.id && (c.state === 'declined' || c.state === 'expired'),
    )) {
      if (acceptedTeacherIds.has(c.teacherId) || waitlist.some((w) => w.teacherId === c.teacherId)) continue;
      waitlist.push({
        teacherId: c.teacherId,
        reasons: {
          kind: `confirmation-${c.state}`,
          detail: c.state === 'declined' ? '教师谢绝了初始邀请' : `邀请已过期（${c.cause ?? '未回应'}）`,
        },
        since: this.now(),
        invitedConfirmationId: null,
      });
    }
    plan.waitlist = waitlist;
    plan.state = 'published';
    this.touch(plan);
    this.emit(actor, 'plan-published', {
      planId: plan.id,
      publishedNumber: plan.publishedNumber,
      effective: acceptedTeacherIds.size,
      waitlisted: waitlist.map((w) => w.teacherId),
    });
    return plan;
  }

  // ---------- 发布后的候补与调换 ----------

  promoteFromWaitlist(actor, planId, { teacherId, mentorId, expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['published']);
    this.checkVersion(plan, expectedVersion);
    const entry = plan.waitlist.find((w) => w.teacherId === teacherId);
    if (!entry) throw new NotFoundError(`教师 ${teacherId} 不在候补名单中`);
    if (entry.invitedConfirmationId) {
      const existing = this.getConfirmation(entry.invitedConfirmationId);
      if (existing.state === 'pending') throw new ConflictError(`教师 ${teacherId} 已有待回应的提升邀请`);
    }
    const teacher = this.getTeacher(teacherId);
    const mentor = this.getMentor(mentorId);
    this.assertPairFeasible(teacher, mentor);
    if (this.mentorActiveLoad(plan.id, mentorId) >= mentor.capacity) {
      throw new ValidationError(`导师 ${mentorId} 容量已满`);
    }
    const confirmation = {
      id: this.nextId('confirmation'),
      planId: plan.id,
      publishedNumber: plan.publishedNumber,
      teacherId,
      mentorId,
      origin: 'waitlist-promotion',
      previousConfirmationId: null,
      state: 'pending',
      cause: null,
      note: null,
      createdAt: this.now(),
      respondedAt: null,
      supersededBy: null,
      endedAt: null,
      endCause: null,
    };
    this.state.confirmations.push(confirmation);
    const change = {
      id: this.nextId('change'),
      planId: plan.id,
      publishedNumber: plan.publishedNumber,
      teacherId,
      fromMentorId: null,
      toMentorId: mentorId,
      reason: '候补提升',
      by: actor.id,
      at: this.now(),
      status: 'pending',
      confirmationId: confirmation.id,
      previousConfirmationId: null,
    };
    this.state.changes.push(change);
    entry.invitedConfirmationId = confirmation.id;
    this.touch(plan);
    this.emit(actor, 'waitlist-promoted', { planId: plan.id, changeId: change.id, teacherId, mentorId });
    return change;
  }

  // 调换导师：原承诺保持生效直到新邀请被接受，全程留痕
  changeMentor(actor, planId, { teacherId, newMentorId, reason, expectedVersion } = {}) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    this.assertPlanState(plan, ['published']);
    this.checkVersion(plan, expectedVersion);
    if (!reason?.trim()) throw new ValidationError('调换必须填写理由');
    const current = this.activeConfirmationOf(plan.id, teacherId);
    if (!current) throw new StateError(`教师 ${teacherId} 在该方案中没有生效中的安排`);
    if (current.mentorId === newMentorId) throw new ValidationError('新导师与现任导师相同');
    const teacher = this.getTeacher(teacherId);
    const mentor = this.getMentor(newMentorId);
    this.assertPairFeasible(teacher, mentor);
    if (this.mentorActiveLoad(plan.id, newMentorId) >= mentor.capacity) {
      throw new ValidationError(`导师 ${newMentorId} 容量已满`);
    }
    const confirmation = {
      id: this.nextId('confirmation'),
      planId: plan.id,
      publishedNumber: plan.publishedNumber,
      teacherId,
      mentorId: newMentorId,
      origin: 'mentor-change',
      previousConfirmationId: current.id,
      state: 'pending',
      cause: null,
      note: null,
      createdAt: this.now(),
      respondedAt: null,
      supersededBy: null,
      endedAt: null,
      endCause: null,
    };
    this.state.confirmations.push(confirmation);
    const change = {
      id: this.nextId('change'),
      planId: plan.id,
      publishedNumber: plan.publishedNumber,
      teacherId,
      fromMentorId: current.mentorId,
      toMentorId: newMentorId,
      reason: reason.trim(),
      by: actor.id,
      at: this.now(),
      status: 'pending',
      confirmationId: confirmation.id,
      previousConfirmationId: current.id,
    };
    this.state.changes.push(change);
    this.touch(plan);
    this.emit(actor, 'mentor-change-requested', {
      planId: plan.id,
      changeId: change.id,
      teacherId,
      fromMentorId: current.mentorId,
      toMentorId: newMentorId,
      reason: change.reason,
    });
    return change;
  }

  // ---------- 人员变动 ----------

  // 教师退出：待回应邀请作废、生效安排标记结束，已完成的培养记录不受影响
  withdrawTeacher(actor, teacherId, { reason } = {}) {
    this.requireAdmin(actor);
    const teacher = this.getTeacher(teacherId);
    if (teacher.status === 'withdrawn') throw new StateError(`教师 ${teacherId} 已退出`);
    teacher.status = 'withdrawn';
    teacher.withdrawnAt = this.now();
    teacher.withdrawReason = reason ?? null;
    const affectedPlanIds = new Set();
    let expired = 0;
    let ended = 0;
    for (const c of this.state.confirmations.filter((c) => c.teacherId === teacherId)) {
      const plan = this.getPlan(c.planId);
      if (c.state === 'pending') {
        c.state = 'expired';
        c.cause = 'teacher-withdrawn';
        c.respondedAt = this.now();
        this.applyResponseSideEffects(actor, plan, c, false);
        expired += 1;
        affectedPlanIds.add(plan.id);
      } else if (c.state === 'accepted' && !c.supersededBy && !c.endedAt) {
        c.endedAt = this.now();
        c.endCause = 'teacher-withdrawn';
        ended += 1;
        affectedPlanIds.add(plan.id);
      }
    }
    for (const plan of this.state.plans) {
      const index = plan.waitlist.findIndex((w) => w.teacherId === teacherId);
      if (index >= 0) {
        plan.waitlist.splice(index, 1);
        affectedPlanIds.add(plan.id);
      }
      if (plan.state === 'draft') {
        const lockIndex = plan.locks.findIndex((l) => l.teacherId === teacherId);
        if (lockIndex >= 0) {
          plan.locks.splice(lockIndex, 1);
          plan.solution = null;
          affectedPlanIds.add(plan.id);
        }
      }
    }
    for (const planId of affectedPlanIds) this.touch(this.getPlan(planId));
    this.emit(actor, 'teacher-withdrawn', { teacherId, reason: reason ?? null, expiredConfirmations: expired, endedConfirmations: ended });
    return teacher;
  }

  // 导师暂停：不再参与新的求解与邀请；已生效安排与培养记录保留，由管理员决定是否调换
  pauseMentor(actor, mentorId, { reason } = {}) {
    this.requireAdmin(actor);
    const mentor = this.getMentor(mentorId);
    if (mentor.status === 'paused') throw new StateError(`导师 ${mentorId} 已处于暂停状态`);
    mentor.status = 'paused';
    mentor.pausedAt = this.now();
    mentor.pauseReason = reason ?? null;
    const affectedPlanIds = new Set();
    let expired = 0;
    const keptAccepted = [];
    for (const c of this.state.confirmations.filter((c) => c.mentorId === mentorId)) {
      const plan = this.getPlan(c.planId);
      if (c.state === 'pending') {
        c.state = 'expired';
        c.cause = 'mentor-paused';
        c.respondedAt = this.now();
        this.applyResponseSideEffects(actor, plan, c, false);
        expired += 1;
        affectedPlanIds.add(plan.id);
      } else if (c.state === 'accepted' && !c.supersededBy && !c.endedAt) {
        keptAccepted.push(c.teacherId);
      }
    }
    for (const planId of affectedPlanIds) this.touch(this.getPlan(planId));
    this.emit(actor, 'mentor-paused', { mentorId, reason: reason ?? null, expiredConfirmations: expired, keptAccepted });
    return mentor;
  }

  resumeMentor(actor, mentorId) {
    this.requireAdmin(actor);
    const mentor = this.getMentor(mentorId);
    if (mentor.status !== 'paused') throw new StateError(`导师 ${mentorId} 未处于暂停状态`);
    mentor.status = 'active';
    delete mentor.pausedAt;
    delete mentor.pauseReason;
    this.emit(actor, 'mentor-resumed', { mentorId });
    return mentor;
  }

  // 培养完成：生成不可变的培养记录，退出/暂停/版本更替都不影响它
  completeMentorship(actor, { teacherId, note } = {}) {
    this.requireAdmin(actor);
    const confirmation = this.state.confirmations.find(
      (c) => c.teacherId === teacherId && c.state === 'accepted' && !c.supersededBy && !c.endedAt,
    );
    if (!confirmation) throw new StateError(`教师 ${teacherId} 没有生效中的安排`);
    const plan = this.getPlan(confirmation.planId);
    const record = {
      id: this.nextId('record'),
      teacherId,
      mentorId: confirmation.mentorId,
      planId: plan.id,
      publishedNumber: confirmation.publishedNumber,
      confirmationId: confirmation.id,
      completedAt: this.now(),
      note: note ?? null,
    };
    this.state.trainingRecords.push(record);
    confirmation.endedAt = this.now();
    confirmation.endCause = 'completed';
    this.touch(plan);
    this.emit(actor, 'mentorship-completed', {
      planId: plan.id,
      recordId: record.id,
      teacherId,
      mentorId: confirmation.mentorId,
    });
    return record;
  }

  // ---------- 查询 ----------

  getPlanView(actor, planId) {
    this.requireAdmin(actor);
    const plan = this.getPlan(planId);
    const nameOf = {
      teacher: (id) => this.state.teachers.find((t) => t.id === id)?.name ?? id,
      mentor: (id) => this.state.mentors.find((m) => m.id === id)?.name ?? id,
    };
    const confirmations = this.state.confirmations.filter((c) => c.planId === plan.id);
    const effectiveAssignments = confirmations
      .filter((c) => c.state === 'accepted' && !c.supersededBy && !c.endedAt)
      .map((c) => ({
        teacherId: c.teacherId,
        teacherName: nameOf.teacher(c.teacherId),
        mentorId: c.mentorId,
        mentorName: nameOf.mentor(c.mentorId),
        confirmationId: c.id,
        origin: c.origin,
      }));
    return {
      ...plan,
      confirmations,
      effectiveAssignments,
      waitlist: plan.waitlist.map((w, i) => ({ ...w, position: i + 1, teacherName: nameOf.teacher(w.teacherId) })),
      changes: this.state.changes.filter((ch) => ch.planId === plan.id),
    };
  }

  getAuditTrail(actor, planId) {
    this.requireAdmin(actor);
    this.getPlan(planId);
    return this.state.events.filter((e) => e.planId === planId || e.byPlanId === planId);
  }

  // 任意调换都能追溯到发布版本与确认过程
  getTeacherTrace(actor, teacherId) {
    this.requireAdmin(actor);
    const teacher = this.getTeacher(teacherId);
    return {
      teacher,
      confirmations: this.state.confirmations.filter((c) => c.teacherId === teacherId),
      changes: this.state.changes.filter((ch) => ch.teacherId === teacherId),
      trainingRecords: this.state.trainingRecords.filter((r) => r.teacherId === teacherId),
      events: this.state.events.filter((e) => e.teacherId === teacherId),
    };
  }

  // 教师视角：只能看到与自己有关的结果
  getMyResult(actor) {
    if (actor?.role !== 'teacher') throw new ForbiddenError('仅教师可查看个人结果');
    const teacher = this.getTeacher(actor.id);
    const mentorName = (id) => this.state.mentors.find((m) => m.id === id)?.name ?? id;
    const confirmations = this.state.confirmations.filter((c) => c.teacherId === teacher.id);
    const planIds = [...new Set(confirmations.map((c) => c.planId))];
    for (const plan of this.state.plans) {
      if (plan.waitlist.some((w) => w.teacherId === teacher.id) && !planIds.includes(plan.id)) {
        planIds.push(plan.id);
      }
    }
    const plans = planIds.map((planId) => {
      const plan = this.getPlan(planId);
      const mine = confirmations
        .filter((c) => c.planId === planId)
        .map((c) => ({
          id: c.id,
          mentorId: c.mentorId,
          mentorName: mentorName(c.mentorId),
          origin: c.origin,
          state: c.state,
          publishedNumber: c.publishedNumber,
          respondedAt: c.respondedAt,
          effective: c.state === 'accepted' && !c.supersededBy && !c.endedAt,
        }));
      const effective = mine.find((m) => m.effective) ?? null;
      const pending = mine.find((m) => m.state === 'pending') ?? null;
      const waitlistIndex = plan.waitlist.findIndex((w) => w.teacherId === teacher.id);
      return {
        planId: plan.id,
        planName: plan.name,
        planState: plan.state,
        publishedNumber: plan.publishedNumber,
        effectiveMentor: effective ? { id: effective.mentorId, name: effective.mentorName } : null,
        pendingInvitation: pending
          ? { confirmationId: pending.id, mentorId: pending.mentorId, mentorName: pending.mentorName }
          : null,
        waitlistPosition: waitlistIndex >= 0 ? waitlistIndex + 1 : null,
        confirmations: mine,
      };
    });
    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        subject: teacher.subject,
        school: teacher.school,
        status: teacher.status,
      },
      plans,
    };
  }
}
