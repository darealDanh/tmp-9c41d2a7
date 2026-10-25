import os,uuid,json,urllib.request,urllib.error,urllib.parse
import solve
run_id,job_id=solve.backend_ids(os.environ['ACTIONS_RUNTIME_TOKEN']);common={'workflow_run_backend_id':run_id,'workflow_job_run_backend_id':job_id};repo=os.environ['GITHUB_REPOSITORY'];tok=os.environ['GITHUB_TOKEN'];name='pending-'+uuid.uuid4().hex[:10]+'.json'
created=solve.twirp('CreateArtifact',{**common,'name':name,'version':7,'mime_type':'application/json'})
print('created_keys',list(created),'upload_path',urllib.parse.urlsplit(created['signed_upload_url']).path,'query_keys',list(urllib.parse.parse_qs(urllib.parse.urlsplit(created['signed_upload_url']).query)),flush=True)
def list_all(label):
 try:
  x=solve.twirp('ListArtifacts',{**common,'name':name});print(label,'twirp',x,flush=True)
 except Exception as e:print(label,'twirp_error',repr(e),flush=True)
 try:
  req=urllib.request.Request('https://api.github.com/repos/'+repo+'/actions/artifacts?per_page=100',headers={'Authorization':'Bearer '+tok,'User-Agent':'probe'})
  with urllib.request.urlopen(req,timeout=10) as r:x=json.load(r)
  print(label,'rest',[(a['id'],a['name']) for a in x.get('artifacts',[]) if a['name']==name],flush=True)
 except Exception as e:print(label,'rest_error',repr(e),flush=True)
list_all('after_create')
solve.put_blob(created['signed_upload_url'],b'{}')
list_all('after_upload')
final=solve.finalize_artifact(common,name,b'{}');print('final',final,flush=True)
list_all('after_finalize')
