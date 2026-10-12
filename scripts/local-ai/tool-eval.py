# Tool-selection eval against local Ollama, using the app's REAL tool schemas.
# Usage: python3 scripts/local-ai/tool-eval.py <dir-with-tools.json> <model> top8,all [think|nothink]
# tools.json = JSON.stringify(CHAT_TOOL_DEFINITIONS) from src/lib/chatTools.ts (dump it via a throwaway vitest).
# "topN" = embed the query with nomic-embed-text and offer only the N nearest tools; "all" = all 80.
# Results from 2026-10-12 live in docs/local-ai/results/.
import json,urllib.request,time,sys,math
S=sys.argv[1]; MODEL=sys.argv[2]; MODES=sys.argv[3].split(",")
tools=json.load(open(f"{S}/tools.json"))
H={"Content-Type":"application/json"}
def post(path,body,t=900):
    return urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434"+path,json.dumps(body).encode(),H),timeout=t)
def embed(texts,prefix):
    r=json.load(post("/api/embed",{"model":"nomic-embed-text","input":[prefix+x for x in texts]}))
    return r["embeddings"]
def cos(a,b): return sum(x*y for x,y in zip(a,b))/math.sqrt(sum(x*x for x in a)*sum(y*y for y in b))
cards=[t["function"]["name"].replace("_"," ")+": "+t["function"]["description"][:400] for t in tools]
tv=embed(cards,"search_document: ")
CASES=[("What books do I have?","list_books"),
("Find the line 'the river remembers' in my books","search_book_text"),
("Rename chapter 3 of Dune to 'Arrakis'","rename_chapter"),
("Remember that my protagonist Mara is left-handed","create_memory_entry"),
("Search the web for the latest news on the Booker Prize","web_search"),
("Make me an image of a lighthouse in a storm, watercolor","generate_image"),
("Show me my generated videos","list_videos"),
("Switch to my Worldbuilding wiki","switch_wiki"),
("Put Dune and Foundation on a new shelf called Sci-Fi","manage_shelf"),
("Read me the text of chapter 2 of The Hobbit","get_chapter_text"),
("What contradictions are in my wiki?","list_conflicts"),
("Save this outline as a file in my workspace","save_file"),
("Write a tiny tool that counts words in a string","forge_tool"),
("Open Foundation in the reader","set_active_book")]
SYS="You are BookWorm, an assistant inside a reading app. Use tools when the request needs app data or actions. Respond with a tool call when appropriate."
THINK=(sys.argv[4]=="think") if len(sys.argv)>4 else False
ALT={"rename_chapter":["rename_chapter","get_book","list_books"],"switch_wiki":["switch_wiki","list_wikis"],
     "get_chapter_text":["get_chapter_text","get_book","list_books"],"manage_shelf":["manage_shelf","list_books"],
     "set_active_book":["set_active_book","list_books"]}
VALID={t["function"]["name"] for t in tools}
def run(mode):
    ok=0;lat=[]
    for q,want in CASES:
        if mode=="all": sel=tools
        else:
            k=int(mode[3:]); qv=embed([q],"search_query: ")[0]
            order=sorted(range(len(tools)),key=lambda i:-cos(qv,tv[i]))[:k]; sel=[tools[i] for i in order]
        inset=any(t["function"]["name"]==want for t in sel)
        body={"model":MODEL,"messages":[{"role":"system","content":SYS},{"role":"user","content":q}],"tools":sel,"stream":True,
              "think":THINK,"options":{"num_ctx":32768,"temperature":0.2}}
        t=time.time(); names=[]; args={}; first=None
        r=post("/api/chat",body); text=""; pe=None
        for line in r:
            if not line.strip(): continue
            d=json.loads(line); m=d.get("message",{})
            text+=m.get("content") or ""
            for tc in m.get("tool_calls") or []:
                names.append(tc["function"]["name"]); args[len(args)]=json.dumps(tc["function"].get("arguments",{}))
            if d.get("done"): pe=d.get("prompt_eval_count")
        if not names: names=["TEXT:"+text[:50].replace("\n"," ")]
        dt=time.time()-t; lat.append(dt)
        valid=all(_ok(a) for a in args.values())
        hit=any(n in ALT.get(want,[want]) for n in names[:1]); ok+=hit
        halluc=[n for n in names if not n.startswith('TEXT:') and n not in VALID]
        print(f"  [{mode}] halluc={halluc} {'OK ' if hit else 'BAD'} in_set={inset} got={names} args_json={valid} {dt:.1f}s ptok={pe}",flush=True)
    print(f"{MODEL} {mode}: {ok}/{len(CASES)} correct, median {sorted(lat)[len(lat)//2]:.1f}s, first {lat[0]:.1f}s",flush=True)
def _ok(a):
    try: json.loads(a or "{}"); return True
    except: return False
for m in MODES: run(m)
