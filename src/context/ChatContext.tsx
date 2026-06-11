import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useApp } from "@/context/AppContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { usePlan } from "@/hooks/usePlan";
import { usePromptPresets } from "@/hooks/usePromptPresets";
import { buildChatSystemPrompt } from "@/lib/buildChatSystemPrompt";
import { CHAT_TOOL_DEFINITIONS, executeChatTool, ToolEvent } from "@/lib/chatTools";
import { parseBlocks, type ResponseBlock } from "@/lib/responseBlocks";
import { parseArtifact, type Artifact } from "@/lib/artifacts";
import { workspaceStore, deriveResearchTitle } from "@/lib/workspaceStore";
import { toast } from "sonner";
import { isEmbeddingModel } from "@/lib/utils";

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  toolEvents?: ToolEvent[];
  displayOnly?: boolean;
  /** Validated structured blocks to render (from the render_blocks tool). */
  blocks?: ResponseBlock[];
  /** Sandboxed HTML/SVG artifact to render (from the create_artifact tool). */
  artifact?: Artifact;
  /** Id of the durable Workspace item this artifact was captured as (so the
   *  bubble can open it in the Workspace panel). */
  workspaceItemId?: string;
}

interface SendOpts {
  /** When true, the system prompt asks for concise, spoken-friendly replies. */
  voiceMode?: boolean;
  /** Optional override model — e.g. fast voice model. */
  modelOverride?: string;
  /** Called on every streamed delta with the cumulative assistant text. */
  onDelta?: (fullText: string) => void;
}

interface ChatContextValue {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Legacy combined flag — true if either tab has Deep Research on. Kept for backward compat. */
  deepResearch: boolean;
  /** Deprecated: writes to the chat-tab flag (preserves old call sites). */
  setDeepResearch: (v: boolean) => void;
  chatDeepResearch: boolean;
  setChatDeepResearch: (v: boolean) => void;
  voiceDeepResearch: boolean;
  setVoiceDeepResearch: (v: boolean) => void;
  sendMessage: (text: string, opts?: SendOpts) => Promise<string>;
  injectDisplayMessage: (content: string) => void;
  clearChat: () => Promise<void>;
  abort: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

const MAX_TOOL_ITERATIONS = 5;

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const { books, activeBookId, activeWiki, activeWikiId, addChapter, updateChapter, removeChapter, setActiveBookSilent } = useApp();

  const { apiKey, selectedModel, deepResearchModel, customSystemPrompt, burplexityApiToken } = useChatSettings();
  const { isPaid } = usePlan();
  const { getActiveBodyForScope, migrate } = usePromptPresets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [chatDeepResearch, setChatDeepResearch] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("chat_deep_research") === "1");
  const [voiceDeepResearch, setVoiceDeepResearch] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("voice_deep_research") === "1");
  useEffect(() => { localStorage.setItem("chat_deep_research", chatDeepResearch ? "1" : "0"); }, [chatDeepResearch]);
  useEffect(() => { localStorage.setItem("voice_deep_research", voiceDeepResearch ? "1" : "0"); }, [voiceDeepResearch]);
  // One-time seed of prompt presets from legacy customSystemPrompt.
  const migratedPromptsRef = useRef(false);
  useEffect(() => {
    if (migratedPromptsRef.current) return;
    if (!customSystemPrompt) return;
    migratedPromptsRef.current = true;
    migrate(customSystemPrompt);
  }, [customSystemPrompt, migrate]);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);

  // Bind the durable Workspace store to the signed-in user so its files sync
  // from Supabase (cross-device) and stream live via realtime.
  useEffect(() => {
    workspaceStore.setUser(user?.id ?? null);
  }, [user]);

  useEffect(() => {
    if (!user) {
      setMessages([]);
      loadedRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, role, content, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(200);
      if (cancelled) return;
      if (error) {
        console.error("Failed to load chat history:", error);
        loadedRef.current = true;
        return;
      }
      const loaded: ChatMessage[] = (data || [])
        .filter((m: any) => m.role === "user" || m.role === "assistant")
        .map((m: any) => ({ id: m.id, role: m.role, content: m.content }));
      setMessages(loaded);
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`chat-messages-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const m: any = payload.new;
          if (!m) return;
          if (m.role !== "user" && m.role !== "assistant") return;
          setMessages((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev;
            return [...prev, { id: m.id, role: m.role, content: m.content }];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_messages", filter: `user_id=eq.${user.id}` },
        () => {
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const persistMessage = useCallback(
    async (role: "user" | "assistant", content: string, bookId?: string | null): Promise<string | undefined> => {
      if (!user) return undefined;
      const { data, error } = await supabase
        .from("chat_messages")
        .insert({ user_id: user.id, role, content, book_id: bookId || null })
        .select("id")
        .single();
      if (error) {
        console.error("Failed to persist chat message:", error);
        return undefined;
      }
      return data?.id;
    },
    [user]
  );

  const clearChat = useCallback(async () => {
    abortRef.current?.abort();
    setMessages([]);
    if (user) {
      const { error } = await supabase.from("chat_messages").delete().eq("user_id", user.id);
      if (error) console.error("Failed to clear chat history:", error);
    }
    toast.success("Chat cleared");
  }, [user]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string, opts?: SendOpts): Promise<string> => {
      const trimmed = text.trim();
      if (!trimmed) return "";
      if (!apiKey) {
        toast.error("Set your OpenRouter API key first");
        throw new Error("Missing API key");
      }

      const selectedBook = books.find((b) => b.id === activeBookId);
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      persistMessage("user", trimmed, activeBookId).then((id) => {
        if (id) {
          setMessages((prev) => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "user" && copy[i].content === trimmed && !copy[i].id) {
                copy[i] = { ...copy[i], id };
                break;
              }
            }
            return copy;
          });
        }
      });

      setIsLoading(true);

      const baseHistory = [...messages, userMsg]
        .filter((m) => !m.displayOnly)
        .map((m) => ({ role: m.role, content: m.content }));

      const isVoice = !!opts?.voiceMode;
      // Deep Research is a paid feature — enforced here so every send path
      // (chat, voice, hands-free) respects the plan regardless of toggle state.
      const deepResearch = (isVoice ? voiceDeepResearch : chatDeepResearch) && isPaid;
      const scopedPromptBody = getActiveBodyForScope(isVoice ? "voice" : "chat");
      const promptToInject = scopedPromptBody || customSystemPrompt;

      const systemPrompt = await buildChatSystemPrompt({
        books,
        selectedBook,
        deepResearch,
        voiceMode: isVoice,
        latestUserQuery: trimmed,
        customSystemPrompt: promptToInject,
        activeWikiName: activeWiki?.name || null,
        activeWikiId: activeWikiId || null,
      });

      const assistantEvents: ToolEvent[] = [];
      // Raw web_search answers captured this turn, surfaced as a "full answer"
      // card after the model's synthesized reply.
      const webSearchCards: { answer: string; citations: Array<{ title?: string; url: string; snippet?: string }> }[] = [];
      // Structured block sets emitted via the render_blocks tool this turn.
      const blockSets: ResponseBlock[][] = [];
      // Artifacts emitted via the create_artifact tool this turn.
      const artifacts: Artifact[] = [];
      let assistantText = "";
      setMessages((prev) => [...prev, { role: "assistant", content: "", toolEvents: [] }]);

      const updateAssistant = () => {
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant") {
              copy[i] = { ...copy[i], content: assistantText, toolEvents: [...assistantEvents] };
              break;
            }
          }
          return copy;
        });
      };

      const model = opts?.modelOverride || (deepResearch ? deepResearchModel : selectedModel);
      if (isEmbeddingModel(model)) {
        const msg = `"${model}" is an embedding model — pick a chat model in Settings (it's only valid for Wiki reindex).`;
        toast.error(msg);
        assistantText = `❌ ${msg}`;
        updateAssistant();
        setIsLoading(false);
        return;
      }
      const workingMessages: any[] = [
        { role: "system", content: systemPrompt },
        ...baseHistory,
      ];

      abortRef.current = new AbortController();

      try {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": window.location.origin,
              "X-Title": "Chapter Craft",
            },
            body: JSON.stringify({
              model,
              messages: workingMessages,
              tools: CHAT_TOOL_DEFINITIONS,
              tool_choice: "auto",
              stream: true,
            }),
            signal: abortRef.current.signal,
          });

          if (!response.ok) {
            const errText = await response.text();
            if (response.status === 401) throw new Error("Invalid API key.");
            if (response.status === 402) throw new Error("Insufficient credits.");
            if (response.status === 429) throw new Error("Rate limited. Try again.");
            throw new Error(`OpenRouter error (${response.status}): ${errText}`);
          }

          const reader = response.body?.getReader();
          if (!reader) throw new Error("No response stream");
          const decoder = new TextDecoder();
          let buffer = "";
          let iterText = "";
          const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};
          let finishReason: string | null = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) !== -1) {
              let line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === "[DONE]") break;
              try {
                const parsed = JSON.parse(jsonStr);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;
                if (delta?.content) {
                  iterText += delta.content;
                  assistantText += delta.content;
                  updateAssistant();
                  try { opts?.onDelta?.(assistantText); } catch {}
                }
                if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAcc[idx]) toolCallAcc[idx] = { args: "" };
                    if (tc.id) toolCallAcc[idx].id = tc.id;
                    if (tc.function?.name) toolCallAcc[idx].name = tc.function.name;
                    if (tc.function?.arguments) toolCallAcc[idx].args += tc.function.arguments;
                  }
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
              } catch {
              }
            }
          }

          const toolCalls = Object.values(toolCallAcc).filter((t) => t.name);
          if (toolCalls.length === 0 || finishReason !== "tool_calls") {
            break;
          }

          workingMessages.push({
            role: "assistant",
            content: iterText || null,
            tool_calls: toolCalls.map((t, i) => ({
              id: t.id || `call_${iteration}_${i}`,
              type: "function",
              function: { name: t.name, arguments: t.args || "{}" },
            })),
          });

          for (let i = 0; i < toolCalls.length; i++) {
            const t = toolCalls[i];
            const { result, event } = await executeChatTool(t.name!, t.args || "{}", {
              books,
              activeBookId,
              setActiveBookId: setActiveBookSilent,
              addChapter,
              updateChapter,
              removeChapter,
              burplexityApiToken,
            });
            assistantEvents.push(event);
            updateAssistant();
            const r = result as any;
            if (t.name === "web_search" && r && typeof r === "object" && r.answer) {
              webSearchCards.push({ answer: String(r.answer), citations: Array.isArray(r.citations) ? r.citations : [] });
            }
            if (t.name === "render_blocks") {
              const blocks = parseBlocks(t.args || "{}");
              if (blocks.length) blockSets.push(blocks);
            }
            if (t.name === "create_artifact") {
              const art = parseArtifact(t.args || "{}");
              if (art) artifacts.push(art);
            }
            workingMessages.push({
              role: "tool",
              tool_call_id: t.id || `call_${iteration}_${i}`,
              name: t.name,
              content: JSON.stringify(result).slice(0, 24000),
            });
          }
        }

        if (!assistantText && assistantEvents.length === 0) {
          assistantText = "(No response received)";
          updateAssistant();
        }

        if (assistantText) {
          const id = await persistMessage("assistant", assistantText, activeBookId);
          if (id) {
            setMessages((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                if (copy[i].role === "assistant" && !copy[i].id) {
                  copy[i] = { ...copy[i], id };
                  break;
                }
              }
              return copy;
            });
          }
        }

        // Surface any artifacts the model created this turn. Persist each into
        // the durable Workspace first (survives tab switches / reloads / devices)
        // and link the created item id onto the bubble so tapping it opens the
        // Workspace panel.
        if (artifacts.length) {
          const created = artifacts.map((artifact) =>
            workspaceStore.add({
              userId: user?.id ?? null,
              kind: artifact.kind === "svg" ? "svg" : "html",
              title: artifact.title,
              content: artifact.content,
              meta: { source: "Artifact" },
            })
          );
          setMessages((prev) => [
            ...prev,
            ...artifacts.map((artifact, idx) => ({
              id: `artifact-${Date.now()}-${idx}`,
              role: "assistant" as const,
              content: "",
              artifact,
              workspaceItemId: created[idx]?.id,
              displayOnly: true,
            })),
          ]);
        }

        // Render any structured blocks the model emitted this turn.
        if (blockSets.length) {
          setMessages((prev) => [
            ...prev,
            ...blockSets.map((blocks, idx) => ({
              id: `blocks-${Date.now()}-${idx}`,
              role: "assistant" as const,
              content: "",
              blocks,
              displayOnly: true,
            })),
          ]);
        }

        // Surface the complete raw web_search answer(s) + sources as a card
        // below the model's synthesized reply, so nothing is lost to summarizing.
        if (webSearchCards.length) {
          setMessages((prev) => [
            ...prev,
            ...webSearchCards.map((card, idx) => {
              let md = `📄 **Full search answer**\n\n${card.answer}`;
              if (card.citations.length) {
                md += `\n\n**Sources:**\n` + card.citations
                  .map((c, i) => `${i + 1}. ${c.title ? `[${c.title}](${c.url})` : c.url}`)
                  .join("\n");
              }
              return { id: `websearch-card-${Date.now()}-${idx}`, role: "assistant" as const, content: md, displayOnly: true };
            }),
          ]);
          // Persist research answers to the durable Workspace.
          webSearchCards.forEach((card) =>
            workspaceStore.add({
              userId: user?.id ?? null,
              kind: "research",
              title: deriveResearchTitle(card.answer, trimmed),
              content: card.answer,
              meta: {
                query: trimmed,
                citations: card.citations,
                source: deepResearch ? "Deep Research" : "Web Search",
              },
            })
          );
        }

        return assistantText;
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return assistantText;
        }
        const msg = err?.message || "Failed to get response";
        toast.error(msg);
        assistantText = `❌ Error: ${msg}`;
        updateAssistant();
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [apiKey, books, activeBookId, chatDeepResearch, voiceDeepResearch, isPaid, selectedModel, deepResearchModel, customSystemPrompt, getActiveBodyForScope, burplexityApiToken, messages, persistMessage, addChapter, updateChapter, removeChapter, setActiveBookSilent]
  );


  const injectDisplayMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `inject-${Date.now()}`, role: "assistant", content, displayOnly: true },
    ]);
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        isLoading,
        deepResearch: chatDeepResearch || voiceDeepResearch,
        setDeepResearch: setChatDeepResearch,
        chatDeepResearch,
        setChatDeepResearch,
        voiceDeepResearch,
        setVoiceDeepResearch,
        sendMessage,
        injectDisplayMessage,
        clearChat,
        abort,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = (): ChatContextValue => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
};
