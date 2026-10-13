# MMLU-Pro (280 stratified), scored by the next-token distribution after "The answer is (":
# the highest-probability option letter wins. Every question gets an answer; greedy, non-thinking.
# Raw Qwen3 chat template. Usage: mmlu3.py data model port
import json,sys,time,urllib.request
D,MODEL,PORT=sys.argv[1],sys.argv[2],sys.argv[3]
qs=json.load(open(f"{D}/mmlupro280.json"))[:int(sys.argv[4]) if len(sys.argv)>4 else None]; L="ABCDEFGHIJ"
SYS="Answer the multiple-choice question with the letter of the correct option."
ok=0; out=[]; miss=0; t0=time.time()
for i,q in enumerate(qs):
    letters=L[:len(q["options"])]
    opts="\n".join(f"({letters[j]}) {o}" for j,o in enumerate(q["options"]))
    prompt=f"<|im_start|>system\n{SYS}<|im_end|>\n<|im_start|>user\n{q['question']}\n\n{opts}<|im_end|>\n<|im_start|>assistant\nThe answer is ("
    body={"model":MODEL,"prompt":prompt,"raw":True,"stream":False,"logprobs":True,"top_logprobs":20,
          "options":{"temperature":0,"num_predict":1,"num_ctx":4096,"num_batch":512},"keep_alive":"10m"}
    for _ in range(3):
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/api/generate",json.dumps(body).encode(),{"Content-Type":"application/json"}),timeout=600)); break
        except Exception as e: print("retry",i,e,file=sys.stderr); time.sleep(5)
    best=None
    for t in r["logprobs"][0]["top_logprobs"]:
        k=t["token"].strip()
        if k in letters and (best is None or t["logprob"]>best[1]): best=(k,t["logprob"])
    g=best[0] if best else "?"; miss+=best is None
    ok+=g==q["answer"]; out.append(g)
print(json.dumps({"model":MODEL,"acc":round(ok/len(qs),4),"n":len(qs),"no_letter_in_top20":miss,"secs":round(time.time()-t0),"answers":"".join(out)}),flush=True)
