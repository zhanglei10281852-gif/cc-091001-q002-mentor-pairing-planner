import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PlannerService } from './planner.js';
import { createState } from './store.js';
import { DomainError, ValidationError, UnauthorizedError } from './errors.js';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// 路由表：[方法, 路径模式, 是否需要管理员, 处理函数]
// 处理函数接收 (service, actor, params, body, expectedVersion)
const routes = [
  ['POST', '/plans', true, (s, a, p, b) => s.createPlan(a, b)],
  ['GET', '/plans', true, (s, a) => s.listPlans(a)],
  ['GET', '/plans/:id', true, (s, a, p) => s.getPlanView(a, p.id)],
  ['POST', '/plans/:id/solve', true, (s, a, p, b, v) => s.solvePlan(a, p.id, { expectedVersion: v ?? b.expectedVersion })],
  ['POST', '/plans/:id/locks', true, (s, a, p, b, v) => s.lockAssignment(a, p.id, { ...b, expectedVersion: v ?? b.expectedVersion })],
  ['DELETE', '/plans/:id/locks/:teacherId', true, (s, a, p, b, v) => s.unlockAssignment(a, p.id, { teacherId: p.teacherId, expectedVersion: v ?? b.expectedVersion })],
  ['GET', '/plans/:id/compare/:otherId', true, (s, a, p) => s.comparePlans(a, p.id, p.otherId)],
  ['POST', '/plans/:id/invitations', true, (s, a, p, b, v) => s.openInvitations(a, p.id, { expectedVersion: v ?? b.expectedVersion })],
  ['POST', '/plans/:id/publish', true, (s, a, p, b, v) => s.publishPlan(a, p.id, { expectedVersion: v ?? b.expectedVersion })],
  ['POST', '/plans/:id/promotions', true, (s, a, p, b, v) => s.promoteFromWaitlist(a, p.id, { ...b, expectedVersion: v ?? b.expectedVersion })],
  ['POST', '/plans/:id/changes', true, (s, a, p, b, v) => s.changeMentor(a, p.id, { ...b, expectedVersion: v ?? b.expectedVersion })],
  ['GET', '/plans/:id/audit', true, (s, a, p) => s.getAuditTrail(a, p.id)],
  ['GET', '/teachers/:id/trace', true, (s, a, p) => s.getTeacherTrace(a, p.id)],
  ['POST', '/teachers/:id/withdraw', true, (s, a, p, b) => s.withdrawTeacher(a, p.id, b)],
  ['POST', '/mentors/:id/pause', true, (s, a, p, b) => s.pauseMentor(a, p.id, b)],
  ['POST', '/mentors/:id/resume', true, (s, a, p) => s.resumeMentor(a, p.id)],
  ['POST', '/mentorships/complete', true, (s, a, p, b) => s.completeMentorship(a, b)],
  ['POST', '/confirmations/:id/respond', false, (s, a, p, b) => s.respondToConfirmation(a, p.id, b)],
  ['POST', '/confirmations/:id/expire', true, (s, a, p, b) => s.expireConfirmation(a, p.id, b)],
  ['GET', '/me/result', false, (s, a) => s.getMyResult(a)],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, adminOnly, handler] of routes) {
    if (routeMethod !== method) continue;
    const paramNames = [];
    const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, (m) => {
      paramNames.push(m.slice(1));
      return '([^/]+)';
    })}$`);
    const match = pathname.match(regex);
    if (!match) continue;
    const params = Object.fromEntries(paramNames.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
    return { handler, params, adminOnly };
  }
  return null;
}

export function createApp(service, { tokens, onMutation } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = matchRoute(req.method, url.pathname);
      if (!route) {
        sendJson(res, 404, { error: { code: 'not-found', message: '接口不存在' } });
        return;
      }
      const header = req.headers.authorization ?? '';
      const token = header.replace(/^Bearer\s+/i, '');
      const actor = tokens?.get(token);
      if (!actor) throw new UnauthorizedError('缺少或无效的访问令牌');
      if (route.adminOnly && actor.role !== 'admin') {
        sendJson(res, 403, { error: { code: 'forbidden', message: '需要管理员权限' } });
        return;
      }
      const body = await readBody(req);
      const ifMatch = req.headers['if-match'];
      const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : undefined;
      if (ifMatch !== undefined && !Number.isInteger(expectedVersion)) {
        throw new ValidationError('If-Match 头必须是整数版本号');
      }
      const result = await route.handler(service, actor, route.params, body, expectedVersion);
      if (req.method !== 'GET' && onMutation) await onMutation();
      sendJson(res, req.method === 'POST' ? 201 : 200, { data: result ?? null });
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      } else {
        sendJson(res, 500, { error: { code: 'internal-error', message: '服务器内部错误' } });
        console.error(err);
      }
    }
  });
}

export function defaultTokens(state) {
  const tokens = new Map();
  tokens.set('admin-token', { role: 'admin', id: 'admin' });
  for (const teacher of state.teachers) {
    tokens.set(`t-${teacher.id}`, { role: 'teacher', id: teacher.id });
  }
  return tokens;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const datasetPath = process.env.DATASET ?? new URL('../fixtures/dataset.json', import.meta.url).pathname;
  const dataFile = process.env.DATA_FILE ?? null;
  let state;
  if (dataFile && existsSync(dataFile)) {
    state = JSON.parse(await readFile(dataFile, 'utf8'));
  } else {
    state = createState(JSON.parse(await readFile(datasetPath, 'utf8')));
  }
  const service = new PlannerService(state);
  const tokens = process.env.PLANNER_TOKENS
    ? new Map(Object.entries(JSON.parse(process.env.PLANNER_TOKENS)))
    : defaultTokens(state);
  const onMutation = dataFile ? () => writeFile(dataFile, JSON.stringify(state, null, 2)) : null;
  const port = Number(process.env.PORT ?? 3000);
  createApp(service, { tokens, onMutation }).listen(port, () => {
    console.log(`结对编排服务已启动：http://localhost:${port}`);
  });
}
