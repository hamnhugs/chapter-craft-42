# Research digest — the library agent and "loading replaces"

Six literature sweeps ran for docs/library-agent.md (2026-09-02/03), each
asked for peer-reviewed or primary-vendor sources with a URL the agent
actually opened. Two streams were then **mechanically verified** by a second
agent that re-opened every citation and checked the quoted numbers
(context-composition 12/12, agent-action-safety 12/12). The other four
streams' verifiers died at the session limit three times; their findings are
listed below with that caveat — the papers are well known, but the numbers
quoted were not re-checked by a second pass. The owner asked to be told
plainly where evidence does not support a piece; those places are marked
**not supported**.

## 1. Should loading a shelf replace the loaded book and neuron? (verified)

The measured effect of *additional related documents* in context, holding
length constant, is negative and large:

- Levy, Mazor, Shalmon, Hassid, Stanovsky — *More Documents, Same Length:
  Isolating the Challenge of Multiple Documents in RAG*, Findings of EMNLP
  2025, arXiv:2503.04388. Same total length, same gold position: more related
  documents cut answer quality by up to 20%.
- Shi et al. — *Large Language Models Can Be Easily Distracted by Irrelevant
  Context*, ICML 2023, arXiv:2302.00093. One irrelevant sentence: 95.0% →
  73.5%; in-topic distractors hurt far more than off-topic ones (63.1% vs
  80.7%); "ignore irrelevant information" recovers only part (→ 79.0%).
- Wu et al. — *How Easily do Irrelevant Inputs Skew the Responses of LLMs?*,
  COLM 2024, arXiv:2404.03302. Semantically related distractors mislead ~4×
  more often than unrelated ones (22.5% vs 5.5%).
- Cuconasu et al. — *The Power of Noise*, SIGIR 2024, arXiv:2401.14887. One
  related distractor: 0.5642 → 0.4586 (≈ −19% relative); two: 0.3455.
- Jin, Yoon, Han, Arik — *Long-Context LLMs Meet RAG*, ICLR 2025,
  arXiv:2410.05983. Inverted-U in passages; the decline is driven by "hard
  negatives" — the better the retriever, the more harm leftover context does.
- Liu et al. — *Lost in the Middle*, TACL 12 (2024), arXiv:2307.03172. Extra
  documents can push accuracy below closed-book.
- Levy, Jacoby, Goldberg — *Same Task, More Tokens*, ACL 2024,
  arXiv:2402.14848. Reasoning accuracy 0.92 → 0.68 by ~3,000 input tokens.
- Zhang, Meng, Collier — *Attention Instruction*, Findings of EMNLP 2024,
  arXiv:2406.17095. Telling the model WHICH document by an exact, stable label
  helps (+4–10 pts); a wrong label costs ~25%. (The block already labels books
  by ordinal + id.)
- Gao, Chen, Huang — *The First Drop of Ink*, arXiv:2605.10828 (2026,
  preprint). 58% of the loss at 128K appears once hard distractors are 10% of
  context — a "mostly replaced" context is not enough.
- Hong, Troynikov, Huber — *Context Rot* (Chroma technical report, 2025);
  Modarressi et al. — *NoLiMa*, ICML 2025; Hsieh et al. — *RULER*, COLM 2024:
  effective context is a fraction of the advertised window.

**Recommendation (adopted):** a load replaces the loaded books; the reader's
book is discussed only when it is on the loaded set (`focusBookId`). A stale
book from the same library is the worst measured case (same topic, same
vocabulary). **Not supported:** any evidence that users *prefer* replace over
stack — the user asked for replace; the Undo makes the choice cheap.

## 2. Which actions act, which ask, and the hard delete (verified)

- OpenAI — *Operator System Card* (Jan 2025). Unmitigated: 13 errors in 100
  tasks, 8 easily reversible, 5 irreversible; confirmations before
  state-changing actions "reduced the risk by approximately 90%".
- Ruan et al. — *ToolEmu*, ICLR 2024, arXiv:2309.15817. Even with a safety
  prompt the agent took risky actions in 23.9% of high-stakes cases; the
  leading failure is filling in details the user never supplied. ⇒ the gate
  lives in the tool layer, never in the prompt.
- Yao et al. — *τ-bench*, arXiv:2406.12045. Confirmation as a protocol step:
  restate the action with object names, get an explicit yes, then act.
- Wang et al. — *Learning to Ask*, EMNLP 2025, arXiv:2409.00557. Ask-when-
  needed raised the right-question rate 0.52 → 0.90; over-asking is strongly
  model-dependent. ⇒ ask on a concrete missing argument (which neuron), never
  on a global rule.
- Vijayvargiya et al. — *Ambig-SWE*, ICLR 2026, arXiv:2502.13069. Models
  default to NOT asking; the ask/act boundary moves with prompt wording.
- Zhang & Choi — *Clarify When Necessary*, arXiv:2311.09469. Ask where
  intent uncertainty is highest; act where there is a strong default.
- Qian et al. — *Tell Me More!*, ACL 2024, arXiv:2402.09205. Under-asking
  wastes tool calls (22% unnecessary subtasks → 1.85%).
- Zhang et al. — *Agent-SafetyBench*, ACL 2025, arXiv:2412.14470. No agent
  above 60% safety; "defense prompts alone may be insufficient".
- Debenedetti et al. — *AgentDojo*, NeurIPS 2024, arXiv:2406.13352. A tool
  filter cut injection success 57.7% → 6.8% while raising utility.
- Anthropic — computer-use documentation: confirm consequential actions
  *per block*, since a batch completes multi-step actions in one turn.
- Horvitz — *Principles of Mixed-Initiative User Interfaces*, CHI 1999.
  Three bands: act-and-announce, act-with-undo, ask-first.
- Zhai, Li, Wang — *Revisable by Design*, arXiv:2604.23283 (2026 preprint).
  Idempotent / reversible / compensable / irreversible as a property of the
  action space.

**Recommendation (adopted):** reversible library actions act and announce
(load, rename, shelve); irreversible ones ask per call with consent bound to
the object (`confirm_title`, `confirm_name`); the switch is per tool, not per
turn. `save_to_library` is *compensable* (delete the new book) so it acts
once the user has asked for it. **Not supported:** a peer-reviewed measure of
the UX cost of over-asking for LLM agents — the closest numbers are
redundant-question rates.

## 3. Hands-free confirmation (sweep ran; not mechanically verified)

The voice-confirmation sweep completed (12 findings) but its verifier died at
the limit. The design relies on it only where it coincides with §2 and §4:
explicit, object-naming confirmation for irreversible spoken commands; no
confirmation for reversible ones; the spoken channel must never go dark after
an action (the product lens found that a tool-only turn spoke nothing —
fixed: the last tool event's sentence is spoken when there is no prose).

## 4. Assistant-written books re-entering the corpus (not mechanically verified)

Well-known, consistent, and structural — which is why provenance became a
column set by the app rather than a tag the model can write:

- Dai et al. — *Neural Retrievers are Biased Towards LLM-Generated Content*,
  KDD 2024, arXiv:2310.20501 (Relative Δ up to −67.3% for a monoT5
  re-ranker; BM25 leans the other way).
- Chen et al. — *Spiral of Silence*, ACL 2024, arXiv:2404.10496 (generated
  text took 80.7% of top-5 slots after one iteration).
- Tan et al. — *Blinded by Generated Contexts*, ACL 2024, arXiv:2401.11911
  (readers answer from generated context even when only the retrieved one is
  correct; ≤ 22.16% EM on those subsets).
- Wang et al. — *Perplexity Trap*, ICLR 2025, arXiv:2503.08684 (the bias is a
  perplexity shortcut in PLM retrievers).
- Panickssery, Bowman, Feng — *LLM Evaluators Recognize and Favor Their Own
  Generations*, NeurIPS 2024, arXiv:2404.13076.
- Shumailov et al. — *AI models collapse when trained on recursively
  generated data*, Nature 631 (2024); Gerstgrasser et al. — *Is Model
  Collapse Inevitable?*, arXiv:2404.01413 ("accumulate, never replace").
- Chen et al. — *AgentPoison*, NeurIPS 2024, arXiv:2407.12784; Dong et al. —
  *Memory Injection Attacks via Query-Only Interaction* (MINJA),
  arXiv:2503.03704: the memory write path is a privileged surface.
- Altay & Gilardi — PNAS Nexus 2024: a bare "AI-generated" label lowers
  perceived accuracy even for true text; a label that explains the derivation
  does not.
- Druck & Smith — *RAG Collapse*, arXiv:2608.22118 (2026 preprint): sessions
  collapse when the search tool can retrieve self-authored documents.

**Recommendation (adopted):** `books.source` column + `source_context`
(what was loaded when it was written), a derivation label ("Written by the
assistant at your request on <date>, from …") rather than an "AI" badge,
assistant books never in the default retrieval pool unless loaded, never
merged into a primary book. **Not designed:** a rank penalty inside a mixed
loaded shelf; **not supported:** any study of *labelling* synthetic documents
inside an index (the sweep found none).

## 5. Roster design (not mechanically verified)

- Anthropic — *Introducing advanced tool use* (2025): selection accuracy
  degrades past 30–50 tools; on-demand tool search 49% → 74% (Opus 4).
- Rabinovich & Anaby-Tavor — *On the Robustness of Agentic Function
  Calling*, TrustNLP @ NAACL 2025, arXiv:2504.00914: adding sibling tools
  cuts accuracy 8–19 points; 70–90% of residual errors are parameter values.
- Liu et al. — *ToolScope*, arXiv:2510.20036: merging redundant tools +5 to
  +22 points.
- Hsieh et al. — *Tool Documentation Enables Zero-Shot Tool-Usage*,
  arXiv:2308.00675: documentation is the largest lever at large roster sizes.
- Faghih et al. — *Tool Preferences in Agentic LLMs are Unreliable*,
  arXiv:2505.18135: small description edits shift selection by an order of
  magnitude — keep sibling descriptions structurally parallel.
- Patil et al. — *BFCL*, ICML 2025: models rarely notice a missing parameter
  or function in multi-turn use. ⇒ the load tool's result says which neuron
  is in use; the confirm results carry the resolved object.
- Mansoor, Phadke, Rana — *Verified Tool Calls*, arXiv:2608.02645 (2026):
  naive retries duplicate side effects 20–76% of runs; idempotent/delta
  parameters and verify-before-retry fix it. ⇒ add/remove deltas.
- Lu et al. — *ToolSandbox*, arXiv:2408.04682: models issue dependent calls
  in parallel. ⇒ live readers so a book saved in one call is visible to the
  next in the same turn.
- Gan & Sun — *RAG-MCP*, arXiv:2505.03275; Lei et al. — *MCPVerse*,
  arXiv:2508.16260; Repantis et al. — *How Many Tools Should an Agent See?*,
  arXiv:2605.24660: the ~30-tool knee is consistent across studies.

**Recommendation (adopted):** one action-enum shelf verb, no `list_shelves`,
`set_active_book` kept as a reader verb, descriptions written as
documentation; roster 75 → 79 with the cost stated in the budget test.
**Not adopted (out of scope):** a mode-scoped or deferred roster — the
research says the always-visible set should be ~30; this app is at 79 and
the roster diet remains parked by the owner's decision.
