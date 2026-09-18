// HTTP 接口：
// - 管理端用 X-Admin-Token 鉴权；写草案/邀请必须带 If-Match（版本号），冲突返回 409。
// - 教师/导师用个人 token（Authorization: Bearer <token>），/api/me 只返回与本人有关的数据；
//   只能对自己作为一方的邀请作答。
//
// 版本头：可变资源返回 ETag: W/"<version>"；写入时 If-Match: W/"<version>" 或纯数字均可。

import { createServer } from 'node:http';
import { ConflictError, NotFoundError, Service, ValidationError } from './service.js';
import { Store } from './store.js';

const json = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
};

const parseVersion = (header) => {
  if (!header) return undefined;
  const m = /(?:W\/)?"?(\d+)"?/.exec(header.trim());
  return m ? Number(m[1]) : undefined;
};

const etag = (v) => `W/"${v}"`;

export function createApp(service, { adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token' } = {}) {
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 5_000_000) reject(new ValidationError('body too large'));
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new ValidationError('invalid JSON body'));
        }
      });
      req.on('error', reject);
    });

  const resolveParty = (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const s = service.store.state;
    const teacher = s.teachers.find((t) => t.token === token);
    if (teacher) return { kind: 'teacher', id: teacher.id };
    const mentor = s.mentors.find((m) => m.token === token);
    if (mentor) return { kind: 'mentor', id: mentor.id };
    return { kind: 'unknown' };
  };

  const requireAdmin = (req) => req.headers['x-admin-token'] === adminToken;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;
    const party = resolveParty(req);
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : {};
    const version = parseVersion(req.headers['if-match']);
    // 操作人可由请求体 actor（支持中文姓名）或 X-Actor 头（ASCII）指定。
    const actor = body.actor?.toString().slice(0, 100) ?? req.headers['x-actor']?.toString().slice(0, 100) ?? 'admin';

    // -------- 教师/导师本人端 --------
    if (p === '/api/me' && method === 'GET') {
      if (!party || party.kind === 'unknown') return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, party.kind === 'teacher' ? service.teacherView(party.id) : service.mentorView(party.id));
    }

    const respondMatch = p.match(/^\/api\/invitations\/([^/]+)\/respond$/);
    if (respondMatch && method === 'POST') {
      if (!party || party.kind === 'unknown') return json(res, 401, { error: 'unauthorized' });
      const inv = service.getInvitation(respondMatch[1]);
      if (party.kind === 'teacher' && inv.teacherId !== party.id) return json(res, 403, { error: 'not your invitation' });
      if (party.kind === 'mentor' && inv.mentorId !== party.id) return json(res, 403, { error: 'not your invitation' });
      if (version == null) return json(res, 428, { error: 'If-Match with invitation version required' });
      const updated = await service.respondInvitation(inv.id, party.kind, body.response, {
        expectedVersion: version,
        actor: party.id,
      });
      return json(res, 200, updated, { etag: etag(updated.version) });
    }

    // -------- 公开健康检查 --------
    if (p === '/health' && method === 'GET') return json(res, 200, { ok: true });

    // -------- 管理端 --------
    if (!requireAdmin(req)) return json(res, 401, { error: 'admin token required' });

    if (p === '/api/admin/data' && method === 'POST') {
      await service.importData(body, actor);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/plans' && method === 'GET') return json(res, 200, { plans: service.listPlans() });
    if (p === '/api/admin/plans' && method === 'POST') {
      const out = await service.createDraft({ name: body.name, strategy: body.strategy, actor });
      return json(res, 201, out, { etag: etag(out.plan.version) });
    }

    const planMatch = p.match(/^\/api\/admin\/plans\/([^/]+)$/);
    if (planMatch) {
      const id = planMatch[1];
      if (method === 'GET') {
        const out = service.getPlan(id);
        return json(res, 200, out, { etag: etag(out.plan.version) });
      }
    }

    const candMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/candidates\/([^/]+)$/);
    if (candMatch && method === 'GET') {
      return json(res, 200, service.previewPairCandidates(candMatch[1], candMatch[2]));
    }

    const compareMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/compare$/);
    if (compareMatch && method === 'GET') {
      const other = url.searchParams.get('other');
      if (!other) return json(res, 400, { error: '?other=<planId> required' });
      return json(res, 200, service.compareDrafts(compareMatch[1], other));
    }

    const strategyMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/strategy$/);
    if (strategyMatch && method === 'PUT') {
      if (version == null) return json(res, 428, { error: 'If-Match required' });
      const out = await service.setStrategy(strategyMatch[1], version, body.strategy, actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    const lockMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/locks$/);
    if (lockMatch && method === 'POST') {
      if (version == null) return json(res, 428, { error: 'If-Match required' });
      const out = await service.lockPair(lockMatch[1], version, body.teacherId, body.mentorId, actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    const unlockMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/locks\/([^/]+)$/);
    if (unlockMatch && method === 'DELETE') {
      if (version == null) return json(res, 428, { error: 'If-Match required' });
      const out = await service.unlockPair(unlockMatch[1], version, unlockMatch[2], actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    const exclMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/exclusions$/);
    if (exclMatch && method === 'PUT') {
      if (version == null) return json(res, 428, { error: 'If-Match required' });
      const out = await service.setExcluded(exclMatch[1], version, { teacherIds: body.teacherIds, mentorIds: body.mentorIds }, actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    const publishMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/publish$/);
    if (publishMatch && method === 'POST') {
      if (version == null) return json(res, 428, { error: 'If-Match required' });
      const out = await service.publishDraft(publishMatch[1], version, actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    const finalizeMatch = p.match(/^\/api\/admin\/plans\/([^/]+)\/finalize$/);
    if (finalizeMatch && method === 'POST') {
      const out = await service.finalizeRelease(finalizeMatch[1], actor);
      return json(res, 200, out, { etag: etag(out.plan.version) });
    }

    if (p === '/api/admin/waitlist' && method === 'GET') return json(res, 200, { waitlist: service.waitlist() });

    const wlAssign = p.match(/^\/api\/admin\/waitlist\/([^/]+)\/assign$/);
    if (wlAssign && method === 'POST') {
      const out = await service.assignFromWaitlist(wlAssign[1], body.mentorId, actor);
      return json(res, 200, out, { etag: etag(out.version) });
    }

    if (p === '/api/admin/reassign' && method === 'POST') {
      const out = await service.reassign(body.teacherId, body.mentorId, body.reason, actor);
      return json(res, 200, out, { etag: etag(out.version) });
    }

    const exitMatch = p.match(/^\/api\/admin\/teachers\/([^/]+)\/exit$/);
    if (exitMatch && method === 'POST') {
      await service.teacherExit(exitMatch[1], body.reason, actor);
      return json(res, 200, { ok: true });
    }

    const pauseMatch = p.match(/^\/api\/admin\/mentors\/([^/]+)\/pause$/);
    if (pauseMatch && method === 'POST') {
      await service.mentorPause(pauseMatch[1], body.reason, actor);
      return json(res, 200, { ok: true });
    }
    const resumeMatch = p.match(/^\/api\/admin\/mentors\/([^/]+)\/resume$/);
    if (resumeMatch && method === 'POST') {
      await service.mentorResume(resumeMatch[1], actor);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/audit' && method === 'GET') {
      return json(res, 200, { audit: service.audit({ entityId: url.searchParams.get('entity'), planId: url.searchParams.get('plan') }) });
    }

    return json(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
        if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
        if (err instanceof ConflictError) return json(res, 409, { error: err.message });
        if (err instanceof ValidationError) return json(res, 400, { error: err.message });
        // eslint-disable-next-line no-console
        console.error(err);
        return json(res, 500, { error: 'internal error' });
      });
  });
}

// 直接运行：node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const dataFile = process.env.DATA_FILE ?? './data/planner-state.json';
  const store = await Store.load(dataFile);
  const service = new Service(store, { invitationTtlDays: Number(process.env.INVITATION_TTL_DAYS ?? 14) });
  const port = Number(process.env.PORT ?? 3000);
  createApp(service).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`mentor planner listening on :${port} (data: ${dataFile})`);
  });
}
