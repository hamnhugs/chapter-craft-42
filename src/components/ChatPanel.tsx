import React, { useState, useRef, useEffect } from "react";
import { useApp } from "@/context/AppContext";
import { useChat } from "@/context/ChatContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2 } from "lucide-react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { speak, stopSpeaking, subscribeSpeaking, getSpeakingId } from "@/lib/speak";
import { isEmbeddingModel } from "@/lib/utils";

const ChatPanel: React.FC = () => {
  const { books, activeBookId } = useApp();
  const {
    apiKey, savedModels, selectedModel, deepResearchModel, ttsRate, autoReadReplies, loaded,
    saveApiKey, addModel, removeModel, setSelectedModel, setDeepResearchModel, setTtsRate, setAutoReadReplies,
  } = useChatSettings();
  const { messages, isLoading, deepResearch, setDeepResearch, sendMessage, clearChat } = useChat();
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [newModelInput, setNewModelInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(getSpeakingId());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => subscribeSpeaking(setSpeakingId), []);
  useEffect(() => () => stopSpeaking(), []);

  // Chat cannot use embedding-only models (they're for Wiki reindex). Auto-switch away.
  const chatModels = savedModels.filter((m) => !isEmbeddingModel(m));
  useEffect(() => {
    if (!loaded) return;
    if (isEmbeddingModel(selectedModel)) {
      const fallback = chatModels[0];
      if (fallback) {
        setSelectedModel(fallback);
        toast.message(`Switched Chat to "${fallback}"`, { description: `"${selectedModel}" is an embedding model and can't be used for chat.` });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, selectedModel]);

  // Auto-read assistant replies when the user has the setting enabled.
  const autoReadRef = useRef<{ enabled: boolean; lastId: string | null }>({ enabled: false, lastId: null });
  useEffect(() => {
    const wasEnabled = autoReadRef.current.enabled;
    autoReadRef.current.enabled = autoReadReplies;
    // If user just turned it OFF, stop any in-flight playback.
    if (wasEnabled && !autoReadReplies) stopSpeaking();
    // Seed lastId so we don't read historical messages when toggling ON.
    if (!wasEnabled && autoReadReplies) {
      const last = messages[messages.length - 1];
      autoReadRef.current.lastId = last ? (last.id || String(messages.length - 1)) : null;
    }
  }, [autoReadReplies]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoReadReplies || isLoading) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const id = last.id || `chat-${messages.length - 1}`;
    if (autoReadRef.current.lastId === id) return;
    if (!last.content || !last.content.trim()) return;
    autoReadRef.current.lastId = id;
    speak(last.content, { id: `chat-${last.id || messages.length - 1}`, rate: ttsRate });
  }, [messages, isLoading, autoReadReplies, ttsRate]);

  const bubbleId = (msg: { id?: string }, i: number) => `chat-${msg.id || i}`;
  const handleSpeak = (msg: { id?: string; content: string }, i: number) => {
    const id = bubbleId(msg, i);
    if (speakingId === id) { stopSpeaking(); return; }
    speak(msg.content, { id, rate: ttsRate });
  };

  const handleSaveApiKey = (key: string) => { saveApiKey(key); setShowSettings(false); };
  const handleAddModel = () => { const m = newModelInput.trim(); if (!m) return; addModel(m); setNewModelInput(""); };

  const selectedBook = books.find((b) => b.id === activeBookId);

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first before saving to wiki"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(messages.map(m => ({ role: m.role, content: m.content })), activeBookId || undefined);
      const count = result.entries?.length || 0;
      toast.success(`Saved ${count} knowledge ${count === 1 ? "entry" : "entries"} to your wiki`);
    } catch (err: any) {
      toast.error(err.message || "Failed to extract knowledge");
    } finally {
      setExtracting(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    if (!apiKey) { toast.error("Please set your OpenRouter API key first"); setShowSettings(true); return; }
    setInput("");
    try { await sendMessage(text); } catch { /* surfaced via toast */ }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Settings bar */}
      {showSettings && (
        <div
          className="border-b border-outline-variant/10 bg-surface-container-low px-4 py-3 md:py-4 space-y-4 max-h-[60vh] md:max-h-none overflow-y-auto md:overflow-visible overscroll-contain"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <div className="sticky top-0 -mx-4 -mt-3 px-4 py-2 bg-surface-container-low/95 backdrop-blur-sm flex items-center justify-between z-10 md:hidden">
            <span className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant">Settings</span>
            <button
              onClick={() => setShowSettings(false)}
              aria-label="Close settings"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-3 md:p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">OpenRouter API Key</label>
              <div className="relative">
                <input
                  className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40 transition-all"
                  type="password" placeholder="sk-or-v1-..." defaultValue={apiKey}
                  id="openrouter-key-input"
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveApiKey((e.target as HTMLInputElement).value); }}
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" onClick={() => { const el = document.getElementById("openrouter-key-input") as HTMLInputElement; handleSaveApiKey(el?.value || ""); }}>Save</Button>
                {apiKey && <Button size="sm" variant="destructive" onClick={() => handleSaveApiKey("")}>Remove</Button>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Active Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
              >
                {chatModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <div className="flex gap-2 mt-1">
                <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono bg-surface-container-high border-none" onKeyDown={(e) => { if (e.key === "Enter") handleAddModel(); }} />
                <Button size="sm" onClick={handleAddModel}>Add</Button>
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
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-3 md:p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">science</span>Deep Research Model
              </label>
              <select
                value={deepResearchModel}
                onChange={(e) => setDeepResearchModel(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40"
              >
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <p className="text-[10px] text-on-surface-variant px-1">Used when Deep Research is ON. Pick a strong reasoning model for best results.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">
                <span className="material-symbols-outlined text-xs align-middle mr-1">record_voice_over</span>Auto-read replies
              </label>
              <div className="flex items-center justify-between gap-3 bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <span className="text-sm text-primary">{autoReadReplies ? "On — replies will be read aloud" : "Off"}</span>
                <Switch checked={autoReadReplies} onCheckedChange={setAutoReadReplies} aria-label="Auto-read assistant replies" />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">Reads each new assistant reply aloud using the playback speed below.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1 flex items-center justify-between">
                <span><span className="material-symbols-outlined text-xs align-middle mr-1">volume_up</span>Voice Playback Speed</span>
                <span className="text-primary normal-case tracking-normal">{ttsRate.toFixed(2)}×</span>
              </label>
              <div className="bg-surface-container-high rounded-lg py-3 px-4 border border-outline-variant/10">
                <Slider
                  value={[ttsRate]}
                  min={0.5}
                  max={2}
                  step={0.05}
                  onValueChange={(v) => setTtsRate(v[0])}
                />
              </div>
              <p className="text-[10px] text-on-surface-variant px-1">Used for read-aloud buttons here and replies in the Voice tab.</p>
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
            {!apiKey && loaded && (
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-all">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={msg.id || i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""}`}>
            <div className="flex items-center gap-2 mb-2 mx-4">
              {msg.role === "assistant" && <span className="material-symbols-outlined text-primary-container text-lg">auto_stories</span>}
              <span className={`font-headline font-bold text-sm tracking-wide ${msg.role === "user" ? "text-primary" : "text-secondary"}`}>
                {msg.role === "user" ? "You" : "The Librarian"}
              </span>
              {msg.role === "user" && <span className="material-symbols-outlined text-primary text-lg">person</span>}
            </div>
            {msg.role === "assistant" && msg.toolEvents && msg.toolEvents.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 ml-4">
                {msg.toolEvents.map((ev, idx) => (
                  <span key={idx} className={`text-[11px] px-2 py-1 rounded-md ${ev.ok ? "bg-secondary-container/40 text-on-secondary-container" : "bg-destructive/15 text-destructive"}`}>
                    <span className="material-symbols-outlined text-xs align-middle mr-1">{ev.ok ? "build" : "error"}</span>{ev.summary}
                  </span>
                ))}
              </div>
            )}
            <div className={`relative group ${msg.role === "user" ? "message-bubble-user bg-primary-container text-on-primary-container" : "message-bubble-ai bg-surface-container-high text-foreground border-l-2 border-primary-container/20"} p-5 shadow-sm leading-relaxed`}>
              {msg.role === "assistant" ? (
                <div className="prose prose-sm prose-invert max-w-none"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
              ) : (
                <p className="whitespace-pre-wrap font-medium">{msg.content}</p>
              )}
              {msg.content && (
                <button
                  onClick={() => handleSpeak(msg, i)}
                  title={speakingId === bubbleId(msg, i) ? "Stop reading" : "Read aloud"}
                  className={`absolute top-1/2 -translate-y-1/2 ${msg.role === "user" ? "-left-3" : "-right-3"} w-7 h-7 rounded-full bg-surface-container-highest border border-outline-variant/20 shadow-sm flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all opacity-70 hover:opacity-100`}
                >
                  <span className="material-symbols-outlined text-base">
                    {speakingId === bubbleId(msg, i) ? "stop_circle" : "volume_up"}
                  </span>
                </button>
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
                onClick={handleSend}
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
