# Brief for Burplexity bot: fix the Voice ↔ Burplexity connection

Hand this whole document to the Burplexity project's AI. It contains the exact contract the Chapter Craft client uses today plus what's needed to make voice search work without blocking the voice reply.

---

## 1. Where Chapter Craft calls Burplexity

**File:** `src/lib/chatTools.ts`

```
const BURPLEXITY_BOT_ASK_URL = "https://tmagmbmitnvcwubxcwoc.supabase.co/functions/v1/bot-ask";
```

The `web_search` tool exposed to the LLM is wired like this:

```ts
const r = await fetch(BURPLEXITY_BOT_ASK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": token },
  body: JSON.stringify({ query: q, save_to_wiki: false }),
});
const j = await r.json();
// expected: { answer: string, citations: [{title,url,snippet}, ...] }
```

The token comes from `useChatSettings().burplexityApiToken` (must start with `pp_`). It is shared by the Chat tab and Voice tab.

`web_search` is registered in `CHAT_TOOL_DEFINITIONS` and the system prompt in `src/lib/buildChatSystemPrompt.ts` explicitly tells the model to call it for any "search / look up