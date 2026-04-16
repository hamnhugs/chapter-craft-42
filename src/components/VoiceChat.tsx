import React, { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, Volume2, VolumeX, Settings, Plus, X, Trash2, Brain, Loader2, Square } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { fetchKnowledgeEntries, fetchConversationMemory, extractKnowledge } from "@/lib/knowledgeApi";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const SAVED_MODELS_KEY = "openrouter_saved_models";
const SELECTED_MODEL_KEY = "openrouter_selected_model";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const VOICE_ENABLED_KEY = "voice_tts_enabled";

// Check for SpeechRecognition support
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

  // API key & model state (shared with ChatPanel keys)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(OPENROUTER_STORAGE_KEY) || "");
  const [savedModels, setSavedModels] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(SAVED_MODELS_KEY);
      return stored ? JSON.parse(stored) : [DEFAULT_MODEL];
    } catch { return [DEFAULT_MODEL]; }
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      synthRef.current.cancel();
      abortRef.current?.abort();
    };
  }, []);

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
      "You are a voice-based learning tutor for the Chapter Craft app. You have long-term memory and access to the user's knowledge wiki.",
      "Keep responses concise and conversational since they will be spoken aloud. Use short sentences. Avoid markdown formatting, code blocks, or bullet lists — speak naturally.",
    ];

    try {
      const [knowledgeEntries, conversationMemory] = await Promise.all([
        fetchKnowledgeEntries().catch(() => []),
        fetchConversationMemory().catch(() => null),
      ]);

      if (conversationMemory?.summary) {
        parts.push("", "Your Memory from past conversations:", conversationMemory.summary);
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
        relevant.forEach(e => {
          parts.push(`- ${e.title} (${e.entry_type}): ${e.content.slice(0, 150)}`);
        });
      }
    } catch { /* proceed without memory */ }

    parts.push("", `The user has ${books.length} book(s) in their library.`);
    if (selectedBook) {
      parts.push(`Currently discussing: "${selectedBook.title}" (${selectedBook.pageCount} pages, ${selectedBook.chapters.length} chapters).`);
      if (selectedBook.chapters.length > 0) {
        selectedBook.chapters.forEach((ch) => {
          parts.push(`Chapter "${ch.name}" (pages ${ch.startPage}–${ch.endPage})`);
          if (ch.textContent) {
            const text = ch.textContent.length > 8000 ? ch.textContent.slice(0, 8000) + " [truncated]" : ch.textContent;
            parts.push(text);
          }
        });
      }
    }

    return parts.join("\n");
  }, [books, selectedBook]);

  const speak = useCallback((text: string) => {
    if (!ttsEnabled) return;
    synthRef.current.cancel();
    // Strip markdown for TTS
    const clean = text.replace(/[#*_`~\[\]()>|]/g, "").replace(/\n+/g, ". ");
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    synthRef.current.speak(utterance);
  }, [ttsEnabled]);

  const stopSpeaking = () => {
    synthRef.current.cancel();
    setIsSpeaking(false);
  };

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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": window.location.origin,
          "X-Title": "Chapter Craft Voice",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) throw new Error("Invalid API key.");
        if (response.status === 402) throw new Error("Insufficient credits.");
        if (response.status === 429) throw new Error("Rate limited. Try again shortly.");
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

      if (assistantContent) {
        speak(assistantContent);
      } else {
        setMessages([...updatedMessages, { role: "assistant", content: "(No response received)" }]);
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      console.error("Voice chat error:", err);
      toast.error(err.message || "Failed to get response");
      setMessages([...updatedMessages, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, apiKey, selectedModel, buildSystemPrompt, speak]);

  const startListening = useCallback(() => {
    if (!SpeechRecognition) {
      toast.error("Speech recognition not supported in this browser. Try Chrome.");
      return;
    }
    if (!apiKey) { toast.error("Set your OpenRouter API key first"); setShowSettings(true); return; }

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
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + " ";
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setInterimTranscript(interim || finalTranscript);

      // Reset silence timer on each result
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const text = (finalTranscript + interim).trim();
        if (text) {
          recognition.stop();
          setIsListening(false);
          setInterimTranscript("");
          sendMessage(text);
        }
      }, 2000); // 2s silence = send
    };

    recognition.onerror = (event: any) => {
      if (event.error !== "aborted") {
        console.error("Speech recognition error:", event.error);
        toast.error(`Microphone error: ${event.error}`);
      }
      setIsListening(false);
      setInterimTranscript("");
    };

    recognition.onend = () => {
      setIsListening(false);
      if (silenceTimer) clearTimeout(silenceTimer);
      const text = finalTranscript.trim();
      if (text) {
        setInterimTranscript("");
        sendMessage(text);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setInterimTranscript("");
  }, [apiKey, sendMessage]);

  const stopListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
    setInterimTranscript("");
  };

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

  const clearChat = () => {
    stopSpeaking();
    abortRef.current?.abort();
    setMessages([]);
    toast.success("Voice chat cleared");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <Mic className="w-5 h-5 text-primary" />
        <span className="text-sm font-medium text-foreground">Model:</span>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground max-w-[280px] truncate"
        >
          {savedModels.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>

        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={ttsEnabled ? "default" : "outline"}
            onClick={() => { setTtsEnabled(!ttsEnabled); if (ttsEnabled) stopSpeaking(); }}
            title={ttsEnabled ? "Disable voice output" : "Enable voice output"}
          >
            {ttsEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </Button>
          {messages.length >= 2 && (
            <Button size="sm" variant="outline" onClick={handleSaveToWiki} disabled={extracting}>
              {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Brain className="w-3.5 h-3.5 mr-1" />}
              Wiki
            </Button>
          )}
          <Button size="sm" variant={showSettings ? "default" : "outline"} onClick={() => setShowSettings(!showSettings)}>
            <Settings className="w-3.5 h-3.5 mr-1" />Settings
          </Button>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearChat}><Trash2 className="w-3.5 h-3.5" /></Button>
          )}
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-border bg-card px-4 py-3 space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">OpenRouter API Key</p>
            <p className="text-xs text-muted-foreground">
              Get your key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary underline">openrouter.ai/keys</a>. Stored locally.
            </p>
            <div className="flex gap-2">
              <Input
                type="password" placeholder="sk-or-v1-..." defaultValue={apiKey}
                className="text-sm font-mono" id="voice-openrouter-key-input"
                onKeyDown={(e) => { if (e.key === "Enter") saveApiKey((e.target as HTMLInputElement).value); }}
              />
              <Button size="sm" onClick={() => { const el = document.getElementById("voice-openrouter-key-input") as HTMLInputElement; saveApiKey(el?.value || ""); }}>Save</Button>
              {apiKey && <Button size="sm" variant="destructive" onClick={() => saveApiKey("")}>Remove</Button>}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Saved Models</p>
            <p className="text-xs text-muted-foreground">
              Paste model names from <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary underline">openrouter.ai/models</a>
            </p>
            <div className="flex gap-2">
              <Input type="text" placeholder="provider/model-name" value={newModelInput} onChange={(e) => setNewModelInput(e.target.value)} className="text-sm font-mono" onKeyDown={(e) => { if (e.key === "Enter") addModel(); }} />
              <Button size="sm" onClick={addModel}><Plus className="w-3.5 h-3.5 mr-1" /> Add</Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {savedModels.map((m) => (
                <span key={m} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border ${m === selectedModel ? "border-primary bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground"}`}>
                  <button onClick={() => setSelectedModel(m)} className="hover:underline">{m}</button>
                  <button onClick={() => removeModel(m)} className="hover:text-destructive ml-0.5"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Mic className="w-12 h-12" />
            <p className="text-base font-medium text-foreground">Voice Chat</p>
            <p className="text-sm text-center max-w-md">
              {selectedBook
                ? `Ready to talk about "${selectedBook.title}". Tap the microphone to start speaking.`
                : "Select a book in the Reader tab, then use voice to discuss it."}
            </p>
            <p className="text-xs text-center text-muted-foreground max-w-sm">
              🎙️ Uses your browser's speech recognition. Speak naturally — after 2 seconds of silence, your message is sent automatically.
            </p>
            {!SpeechRecognition && (
              <p className="text-xs text-destructive text-center">
                ⚠️ Speech recognition is not supported in this browser. Please use Chrome or Edge.
              </p>
            )}
            {!apiKey && (
              <Button size="sm" variant="outline" onClick={() => setShowSettings(true)}>
                <Settings className="w-3.5 h-3.5 mr-1" /> Set API Key
              </Button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-4 py-3 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
              {msg.role === "assistant" ? (
                <div className="prose prose-sm dark:prose-invert max-w-none"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-3"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Interim transcript */}
      {interimTranscript && (
        <div className="px-4 py-2 border-t border-border bg-muted/50">
          <p className="text-sm text-muted-foreground italic">🎙️ {interimTranscript}</p>
        </div>
      )}

      {/* Voice controls */}
      <div className="border-t border-border bg-card px-4 py-4">
        <div className="flex items-center justify-center gap-4">
          {isSpeaking && (
            <Button variant="outline" size="icon" onClick={stopSpeaking} title="Stop speaking">
              <Square className="w-4 h-4" />
            </Button>
          )}

          <button
            onClick={isListening ? stopListening : startListening}
            disabled={isLoading}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
              isListening
                ? "bg-destructive text-destructive-foreground animate-pulse scale-110"
                : isLoading
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:scale-105 active:scale-95"
            }`}
            title={isListening ? "Stop listening" : "Start listening"}
          >
            {isLoading ? (
              <Loader2 className="w-7 h-7 animate-spin" />
            ) : isListening ? (
              <MicOff className="w-7 h-7" />
            ) : (
              <Mic className="w-7 h-7" />
            )}
          </button>

          <p className="text-xs text-muted-foreground w-24 text-center">
            {isListening ? "Listening..." : isLoading ? "Thinking..." : isSpeaking ? "Speaking..." : "Tap to talk"}
          </p>
        </div>
      </div>
    </div>
  );
};

export default VoiceChat;
