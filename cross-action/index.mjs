import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const index = Number(process.env.MATRIX_INDEX);
const version = index % 2 === 0 ? 6 : 7;
const nel = 'application/json\u0085';
const mime = version === 7 ? 'application/json' : nel;
const name = 'cassette-cross-' + process.env.GITHUB_RUN_ID;

const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  version,
  mimeType: StringValue.create({value: mime}),
});
if (!created.ok) throw new Error('CreateArtifact returned ok=false');

const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
const placeholder = Buffer.from('{"probe":"cross-job"}');
await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: nel}});

const apiHeaders = {
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
  'user-agent': 'repo-cassette-cross-race',
};

for (let attempt = 0; attempt < 120; attempt++) {
  const response = await fetch(
    'https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY +
      '/actions/runs/' + process.env.GITHUB_RUN_ID + '/jobs?per_page=100',
    {headers: apiHeaders},
  );
  const listing = await response.json();
  const matrixJobs = (listing.jobs || []).filter((job) => job.name.startsWith('cross-race ('));
  if (matrixJobs.length >= Number(process.env.MATRIX_TOTAL) &&
      matrixJobs.every((job) => job.status === 'in_progress' || job.status === 'completed')) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

await new Promise((resolve) => setTimeout(resolve, 4000));
const hash = createHash('sha256').update(placeholder).digest('hex');
let finalizedId = null;
try {
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: 'sha256:' + hash}),
  });
  if (result.ok) finalizedId = String(result.artifactId);
} catch (error) {
  console.log('FINALIZE-LOST', index, version, String(error).slice(0, 180));
}

let artifactId = finalizedId;
for (let attempt = 0; attempt < 60 && !artifactId; attempt++) {
  const response = await fetch(
    'https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY +
      '/actions/runs/' + process.env.GITHUB_RUN_ID + '/artifacts?per_page=100',
    {headers: apiHeaders},
  );
  const listing = await response.json();
  const artifact = (listing.artifacts || []).find((item) => item.name === name);
  if (artifact) artifactId = String(artifact.id);
  if (!artifactId) await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!artifactId) throw new Error('final artifact ID was unavailable');

const repository = process.env.GITHUB_REPOSITORY + '/actions/artifacts/' + artifactId + '/zip';
const body = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Cross-job Actions artifact race',
}));
await blob.uploadData(body, {blobHTTPHeaders: {blobContentType: nel}});
console.log('CROSS-RESULT', index, version, artifactId, finalizedId || 'lost');
