import React, { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, Send, Settings, BookOpen, ChevronDown, ChevronUp, Key, Loader2, Trash2 } from "lucide-react";
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
const CHAT_MODEL = "google/gemini-2.5-flash";

const ChatPanel: React.FC = () => {
  const { books, activeBookId } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(OPENROUTER_STORAGE_KEY) || "");
  const [showSettings, setShowSettings] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(activeBookId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activeBookId) setSelectedBookId(activeBookId);
  }, [activeBookId]);

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

  const selectedBook = books.find((b) => b.id === selectedBookId);

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
      parts.push(`## Currently Selected Book: "${selectedBook.title}"`);
      parts.push(`File: ${selectedBook.fileName} | Pages: ${selectedBook.pageCount}`);

      if (selectedBook.chapters.length > 0) {
        parts.push("");
        parts.push("### Chapter Contents");
        selectedBook.chapters.forEach((ch) => {
          parts.push(`#### ${ch.name} (pages ${ch.startPage}–${ch.endPage})`);
          if (ch.textContent) {
            // Truncate very long chapters to fit context window
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
          model: CHAT_MODEL,
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

  const controls = [
    { command: "Summarize this chapter", desc: "Get a concise summary of the selected chapter" },
    { command: "Summarize the whole book", desc: "Overview of all chapters in the book" },
    { command: "Explain [passage]", desc: "Break down a difficult section" },
    { command: "Compare chapters", desc: "Find themes and differences across chapters" },
    { command: "Key themes", desc: "Identify main themes in the chapter/book" },
    { command: "Generate flashcards", desc: "Create study flashcards from chapter content" },
    { command: "Generate study notes", desc: "Create structured notes from the text" },
    { command: "What happens on page X?", desc: "Ask about specific page content" },
    { command: "List all chapters", desc: "Show all books and chapters in your library" },
    { command: "Suggest further reading", desc: "Get recommendations based on the content" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <MessageCircle className="w-5 h-5 text-primary" />
        <span className="text-sm font-medium text-foreground">Chat with:</span>
        <select
          value={selectedBookId || ""}
          onChange={(e) => setSelectedBookId(e.target.value || null)}
          className="text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground max-w-[250px] truncate"
        >
          <option value="">All books (library overview)</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} ({b.chapters.length} ch.)
            </option>
          ))}
        </select>

        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={showControls ? "default" : "outline"}
            onClick={() => setShowControls(!showControls)}
            title="Show available commands"
          >
            <BookOpen className="w-3.5 h-3.5 mr-1" />
            Controls
            {showControls ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
          </Button>
          <Button
            size="sm"
            variant={showSettings ? "default" : "outline"}
            onClick={() => setShowSettings(!showSettings)}
            title="API Key settings"
          >
            <Key className="w-3.5 h-3.5 mr-1" />
            {apiKey ? "Key ✓" : "Set Key"}
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
        <div className="border-b border-border bg-card px-4 py-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Enter your <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary underline">OpenRouter API key</a>. Your key is stored locally in your browser.
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
      )}

      {/* Controls panel */}
      {showControls && (
        <div className="border-b border-border bg-card px-4 py-3">
          <p className="text-xs font-medium text-foreground mb-2">Available Commands & Prompts</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {controls.map((c) => (
              <button
                key={c.command}
                onClick={() => {
                  setInput(c.command);
                  setShowControls(false);
                  inputRef.current?.focus();
                }}
                className="text-left px-3 py-2 rounded-md border border-border hover:bg-muted/50 transition-colors"
              >
                <span className="text-xs font-medium text-primary">{c.command}</span>
                <span className="text-xs text-muted-foreground block">{c.desc}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            💡 The AI has access to your full library, all book metadata, and the text of all isolated chapters for the selected book. Ask anything!
          </p>
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
                : "Select a book above, or ask about your whole library. Set your OpenRouter API key to get started."}
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
