import React, { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, Send, Settings, Plus, X, Key, Loader2, Trash2 } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const OPENROUTER_STORAGE_KEY = "openrouter_api_key";
const SAVED_MODELS_KEY = "openrouter_saved_models";
const SELECTED_MODEL_KEY = "openrouter_selected_model";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    localStorage.setItem(SAVED_MODELS_KEY, JSON.stringify(savedModels));
  }, [savedModels]);

  useEffect(() => {
    localStorage.setItem(SELECTED_MODEL_KEY, selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const saveApiKey = (key: string) => {
    setApiKey(key);
    if (key) {
      localStorage.setItem(OPENROUTER_STORAGE_KEY, key);
      toast.success("OpenRouter API key saved");
    } else {
      localStorage.removeItem(OPENROUTER_STORAGE_KEY);
      toast.success("API key removed");
    }
    setShowSettings(false);
  };

  const addModel = () => {
    const model = newModelInput.trim();
    if (!model) return;
    if (savedModels.includes(model)) {
      toast.error("Model already saved");
      return;
    }
    setSavedModels((prev) => [...prev, model]);
    setSelectedModel(model);
    setNewModelInput("");
    toast.success(`Model "${model}" added`);
  };

  const removeModel = (model: string) => {
    if (savedModels.length <= 1) {
      toast.error("You need at least one model");
      return;
    }
    setSavedModels((prev) => prev.filter((m) => m !== model));
    if (selectedModel === model) {
      setSelectedModel(savedModels.find((m) => m !== model) || DEFAULT_MODEL);
    }
  };

  const selectedBook = books.find((b) => b.id === activeBookId);

  const buildSystemPrompt = useCallback(() => {
    const parts: string[] = [
      "You are an intelligent reading assistant for the Chapter Craft app. You help users understand, analyze, and discuss their books and chapters.",
      "",
      "## Available Library",
      `The user has ${books.length} book(s) in their library:`,
    ];

    books.forEach((book) => {
      parts.push(`- **${book.title}** (${book.pageCount} pages, ${book.chapters.length} chapter(s))`);
      book.chapters.forEach((ch) => {
        parts.push(`  - Chapter: "${ch.name}" (pages ${ch.startPage}–${ch.endPage})`);
      });
    });

    if (selectedBook) {
      parts.push("");
      parts.push(`## Currently Active Book: "${selectedBook.title}"`);
      parts.push(`File: ${selectedBook.fileName} | Pages: ${selectedBook.pageCount}`);

      if (selectedBook.chapters.length > 0) {
        parts.push("");
        parts.push("### Chapter Contents");
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
      } else {
        parts.push("\nThis book has no isolated chapters yet. Suggest the user isolate chapters in the Reader tab first.");
      }
    }

    parts.push("");
    parts.push("## Your Capabilities");
    parts.push("- Summarize chapters or entire books");
    parts.push("- Answer questions about chapter content");
    parts.push("- Compare themes across chapters");
    parts.push("- Explain difficult passages");
    parts.push("- Generate study notes or flashcards from chapter text");
    parts.push("- Suggest related topics or further reading");
    parts.push("- Help with research and analysis");
    parts.push("");
    parts.push("Be concise but thorough. Use markdown formatting. Reference specific chapter names and page numbers when relevant.");

    return parts.join("\n");
  }, [books, selectedBook]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    if (!apiKey) {
      toast.error("Please set your OpenRouter API key first");
      setShowSettings(true);
      return;
    }

    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
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
            { role: "system", content: buildSystemPrompt() },
            ...updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) throw new Error("Invalid API key. Check your OpenRouter key.");
        if (response.status === 402) throw new Error("Insufficient credits on OpenRouter.");
        if (response.status === 429) throw new Error("Rate limited. Try again in a moment.");
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
          } catch {
            // partial JSON, skip
          }
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    toast.success("Chat cleared");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <MessageCircle className="w-5 h-5 text-primary" />
        <span className="text-sm font-medium text-foreground">Model:</span>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground max-w-[280px] truncate"
        >
          {savedModels.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={showSettings ? "default" : "outline"}
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5 mr-1" />
            Settings
          </Button>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearChat} title="Clear chat">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-border bg-card px-4 py-3 space-y-3">
          {/* API Key */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">OpenRouter API Key</p>
            <p className="text-xs text-muted-foreground">
              Get your key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary underline">openrouter.ai/keys</a>. Stored locally in your browser.
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="sk-or-v1-..."
                defaultValue={apiKey}
                className="text-sm font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveApiKey((e.target as HTMLInputElement).value);
                }}
                id="openrouter-key-input"
              />
              <Button
                size="sm"
                onClick={() => {
                  const el = document.getElementById("openrouter-key-input") as HTMLInputElement;
                  saveApiKey(el?.value || "");
                }}
              >
                Save
              </Button>
              {apiKey && (
                <Button size="sm" variant="destructive" onClick={() => saveApiKey("")}>
                  Remove
                </Button>
              )}
            </div>
          </div>

          {/* Saved Models */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Saved Models</p>
            <p className="text-xs text-muted-foreground">
              Paste model names from <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary underline">openrouter.ai/models</a> (e.g. <code className="text-xs bg-muted px-1 rounded">google/gemini-2.5-flash</code>)
            </p>
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="provider/model-name"
                value={newModelInput}
                onChange={(e) => setNewModelInput(e.target.value)}
                className="text-sm font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addModel();
                }}
              />
              <Button size="sm" onClick={addModel}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {savedModels.map((m) => (
                <span
                  key={m}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border ${
                    m === selectedModel ? "border-primary bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  <button onClick={() => setSelectedModel(m)} className="hover:underline">{m}</button>
                  <button
                    onClick={() => removeModel(m)}
                    className="hover:text-destructive ml-0.5"
                    title="Remove model"
                  >
                    <X className="w-3 h-3" />
                  </button>
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
            <MessageCircle className="w-10 h-10" />
            <p className="text-sm text-center max-w-md">
              {selectedBook
                ? `Ready to chat about "${selectedBook.title}". ${selectedBook.chapters.length > 0 ? `${selectedBook.chapters.length} chapter(s) loaded as context.` : "No chapters isolated yet — isolate chapters in the Reader tab for best results."}`
                : "Select a book in the Reader tab, then come here to chat about it. Set your OpenRouter API key in Settings to get started."}
            </p>
            {!apiKey && (
              <Button size="sm" variant="outline" onClick={() => setShowSettings(true)}>
                <Key className="w-3.5 h-3.5 mr-1" /> Set API Key
              </Button>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border bg-card px-4 py-3">
        <div className="flex gap-2 items-end max-w-2xl mx-auto">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={apiKey ? "Ask about your books..." : "Set your OpenRouter API key to start chatting"}
            rows={1}
            className="text-sm resize-none min-h-[40px] max-h-[120px]"
            disabled={isLoading}
          />
          <Button onClick={sendMessage} disabled={isLoading || !input.trim()} size="icon" className="shrink-0">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
