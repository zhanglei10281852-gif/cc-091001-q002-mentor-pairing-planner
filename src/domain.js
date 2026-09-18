// 领域常量：方案阶段、确认结果、硬约束、偏好类型、变更类型等。
// 硬约束任何时候都不得被求解器或人工锁定突破；偏好只用于可行方案之间的排序。

export const planStates = ['draft', 'collecting-confirmations', 'published', 'superseded'];

// 单方/邀请的响应结果。pending 为初始；cancelled/superseded 为管理动作产生。
export const responseStates = ['pending', 'accepted', 'declined', 'expired'];
export const invitationLifecycle = ['pending', 'accepted', 'declined', 'expired', 'cancelled', 'superseded'];

export const hardConstraintKinds = ['subject', 'capacity', 'school-conflict', 'avoidance'];
// 运行期产生的不可匹配原因（不属于资料层面的四类硬约束，但同样阻断配对）。
export const operationalBlockKinds = ['mentor-paused', 'teacher-inactive', 'excluded'];
export const allRejectKinds = [...hardConstraintKinds, ...operationalBlockKinds];

export const preferenceKinds = ['preferred-school', 'preferred-subject', 'prior-collaboration'];

export const changeKinds = [
  'manual-lock', // 草案内人工锁定（留痕）
  'reassignment', // 在培教师换导师
  'waitlist-assignment', // 候补教师获得邀请
  'teacher-exit', // 教师退出
  'mentor-pause', // 导师临时停带
  'mentor-resume', // 导师恢复带教
];

export const enrollmentStatuses = ['active', 'ended'];
export const endReasons = ['reassignment', 'teacher-exit', 'plan-superseded'];

export const waitlistStatuses = ['waiting', 'fulfilled', 'cancelled'];

export const draftStrategies = ['max-match', 'preference-first'];

export const CONFIRMATION_PARTIES = ['mentor', 'teacher'];

// 邀请的双方确认互相独立存储，整体状态由两方结果推导，任一方拒绝即拒绝。
export function deriveInvitationStatus(invitation, now = new Date()) {
  if (invitation.lifecycleStatus === 'cancelled') return 'cancelled';
  if (invitation.lifecycleStatus === 'superseded') return 'superseded';
  if (invitation.lifecycleStatus === 'expired') return 'expired';
  const m = invitation.mentorResponse?.state ?? 'pending';
  const t = invitation.teacherResponse?.state ?? 'pending';
  if (m === 'declined' || t === 'declined') return 'declined';
  if (m === 'accepted' && t === 'accepted') return 'accepted';
  if (invitation.expiresAt && new Date(invitation.expiresAt).getTime() < now.getTime()) return 'expired';
  return 'pending';
}

export const REASON_DETAIL = {
  subject: '学科不兼容：导师可带学科与教师学科不存在兼容关系',
  capacity: '容量不足：该导师名额已被占用或预留',
  'school-conflict': '同校回避：导师与教师来自同一学校',
  avoidance: '回避条件：资料中登记了二者需要回避',
  'mentor-paused': '导师已临时停带，暂不接收新结对',
  'teacher-inactive': '教师已退出，不再参与结对',
  excluded: '本轮试排中被人工排除',
};
