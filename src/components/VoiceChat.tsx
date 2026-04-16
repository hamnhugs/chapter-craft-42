import React, { useState, useRef, useEffect, useCallback } from "react";
import { useApp } from "@/context/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { fetchKnowledgeEntries, fetchConversationMemory, extractKnowledge } from "@/lib/knowledgeApi";
import { Loader2 } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const SAVED_MODELS_KEY = "openrouter_saved_models";
const SELECTED_MODEL_KEY = "openrouter_selected_model";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const VOICE_ENABLED_KEY = "voice_tts_enabled";

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const VoiceChat: React.FC = () => {
  const { books, activeBookId } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem(VOICE_ENABLED_KEY) !== "false");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const [apiKey, setApiKey] = useState(() => localStorage.getItem(OPENROUTER_STORAGE_KEY) || "");
  const [savedModels, setSavedModels] = useState<string[]>(() => {
    try { const stored = localStorage.getItem(SAVED_MODELS_KEY); return stored ? JSON.parse(stored) : [DEFAULT_MODEL]; }
    catch { return [DEFAULT_MODEL]; }
  });
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(SELECTED_MODEL_KEY) || DEFAULT_MODEL);
  const [newModelInput, setNewModelInput] = useState("");

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef(window.speechSynthesis);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { localStorage.setItem(SAVED_MODELS_KEY, JSON.stringify(savedModels)); }, [savedModels]);
  useEffect(() => { localStorage.setItem(SELECTED_MODEL_KEY, selectedModel); }, [selectedModel]);
  useEffect(() => { localStorage.setItem(VOICE_ENABLED_KEY, String(ttsEnabled)); }, [ttsEnabled]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { return () => { recognitionRef.current?.stop(); synthRef.current.cancel(); abortRef.current?.abort(); }; }, []);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    if (key) { localStorage.setItem(OPENROUTER_STORAGE_KEY, key); toast.success("API key saved"); }
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
    if (savedModels.length <= 1) { toast.error("Need at least one model"); return; }
    setSavedModels((prev) => prev.filter((m) => m !== model));
    if (selectedModel === model) setSelectedModel(savedModels.find((m) => m !== model) || DEFAULT_MODEL);
  };

  const selectedBook = books.find((b) => b.id === activeBookId);

  const buildSystemPrompt = useCallback(async () => {
    const parts: string[] = [
      "You are a voice-based learning tutor for Chapter Craft. Keep responses concise and conversational since they will be spoken aloud.",
    ];
    try {
      const [knowledgeEntries, conversationMemory] = await Promise.all([
        fetchKnowledgeEntries().catch(() => []), fetchConversationMemory().catch(() => null),
      ]);
      if (conversationMemory?.summary) {
        parts.push("", "Your Memory:", conversationMemory.summary);
        if (conversationMemory.key_facts && (conversationMemory.key_facts as string[]).length > 0) {
          parts.push("Key Facts:");
          (conversationMemory.key_facts as string[]).slice(-15).forEach(f => parts.push(`- ${f}`));
        }
      }
      if (knowledgeEntries.length > 0) {
        parts.push("", "Knowledge Wiki:");
        const relevant = selectedBook
          ? knowledgeEntries.filter(e => e.source_book_id === selectedBook.id || !e.source_book_id).slice(0, 20)
          : knowledgeEntries.slice(0, 20);
        relevant.forEach(e => parts.push(`- ${e.title} (${e.entry_type}): ${e.content.slice(0, 150)}`));
      }
    } catch {}
    parts.push("", `The user has ${books.length} book(s).`);
    if (selectedBook) {
      parts.push(`Currently discussing: "${selectedBook.title}".`);
      selectedBook.chapters.forEach((ch) => {
        parts.push(`Chapter "${ch.name}" (pages ${ch.startPage}–${ch.endPage})`);
        if (ch.textContent) parts.push(ch.textContent.slice(0, 8000));
      });
    }
    return parts.join("\n");
  }, [books, selectedBook]);

  const speak = useCallback((text: string) => {
    if (!ttsEnabled) return;
    synthRef.current.cancel();
    const clean = text.replace(/[#*_`~\[\]()>|]/g, "").replace(/\n+/g, ". ");
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    synthRef.current.speak(utterance);
  }, [ttsEnabled]);

  const stopSpeaking = () => { synthRef.current.cancel(); setIsSpeaking(false); };

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (!apiKey) { toast.error("Set your OpenRouter API key first"); setShowSettings(true); return; }
    const userMsg: ChatMessage = { role: "user", content: text.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setIsLoading(true);
    try {
      const systemPrompt = await buildSystemPrompt();
      abortRef.current = new AbortController();
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": window.location.origin, "X-Title": "Chapter Craft Voice" },
        body: JSON.stringify({ model: selectedModel, messages: [{ role: "system", content: systemPrompt }, ...updatedMessages.map((m) => ({ role: m.role, content: m.content }))], stream: true }),
        signal: abortRef.current.signal,
      });
      if (!response.ok) { const errText = await response.text(); throw new Error(`Error (${response.status}): ${errText}`); }
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
          try { const parsed = JSON.parse(jsonStr); const delta = parsed.choices?.[0]?.delta?.content; if (delta) { assistantContent += delta; setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]); } } catch {}
        }
      }
      if (assistantContent) speak(assistantContent);
      else setMessages([...updatedMessages, { role: "assistant", content: "(No response)" }]);
    } catch (err: any) {
      if (err.name === "AbortError") return;
      toast.error(err.message || "Failed to get response");
      setMessages([...updatedMessages, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally { setIsLoading(false); }
  }, [messages, apiKey, selectedModel, buildSystemPrompt, speak]);

  const startListening = useCallback(() => {
    if (!SpeechRecognition) { toast.error("Speech recognition not supported. Try Chrome."); return; }
    if (!apiKey) { toast.error("Set your API key first"); setShowSettings(true); return; }
    stopSpeaking();
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    let finalTranscript = "";
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript + " ";
        else interim += event.results[i][0].transcript;
      }
      setInterimTranscript(interim || finalTranscript);
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const text = (finalTranscript + interim).trim();
        if (text) { recognition.stop(); setIsListening(false); setInterimTranscript(""); sendMessage(text); }
      }, 2000);
    };
    recognition.onerror = (event: any) => { if (event.error !== "aborted") toast.error(`Mic error: ${event.error}`); setIsListening(false); setInterimTranscript(""); };
    recognition.onend = () => { setIsListening(false); if (silenceTimer) clearTimeout(silenceTimer); const text = finalTranscript.trim(); if (text) { setInterimTranscript(""); sendMessage(text); } };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setInterimTranscript("");
  }, [apiKey, sendMessage]);

  const stopListening = () => { recognitionRef.current?.stop(); setIsListening(false); setInterimTranscript(""); };

  const handleSaveToWiki = async () => {
    if (messages.length < 2) { toast.error("Chat first"); return; }
    setExtracting(true);
    try {
      const result = await extractKnowledge(messages.map(m => ({ role: m.role, content: m.content })), activeBookId || undefined);
      toast.success(`Saved ${result.entries?.length || 0} entries to wiki`);
    } catch (err: any) { toast.error(err.message); }
    finally { setExtracting(false); }
  };

  const clearChat = () => { stopSpeaking(); abortRef.current?.abort(); setMessages([]); toast.success("Cleared"); };

  return (
    <div className="flex flex-col h-full">
      {/* Settings */}
      {showSettings && (
        <div className="border-b border-outline-variant/10 bg-surface-container-low px-4 py-4">
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 rounded-xl bg-surface-container-low">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">OpenRouter API Key</label>
              <div className="relative">
                <input className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 pr-10 focus:ring-1 focus:ring-primary/40" type="password" placeholder="sk-or-v1-..." defaultValue={apiKey} id="voice-key-input" onKeyDown={(e) => { if (e.key === "Enter") saveApiKey((e.target as HTMLInputElement).value); }} />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-on-surface-variant text-sm">key</span>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" onClick={() => { const el = document.getElementById("voice-key-input") as HTMLInputElement; saveApiKey(el?.value || ""); }}>Save</Button>
                {apiKey && <Button size="sm" variant="destructive" onClick={() => saveApiKey("")}>Remove</Button>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant px-1">Model</label>
              <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="w-full bg-surface-container-high border-none rounded-lg text-sm text-primary py-2.5 px-4 appearance-none focus:ring-1 focus:ring-primary/40">
                {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
              <div className="flex gap-2 mt-1">
                <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono bg-surface-container-high border-none" onKeyDown={(e) => { if (e.key === "Enter") addModel(); }} />
                <Button size="sm" onClick={addModel}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {savedModels.map((m) => (
                  <span key={m} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md ${m === selectedModel ? "bg-primary-container/20 text-primary" : "bg-surface-container-highest text-on-surface-variant"}`}>
                    <button onClick={() => setSelectedModel(m)} className="hover:underline">{m}</button>
                    <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5 material-symbols-outlined text-xs">close</button>
                  </span>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-6 space-y-6 hide-scrollbar">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-on-surface-variant gap-4">
            <div className="w-24 h-24 rounded-full bg-primary-container/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-5xl text-primary-container">settings_voice</span>
            </div>
            <p className="font-headline font-bold text-xl text-foreground">Voice Chat</p>
            <p className="text-sm text-center max-w-md">
              {selectedBook ? `Ready to discuss "${selectedBook.title}". Tap the mic to start.` : "Select a book first, then use voice to discuss it."}
            </p>
            {!SpeechRecognition && <p className="text-xs text-destructive">⚠️ Use Chrome or Edge for speech recognition.</p>}
            {!apiKey && (
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2 bg-surface-container-high rounded-lg text-primary text-sm border border-outline-variant/10">
                <span className="material-symbols-outlined text-sm">key</span> Set API Key
              </button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%] ${msg.role === "user" ? "self-end" : ""}`}>
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
          <div className="flex justify-start">
            <div className="message-bubble-ai bg-surface-container-high p-5 shadow-sm flex items-center gap-2 italic text-on-surface-variant">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "75ms" }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" style={{ animationDelay: "150ms" }} />
              </div>
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Interim transcript */}
      {interimTranscript && (
        <div className="px-4 py-2 border-t border-outline-variant/10 bg-surface-container-low">
          <p className="text-sm text-on-surface-variant italic">🎙️ {interimTranscript}</p>
        </div>
      )}

      {/* Controls */}
      <div className="border-t border-outline-variant/10 bg-surface-container-low px-4 py-6">
        <div className="flex items-center justify-center gap-6">
          {/* Settings button */}
          <button onClick={() => setShowSettings(!showSettings)} className="p-3 rounded-full bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors">
            <span className="material-symbols-outlined">tune</span>
          </button>

          {/* TTS toggle */}
          <button onClick={() => { setTtsEnabled(!ttsEnabled); if (ttsEnabled) stopSpeaking(); }} className={`p-3 rounded-full transition-all ${ttsEnabled ? "bg-primary-container/20 text-primary" : "bg-surface-container-high text-on-surface-variant"}`}>
            <span className="material-symbols-outlined">{ttsEnabled ? "volume_up" : "volume_off"}</span>
          </button>

          {/* Main mic button */}
          <button
            onClick={isListening ? stopListening : startListening}
            disabled={isLoading}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-lg ${
              isListening
                ? "bg-destructive text-destructive-foreground animate-pulse scale-110"
                : isLoading
                ? "bg-surface-container-highest text-on-surface-variant cursor-not-allowed"
                : "bg-primary-container text-on-primary-container hover:scale-105 active:scale-95"
            }`}
          >
            {isLoading ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : (
              <span className="material-symbols-outlined text-4xl" style={isListening ? { fontVariationSettings: "'FILL' 1" } : undefined}>
                {isListening ? "mic_off" : "mic"}
              </span>
            )}
          </button>

          {/* Wiki save */}
          {messages.length >= 2 && (
            <button onClick={handleSaveToWiki} disabled={extracting} className="p-3 rounded-full bg-secondary-container text-on-secondary-container hover:bg-secondary-container/80 transition-all disabled:opacity-50">
              {extracting ? <Loader2 className="w-5 h-5 animate-spin" /> : <span className="material-symbols-outlined">history_edu</span>}
            </button>
          )}

          {/* Clear */}
          {messages.length > 0 && (
            <button onClick={clearChat} className="p-3 rounded-full bg-surface-container-high text-on-surface-variant hover:text-destructive transition-colors">
              <span className="material-symbols-outlined">delete</span>
            </button>
          )}
        </div>
        <p className="text-xs text-on-surface-variant text-center mt-3">
          {isListening ? "Listening..." : isLoading ? "Thinking..." : isSpeaking ? "Speaking..." : "Tap to talk"}
        </p>
      </div>
    </div>
  );
};

export default VoiceChat;
