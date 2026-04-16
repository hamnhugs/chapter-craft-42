import React, { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { fetchKnowledgeEntries, fetchConversationMemory, extractKnowledge } from "@/lib/knowledgeApi";
import { DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_ADVANCED_PROMPT } from "@/lib/deepResearchPrompt";
import { Loader2 } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const SAVED_MODELS_KEY = "openrouter_saved_models";
const SELECTED_MODEL_KEY = "openrouter_selected_model";
const DEEP_RESEARCH_MODEL_KEY = "deep_research_model";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_DEEP_RESEARCH_MODEL = "google/gemini-2.5-pro";

const ChatPanel: React.FC = () => {
  const { books, activeBookId } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(OPENROUTER_STORAGE_KEY) || "");
  const [showSettings, setShowSettings] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [savedModels, setSavedModels] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(SAVED_MODELS_KEY);
      return stored ? JSON.parse(stored) : [DEFAULT_MODEL];
    } catch { return [DEFAULT_MODEL]; }
  });
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(SELECTED_MODEL_KEY) || DEFAULT_MODEL);
  const [newModelInput, setNewModelInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { localStorage.setItem(SAVED_MODELS_KEY, JSON.stringify(savedModels)); }, [savedModels]);
  useEffect(() => { localStorage.setItem(SELECTED_MODEL_KEY, selectedModel); }, [selectedModel]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    if (key) { localStorage.setItem(OPENROUTER_STORAGE_KEY, key); toast.success("OpenRouter API key saved"); }
    else { localStorage.removeItem(OPENROUTER_STORAGE_KEY); toast.success("API key removed"); }
    setShowSettings(false);
  };

  const addModel = () => {
    const model = newModelInput.trim();
    if (!model) return;
    if (savedModels.includes(model)) { toast.error("Model already saved"); return; }
    setSavedModels((prev) => [...prev, model]);
    setSelectedModel(model);
    setNewModelInput("");
    toast.success(`Model "${model}" added`);
  };

  const removeModel = (model: string) => {
    if (savedModels.length <= 1) { toast.error("You need at least one model"); return; }
    setSavedModels((prev) => prev.filter((m) => m !== model));
    if (selectedModel === model) setSelectedModel(savedModels.find((m) => m !== model) || DEFAULT_MODEL);
  };

  const selectedBook = books.find((b) => b.id === activeBookId);

  const buildSystemPrompt = useCallback(async () => {
    const parts: string[] = [
      "You are an intelligent reading assistant for the Chapter Craft app with long-term memory. You help users understand, analyze, and discuss their books and chapters.",
    ];

    try {
      const [knowledgeEntries, conversationMemory] = await Promise.all([
        fetchKnowledgeEntries().catch(() => []),
        fetchConversationMemory().catch(() => null),
      ]);

      if (conversationMemory?.summary) {
        parts.push("", "## Your Memory (from past conversations)", conversationMemory.summary);
        if (conversationMemory.key_facts && conversationMemory.key_facts.length > 0) {
          parts.push("", "### Key Facts You've Learned");
          (conversationMemory.key_facts as string[]).slice(-20).forEach(f => parts.push(`- ${f}`));
        }
      }

      if (knowledgeEntries.length > 0) {
        parts.push("", "## Your Knowledge Wiki");
        const relevant = selectedBook
          ? knowledgeEntries.filter(e => e.source_book_id === selectedBook.id || !e.source_book_id).slice(0, 30)
          : knowledgeEntries.slice(0, 30);
        relevant.forEach(e => {
          parts.push(`- **${e.title}** (${e.entry_type}, ${Math.round(e.confidence * 100)}%): ${e.content.slice(0, 200)}`);
        });
      }
    } catch { /* proceed without memory */ }

    parts.push("", "## Available Library", `The user has ${books.length} book(s) in their library:`);
    books.forEach((book) => {
      parts.push(`- **${book.title}** (${book.pageCount} pages, ${book.chapters.length} chapter(s))`);
      book.chapters.forEach((ch) => {
        parts.push(`  - Chapter: "${ch.name}" (pages ${ch.startPage}–${ch.endPage})`);
      });
    });

    if (selectedBook) {
      parts.push("", `## Currently Active Book: "${selectedBook.title}"`);
      parts.push(`File: ${selectedBook.fileName} | Pages: ${selectedBook.pageCount}`);
      if (selectedBook.chapters.length > 0) {
        parts.push("", "### Chapter Contents");
        selectedBook.chapters.forEach((ch) => {
          parts.push(`#### ${ch.name} (pages ${ch.startPage}–${ch.endPage})`);
          if (ch.textContent) {
            const text = ch.textContent.length > 12000 ? ch.textContent.slice(0, 12000) + "\n\n[...truncated]" : ch.textContent;
            parts.push(text);
          } else {
            parts.push("(No text content extracted for this chapter)");
          }
          parts.push("");
        });
      }
    }

    if (deepResearch) {
      parts.push("", DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_ADVANCED_PROMPT);
    }

    parts.push("", "Be concise but thorough. Use markdown formatting. Reference specific chapter names and page numbers when relevant.");
    return parts.join("\n");
  }, [books, selectedBook, deepResearch]);

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first before saving to wiki"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(
        messages.map(m => ({ role: m.role, content: m.content })),
        activeBookId || undefined
      );
      const count = result.entries?.length || 0;
      toast.success(`Saved ${count} knowledge ${count === 1 ? "entry" : "entries"} to your wiki`);
    } catch (err: any) {
      toast.error(err.message || "Failed to extract knowledge");
    } finally {
      setExtracting(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    if (!apiKey) { toast.error("Please set your OpenRouter API key first"); setShowSettings(true); return; }

    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      const systemPrompt = await buildSystemPrompt();
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": window.location.origin,
          "X-Title": "Chapter Craft",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
        }),
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
      let assistantContent = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assistantContent += delta;
              setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);
            }
          } catch { /* partial JSON */ }
        }
      }

      if (!assistantContent) {
        setMessages([...updatedMessages, { role: "assistant", content: "(No response received)" }]);
      }
    } catch (err: any) {
      console.error("Chat error:", err);
      toast.error(err.message || "Failed to get response");
      setMessages([...updatedMessages, { role: "assistant", content: `❌ Error: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const clearChat = () => { setMessages([]); toast.success("Chat cleared"); };

  return (
    <div className="flex flex-col h-full">
      {/* Settings bar */}
      {showSettings && (
        <div className="border-b border-outline-variant/10 bg-surface-container-low px-4 py-4 space-y-4">
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">OpenRouter API Key</label>
              <div className="relative">
                <input
                  className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40 transition-all"
                  type="password" placeholder="sk-or-v1-..." defaultValue={apiKey}
                  id="openrouter-key-input"
                  onKeyDown={(e) => { if (e.key === "Enter") saveApiKey((e.target as HTMLInputElement).value); }}
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" onClick={() => { const el = document.getElementById("openrouter-key-input") as HTMLInputElement; saveApiKey(el?.value || ""); }}>Save</Button>
                {apiKey && <Button size="sm" variant="destructive" onClick={() => saveApiKey("")}>Remove</Button>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Active Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
              >
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <div className="flex gap-2 mt-1">
                <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono bg-surface-container-high border-none" onKeyDown={(e) => { if (e.key === "Enter") addModel(); }} />
                <Button size="sm" onClick={addModel}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {savedModels.map((m) => (
                  <span key={m} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${m === selectedModel ? "bg-primary-container/20 text-primary border border-primary-container/30" : "bg-surface-container-highest text-on-surface-variant"}`}>
                    <button onClick={() => setSelectedModel(m)} className="hover:underline">{m}</button>
                    <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Focus Context</label>
              <div className="flex items-center gap-3 bg-surface-container-high rounded-lg py-2.5 px-4 border border-outline-variant/10">
                <div className="w-2 h-2 rounded-full bg-primary-container shadow-[0_0_8px_rgba(255,191,0,0.4)]" />
                <span className="text-sm font-headline italic text-primary">{selectedBook?.title || "No book selected"}</span>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-6 space-y-6 hide-scrollbar">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-on-surface-variant gap-3">
            <span className="material-symbols-outlined text-5xl text-primary-container">auto_stories</span>
            <p className="font-headline font-bold text-lg text-foreground">The Librarian</p>
            <p className="text-sm text-center max-w-md">
              {selectedBook
                ? `Ready to discuss "${selectedBook.title}". ${selectedBook.chapters.length > 0 ? `${selectedBook.chapters.length} chapter(s) loaded.` : "No chapters isolated yet."}`
                : "Select a book in the Reader tab, then come here to chat about it."}
            </p>
            {!apiKey && (
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""}`}>
            <div className="flex items-center gap-2 mb-2 mx-4">
              {msg.role === "assistant" && <span className="material-symbols-outlined text-primary-container text-lg">auto_stories</span>}
              <span className={`font-headline font-bold text-sm tracking-wide ${msg.role === "user" ? "text-primary" : "text-secondary"}`}>
                {msg.role === "user" ? "You" : "The Librarian"}
              </span>
              {msg.role === "user" && <span className="material-symbols-outlined text-primary text-lg">person</span>}
            </div>
            <div className={`${msg.role === "user" ? "message-bubble-user bg-primary-container text-on-primary-container" : "message-bubble-ai bg-surface-container-high text-foreground border-l-2 border-primary-container/20"} p-5 shadow-sm leading-relaxed`}>
              {msg.role === "assistant" ? (
                <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
              ) : (
                <p className="whitespace-pre-wrap font-medium">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex flex-col items-start max-w-[85%]">
            <div className="flex items-center gap-2 mb-2 ml-4">
              <span className="material-symbols-outlined text-primary-container text-lg">auto_stories</span>
              <span className="font-headline font-bold text-sm text-secondary">The Librarian</span>
            </div>
            <div className="message-bubble-ai bg-surface-container-high p-5 shadow-sm flex items-center gap-2 italic text-on-surface-variant">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "75ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "150ms" }} />
              </div>
              Consulting annotations...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="px-4 pb-4 pt-2">
        <div className="bg-surface-container-low/90 backdrop-blur-xl p-3 rounded-2xl shadow-2xl border border-outline-variant/10 flex flex-col gap-3 max-w-4xl mx-auto">
          <div className="flex items-end gap-3">
            <div className="flex-grow relative">
              <Textarea
                ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={apiKey ? "Ask about your books..." : "Set your OpenRouter API key to start chatting"}
                rows={1} className="bg-surface-container-high border-none rounded-xl text-foreground py-3 px-4 pr-12 focus:ring-1 focus:ring-primary/40 resize-none min-h-[50px] max-h-[120px]" disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="absolute right-2 bottom-2 p-1.5 bg-primary-container text-on-primary-container rounded-lg hover:brightness-110 active:scale-90 transition-all disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-lg">send</span>
              </button>
            </div>
            {messages.length >= 2 && (
              <button
                onClick={handleSaveToWiki}
                disabled={extracting}
                className="h-[50px] px-5 bg-secondary-container text-on-secondary-container rounded-xl flex items-center gap-2 hover:bg-secondary-container/80 transition-all active:scale-95 border border-outline-variant/20 shrink-0"
              >
                {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="material-symbols-outlined text-lg">history_edu</span>}
                <span className="text-sm font-semibold whitespace-nowrap">Save to Wiki</span>
              </button>
            )}
          </div>
          <div className="flex justify-between items-center px-2">
            <div className="flex gap-4">
              <button onClick={() => setDeepResearch(!deepResearch)} className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 transition-colors ${deepResearch ? "text-primary-container" : "text-on-surface-variant hover:text-primary"}`}>
                <span className="material-symbols-outlined text-sm" style={deepResearch ? { fontVariationSettings: "'FILL' 1" } : {}}>science</span> Deep Research {deepResearch ? "ON" : "OFF"}
              </button>
              <button onClick={() => setShowSettings(!showSettings)} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors">
                <span className="material-symbols-outlined text-sm">tune</span> Settings
              </button>
              {messages.length > 0 && (
                <button onClick={clearChat} className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined text-sm">delete</span> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
