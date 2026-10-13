# Model benchmarks for the local edition

What produced `docs/local-ai/results/2026-10-13-*.txt`. Run against any Ollama (the port is an
argument; 11434 is the live one). Run one at a time: two at once starve each other's CPU threads
and the numbers mean nothing. Let the GPU cool between GPU runs — it reaches 86–96 °C.

| script | measures | usage |
|---|---|---|
| `speed.py` | prefill/decode tok/s and VRAM at 16K context | `speed.py DATA MODEL PORT` |
| `kld.py` | fidelity of a quant to a reference quant (KL, top-1 agreement) | `kld.py DATA PORT REF CAND...` |
| `mmlu.py` | MMLU-Pro (280 questions) by option-letter logprobs | `mmlu.py DATA MODEL PORT [N]` |
| `tool_retrieval.py` | how well an embedder finds the right app tool; auto-add floor | `tool_retrieval.py EMBED_MODEL` |
| `sts_calib.py` | STS-B correlation and cosine scale of an embedder | `sts_calib.py EMBED_MODEL [DIMS] [PORT]` |

The app-level tool-choice test is `src/test/localToolEval.test.ts` (`LIVE_OLLAMA=1`).

`DATA` is `scripts/local-ai/bench/data`. Included: `mmlupro280.json` (stratified sample of
TIGER-Lab/MMLU-Pro test), `sts-test.jsonl.gz` (STS-B test), `tools.json` (the app's tool cards).
`speed.py` and `kld.py` also read `scifact-corpus.jsonl` (BEIR SciFact corpus, 8 MB, not
committed — download it into `data/` from the BEIR SciFact release).
