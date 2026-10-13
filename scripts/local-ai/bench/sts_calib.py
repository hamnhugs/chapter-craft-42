# STS-B test: Spearman of cosine vs human score, and the cosine an embedder gives to
# "same meaning" (score>=4.6), "same topic" (2.5-3.5), and "unrelated" (<=0.5) pairs.
# Used to translate the app's similarity thresholds (set for the hosted embedder) to a local one.
import json,sys,gzip,urllib.request,numpy as np
import os; S=os.path.dirname(os.path.abspath(sys.argv[0])); MODEL=sys.argv[1]; DIMS=int(sys.argv[2]) if len(sys.argv)>2 else None; PORT=sys.argv[3] if len(sys.argv)>3 else "11434"
rows=[json.loads(l) for l in gzip.open(f"{S}/data/sts-test.jsonl.gz")]
def pre():
    if "nomic" in MODEL: return "search_document: "   # how the app embeds both sides of a dedup check
    if "embeddinggemma" in MODEL: return "title: none | text: "
    return ""
def emb(t):
    out=[]
    import time
    for i in range(0,len(t),16):
        b={"model":MODEL,"input":[pre()+x for x in t[i:i+16]],"options":{"num_gpu":0}}
        if DIMS: b["dimensions"]=DIMS
        for k in range(5):
            try:
                out+=json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/api/embed",json.dumps(b).encode(),{"Content-Type":"application/json"})))["embeddings"]; break
            except Exception as e:
                print("retry",e,file=sys.stderr); time.sleep(3)
        else: raise SystemExit("embed failed")
    v=np.array(out,dtype=np.float32); return v/np.linalg.norm(v,axis=1,keepdims=True)
A=emb([r["sentence1"] for r in rows]); B=emb([r["sentence2"] for r in rows]); c=(A*B).sum(1); s=np.array([r["score"] for r in rows])
rk=lambda x: np.argsort(np.argsort(x)); rho=np.corrcoef(rk(c),rk(s))[0,1]
q=lambda m: np.percentile(c[m],[10,50,90]).round(3).tolist()
print(f"{MODEL} spearman={rho:.4f} same_meaning(p10/50/90)={q(s>=4.6)} same_topic={q((s>=2.5)&(s<=3.5))} unrelated={q(s<=0.5)}")
groups={"same_meaning(>=4.6)":s>=4.6,"paraphrase-ish(4-4.6)":(s>=4)&(s<4.6),"same_topic(2.5-3.5)":(s>=2.5)&(s<=3.5),"unrelated(<=0.5)":s<=0.5}
for th in (0.3,0.55,0.62,0.78,0.85,0.92):
    print(f"   cos>={th}: "+"  ".join(f"{g} {np.mean(c[m]>=th):.2f}" for g,m in groups.items()))
