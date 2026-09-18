export const planStates = ['draft', 'collecting-confirmations', 'published', 'superseded'];
export const responseStates = ['pending', 'accepted', 'declined', 'expired'];
export const hardConstraintKinds = ['subject', 'capacity', 'school-conflict', 'avoidance'];
export const preferenceKinds = ['preferred-school', 'preferred-subject', 'prior-collaboration'];

// 偏好只用于同等可行方案之间的取舍，权重越大越优先
export const preferenceWeights = {
  'prior-collaboration': 5,
  'preferred-school': 3,
  'preferred-subject': 2,
};

// 人工安排的来源标记：solver 为系统求解，manual 为管理员锁定
export const assignmentSources = ['solver', 'manual'];

// 确认邀请的来源：初始邀请、候补提升、发布后调换
export const confirmationOrigins = ['initial', 'waitlist-promotion', 'mentor-change'];

// 生效确认被终止的原因（记录保留，仅标记结束）；待回应邀请作废时的 cause 另见各流程
export const endCauses = ['completed', 'teacher-withdrawn', 'superseded'];
