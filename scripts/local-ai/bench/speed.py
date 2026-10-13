# Prefill/decode speed + VRAM for one model on the test server. Usage: speed.py data model port [ctx]
import json,sys,urllib.request,time
D,MODEL,PORT=sys.argv[1],sys.argv[2],sys.argv[3]; CTX=int(sys.argv[4]) if len(sys.argv)>4 else 16384
docs=[json.loads(l)["text"] for l in open(f"{D}/scifact-corpus.jsonl")]
def call(prompt,n,seed):
    body={"model":MODEL,"messages":[{"role":"user","content":f"[{seed}] "+prompt}],"stream":False,"think":False,
          "options":{"temperature":0,"num_predict":n,"num_ctx":CTX,"num_batch":512},"keep_alive":"10m"}
    t=time.time(); r=json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/api/chat",json.dumps(body).encode(),{"Content-Type":"application/json"}),timeout=900))
    return r,time.time()-t
ctxt="\n\n".join(docs[:40])[:20000]+"\n\nSummarize the main findings above in detail."
res=[]
for i in range(3):
    r,w=call(ctxt,200,i)
    res.append((r["prompt_eval_count"],r["prompt_eval_count"]/(r["prompt_eval_duration"]/1e9),r["eval_count"]/(r["eval_duration"]/1e9),r.get("load_duration",0)/1e9,w))
ps=json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/ps"))["models"]
vram=[m.get("size_vram",0)/2**30 for m in ps if m["name"]==MODEL or m["model"]==MODEL]
for p,pf,dc,ld,w in res: print(f"  prompt={p} prefill={pf:.0f} tok/s decode={dc:.1f} tok/s load={ld:.1f}s wall={w:.1f}s")
print(f"{MODEL} ctx={CTX} vram={vram[0] if vram else '?':.2f}GiB" if vram else f"{MODEL} vram=?")
