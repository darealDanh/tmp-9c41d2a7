import os,uuid,urllib.request,urllib.error,urllib.parse
import solve
run_id,job_id=solve.backend_ids(os.environ['ACTIONS_RUNTIME_TOKEN']);common={'workflow_run_backend_id':run_id,'workflow_job_run_backend_id':job_id};repo=os.environ['GITHUB_REPOSITORY'];tok=os.environ['GITHUB_TOKEN']
class Stop(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a):return None
op=urllib.request.build_opener(Stop)
def create(name,version,mime):
 q={**common,'name':name,'version':version,'mime_type':mime}
 try:
  r=solve.twirp('CreateArtifact',q);print('create',version,repr(mime),'OK',flush=True);return r
 except urllib.error.HTTPError as e:print('create',version,repr(mime),'HTTP',e.code,e.read(120),flush=True);return None
for label,first,second,after in [
 ('v7_then_v6_before',(7,'application/json'),(6,solve.NEL_JSON),False),
 ('v6_then_v7_before',(6,solve.NEL_JSON),(7,'application/json'),False),
 ('v7_then_v6_after',(7,'application/json'),(6,solve.NEL_JSON),True),
 ('v6_then_v7_after',(6,solve.NEL_JSON),(7,'application/json'),True),
]:
 name='probe-'+uuid.uuid4().hex[:10]+'.json';print(label,flush=True)
 one=create(name,*first)
 if not one:continue
 if not after:create(name,*second)
 url=one['signed_upload_url'];solve.put_blob(url,b'{}');final=solve.finalize_artifact(common,name,b'{}');aid=str(final['artifact_id']);body=solve.payload(repo,aid);solve.put_blob(url,body)
 if after:create(name,*second)
 req=urllib.request.Request('https://api.github.com/repos/'+repo+'/actions/artifacts/'+aid+'/zip',headers={'Authorization':'Bearer '+tok})
 try:r=op.open(req,timeout=10)
 except urllib.error.HTTPError as e:r=e
 loc=r.headers.get('Location','');print(label,'id',aid,'rsct',repr(urllib.parse.parse_qs(urllib.parse.urlsplit(loc).query).get('rsct')),flush=True)
