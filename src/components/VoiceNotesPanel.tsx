import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, Save, X, StickyNote, ChevronRight, Eraser } from "lucide-react";
import { toast } from "sonner";

export interface VoiceNote {
  id: string;
  text: string;
  createdAt: number;
}

const STORAGE_KEY = "voice_notes_v1";

export function loadVoiceNotes(): VoiceNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as VoiceNote[]) : [];
  } catch {
    return [];
  }
}

function saveVoiceNotes(notes: VoiceNote[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notes)); } catch {}
}

export function appendVoiceNote(text: string): VoiceNote | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const note: VoiceNote = { id: crypto.randomUUID(), text: trimmed, createdAt: Date.now() };
  const next = [note, ...loadVoiceNotes()];
  saveVoiceNotes(next);
  window.dispatchEvent(new CustomEvent("voice-notes-changed"));
  return note;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const VoiceNotesPanel: React.FC<Props> = ({ open, onClose }) => {
  const [notes, setNotes] = useState<VoiceNote[]>(() => loadVoiceNotes());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [newText, setNewText] = useState("");
  const [showNew, setShowNew] = useState(false);
  const newRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onChange = () => setNotes(loadVoiceNotes());
    window.addEventListener("voice-notes-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("voice-notes-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const persist = (next: VoiceNote[]) => {
    setNotes(next);
    saveVoiceNotes(next);
  };

  const handleAdd = () => {
    const t = newText.trim();
    if (!t) return;
    persist([{ id: crypto.randomUUID(), text: t, createdAt: Date.now() }, ...notes]);
    setNewText("");
    setShowNew(false);
  };

  const handleSaveEdit = (id: string) => {
    const t = editText.trim();
    if (!t) return;
    persist(notes.map((n) => (n.id === id ? { ...n, text: t } : n)));
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    persist(notes.filter((n) => n.id !== id));
  };

  const handleClearAll = () => {
    if (notes.length === 0) return;
    if (!confirm("Delete all voice notes?")) return;
    persist([]);
    toast.success("All notes cleared");
  };

  return (
    <>
      {/* Backdrop overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={`${open ? "translate-x-0" : "translate-x-full"}
          fixed top-0 right-0 h-full z-50
          w-[88vw] sm:w-96 md:w-[28rem] lg:w-[32rem]
          bg-surface-container-low border-l border-outline-variant/20
          shadow-xl
          transition-transform duration-300 ease-out
          flex flex-col`}
        aria-hidden={!open}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-primary" />
            <h2 className="font-headline font-semibold text-sm text-foreground">Voice Notes</h2>
            <span className="text-xs text-on-surface-variant">{notes.length}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-on-surface-variant hover:text-primary hover:bg-surface-container-high"
            aria-label="Close notes panel"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-3 border-b border-outline-variant/10">
          {showNew ? (
            <div className="space-y-2">
              <Textarea
                ref={newRef}
                autoFocus
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Type a note…"
                rows={3}
                className="text-sm"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd}><Save className="w-3.5 h-3.5 mr-1" /> Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowNew(false); setNewText(""); }}>
                  <X className="w-3.5 h-3.5 mr-1" /> Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full" onClick={() => setShowNew(true)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add note
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 space-y-2">
          {notes.length === 0 ? (
            <p className="text-xs text-on-surface-variant text-center py-8">
              No notes yet. On mobile, press &amp; hold a chat bubble to save it here.
            </p>
          ) : (
            notes.map((note) => (
              <div key={note.id} className="border border-outline-variant/20 rounded-lg p-3 bg-surface-container">
                {editingId === note.id ? (
                  <>
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={4}
                      className="text-sm mb-2"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleSaveEdit(note.id)}>
                        <Save className="w-3.5 h-3.5 mr-1" /> Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="w-3.5 h-3.5 mr-1" /> Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">{note.text}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-[10px] text-on-surface-variant/70">
                        {new Date(note.createdAt).toLocaleString()}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => { setEditingId(note.id); setEditText(note.text); }}
                          className="p-1 text-on-surface-variant hover:text-primary"
                          aria-label="Edit note"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(note.id)}
                          className="p-1 text-on-surface-variant hover:text-destructive"
                          aria-label="Delete note"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {notes.length > 0 && (
          <footer className="border-t border-outline-variant/10 px-4 py-2">
            <button
              onClick={handleClearAll}
              className="w-full text-xs text-on-surface-variant hover:text-destructive flex items-center justify-center gap-1 py-1.5"
            >
              <Eraser className="w-3 h-3" /> Clear all
            </button>
          </footer>
        )}
      </aside>
    </>
  );
};

export default VoiceNotesPanel;
