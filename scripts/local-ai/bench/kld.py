# Quant fidelity vs a reference quant, via Ollama logprobs (top-20).
# Reference: greedy 128 tokens per prompt with top_logprobs. Candidate: same prompts, greedy.
# While the two outputs agree, both models saw the same prefix, so per-position
# KL(ref||cand) over the reference's top-20 (renormalized) is a teacher-forced estimate.
# Reports mean KL, top-1 agreement on shared prefixes, and mean tokens-until-divergence.
# Usage: kld.py data port ref_model cand_model [cand_model...]
import json,sys,math,urllib.request,os
D,PORT,REF=sys.argv[1],sys.argv[2],sys.argv[3]; CANDS=sys.argv[4:]
mm=json.load(open(f"{D}/mmlupro280.json"))
L="ABCDEFGHIJ"
prompts=[f"Question: {q['question']}\nOptions:\n"+"\n".join(f"{L[j]}. {o}" for j,o in enumerate(q['options']))+"\nThink step by step." for q in mm[::7][:30]]
docs=[json.loads(l)["text"] for l in open(f"{D}/scifact-corpus.jsonl")][:30]
prompts+=[f"Summarize this abstract in plain language for a general reader:\n\n{d[:1500]}" for d in docs]
def gen(model,p):
    port=PORT
    if "@" in model: model,port=model.split("@")
    body={"model":model,"messages":[{"role":"user","content":p}],"stream":False,"think":False,"logprobs":True,"top_logprobs":20,
          "options":{"temperature":0,"num_predict":128,"num_ctx":8192,"num_batch":512},"keep_alive":"10m"}
    for k in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/chat",json.dumps(body).encode(),{"Content-Type":"application/json"}),timeout=600))["logprobs"]
        except Exception as e: print("retry",e,file=sys.stderr)
    raise SystemExit("failed")
cache=f"{os.path.dirname(os.path.abspath(sys.argv[0]))}/kld_ref_{REF.replace('/','_').replace(':','_').replace('@','_')}.json"
ref=json.load(open(cache)) if os.path.exists(cache) else [gen(REF,p) for p in prompts]
json.dump(ref,open(cache,"w"))
def dist(pos):
    d={t["token"]:t["logprob"] for t in pos["top_logprobs"]}; z=math.log(sum(math.exp(v) for v in d.values()))
    return {k:v-z for k,v in d.items()}
for C in CANDS:
    kl=[];agree=0;n=0;div=[]
    for p,r in zip(prompts,ref):
        c=gen(C,p); i=0
        while i<min(len(r),len(c)):
            P=dist(r[i]); Q=dist(c[i]); floor=min(Q.values())-1.0
            kl.append(sum(math.exp(lp)*(lp-Q.get(t,floor)) for t,lp in P.items()))
            n+=1; agree+=r[i]["token"]==c[i]["token"]
            if r[i]["token"]!=c[i]["token"]: break
            i+=1
        div.append(i)
    print(f"{C} vs {REF}: meanKL={sum(kl)/len(kl):.4f} top1_agree={agree/n:.3f} tokens_until_divergence={sum(div)/len(div):.1f}/128 positions={n}",flush=True)
