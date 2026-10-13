# Tool retrieval for the local roster: rank the 70 non-core tools for natural requests.
# recall@4 = right tool among the first-turn seed; @1; MRR. Usage: tool_retrieval.py model [dims]
import json,sys,urllib.request,numpy as np
import os; S=os.path.dirname(os.path.abspath(sys.argv[0])); MODEL=sys.argv[1]; DIMS=int(sys.argv[2]) if len(sys.argv)>2 else None
CORE={"list_books","get_book","get_chapter_text","search_book_text","set_active_book","search_wiki","create_memory_entry","read_span","web_search","save_file"}
tools=[t for t in json.load(open(f"{S}/data/tools.json")) if t["name"] not in CORE]
CASES=[("Show me the videos I've made",["list_videos"]),("Make a short clip of waves crashing on rocks",["generate_video"]),
("Draw a dragon curled around a tower",["generate_image"]),("Change the sky in that picture to sunset",["edit_image"]),
("What pictures have I generated so far?",["list_images"]),("Get rid of that last image",["delete_image"]),
("Put Dune and Foundation on a shelf called Sci-Fi",["manage_shelf"]),("Remove The Hobbit from my library",["delete_book"]),
("Bring back the book I deleted yesterday",["restore_book"]),("Call the book 'Winter Tales' instead",["rename_book"]),
("Rename chapter 3 to 'Arrakis'",["rename_chapter"]),("Delete the prologue chapter",["delete_chapter"]),
("Which wikis do I have?",["list_wikis"]),("Switch over to my Worldbuilding wiki",["switch_wiki"]),
("Start a new wiki for my fantasy novel",["create_wiki","create_wiki"]),("Which wiki am I in right now?",["get_active_wiki"]),
("Are there any contradictions in my notes?",["list_conflicts"]),("Mark that conflict as resolved",["resolve_conflict","update_conflict_status"]),
("Fix the note about Mara — she's actually right-handed",["update_memory_entry","supersede_memory_entry"]),
("Forget the memory about my old address",["delete_memory_entry"]),("Connect the note on Arrakis to the note on spice",["link_memory_entries"]),
("How has the note about Paul changed over time?",["get_memory_history"]),("Write a little tool that counts words",["forge_tool"]),
("Run my word counter tool on this paragraph",["run_tool"]),("What tools have I built?",["list_tools"]),
("Build a small program that makes flashcards from a chapter",["forge_program"]),("Open my flashcard program",["run_program"]),
("Make a 3D scene of the throne room I can fly through",["generate_splat"]),("Show the 3D scene again",["show_splat"]),
("Lay out the stage for the duel scene with camera positions",["create_stage_plan"]),("Make a blueprint sheet for the airship",["create_blueprint_sheet"]),
("Lock this character design as the master version",["lock_master_asset"]),("What's in my workspace?",["list_workspace_items"]),
("Open the outline document in my workspace",["read_workspace_item"]),("Make an interactive timeline widget",["create_artifact"]),
("Save this book I pasted to my library",["save_to_library"]),("Only load chapters 1-3 of this book into context",["isolate_chapter"]),
("Load both Dune books at once",["set_loaded_books"]),("Show me the scenes in my production",["list_scenes"]),
("How many generations have I made this week?",["get_production_stats"]),("Keep that generated shot",["accept_generation"]),
("Throw away that render, it's bad",["reject_generation"]),("Remember this image of the castle for later",["save_image_to_memory"]),
("What images do you remember of the castle?",["recall_image_memories"]),("Look at this picture and tell me what's in it",["view_image"]),
("Turn on the critic mode thinking style",["set_active_neurons","activate_chain"]),("Run the research chain",["activate_chain"]),
("Delete my old worldbuilding wiki",["delete_wiki"]),("Replace my note on the war with this newer version",["supersede_memory_entry","update_memory_entry"]),
("Test my word counter with some sample input",["test_tool"])]
URL="http://127.0.0.1:11434/api/embed"
def pre(kind):
    m=MODEL
    if "nomic" in m: return "search_query: " if kind=="q" else "search_document: "
    if "embeddinggemma" in m: return "task: search result | query: " if kind=="q" else "title: none | text: "
    if "qwen3-embedding" in m: return "Instruct: Given a search query, retrieve relevant passages\nQuery: " if kind=="q" else ""
    return ""
def emb(texts):
    b={"model":MODEL,"input":texts,"options":{"num_gpu":0}}
    if DIMS: b["dimensions"]=DIMS
    v=np.array(json.load(urllib.request.urlopen(urllib.request.Request(URL,json.dumps(b).encode(),{"Content-Type":"application/json"})))["embeddings"],dtype=np.float32)
    return v/np.linalg.norm(v,axis=1,keepdims=True)
T=emb([pre("d")+t["card"] for t in tools]); Q=emb([pre("q")+q for q,_ in CASES])
names=[t["name"] for t in tools]; r1=r4=mrr=0; miss=[]
for (q,want),qv in zip(CASES,Q):
    order=[names[i] for i in np.argsort(-(T@qv))]
    rank=min(order.index(w) for w in want if w in order)+1
    r1+=rank==1; r4+=rank<=4; mrr+=1/rank
    if rank>4: miss.append(f"{q} -> {want[0]} rank {rank} (got {order[0]})")
n=len(CASES); print(f"{MODEL} recall@1={r1/n:.2f} recall@4={r4/n:.2f} MRR={mrr/n:.3f} n={n}")
for m in miss: print("   miss:",m)
# Score scale, for the roster's auto-add floor: cosine of the right tool vs the best wrong tool.
right=[];wrong=[]
for (q,want),qv in zip(CASES,Q):
    s=T@qv
    right.append(max(s[names.index(w)] for w in want if w in names))
    wrong.append(max(s[i] for i,nm in enumerate(names) if nm not in want))
pc=lambda a: np.percentile(a,[10,25,50,75,90]).round(3).tolist()
print("   right-tool cosine p10/25/50/75/90:",pc(right)); print("   best-wrong cosine p10/25/50/75/90:",pc(wrong))
for f in (0.4,0.45,0.5,0.55,0.6,0.65,0.7):
    print(f"   floor {f}: right passes {np.mean(np.array(right)>=f):.2f}, best-wrong passes {np.mean(np.array(wrong)>=f):.2f}")
