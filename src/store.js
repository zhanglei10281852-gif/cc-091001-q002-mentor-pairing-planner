// 应用状态为纯 JSON 结构，便于整体快照持久化与测试重建
export function createState(dataset) {
  return {
    teachers: (dataset.teachers ?? []).map((t) => ({ status: 'active', ...t })),
    mentors: (dataset.mentors ?? []).map((m) => ({ status: 'active', ...m })),
    avoidance: dataset.avoidance ?? [],
    plans: [],
    confirmations: [],
    changes: [],
    trainingRecords: [],
    events: [],
    counters: {},
    publishedCounter: 0,
  };
}
