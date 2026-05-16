import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, Save, X, StickyNote, ChevronRight, Eraser } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export interface VoiceNote {
  id: string;
  text: string;
  createdAt: number;
}

const LEGACY_STORAGE_KEY = "voice_notes_v1";
const LEGACY_MIGRATED_KEY = "voice_notes_migrated_v1";
const VOICE_NOTE_TITLE = "Voice Note";

async function getUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function loadVoiceNotes(): Promise<VoiceNote[]> {
  const uid = await getUserId();
  if (!uid) return [];
  const { data, error } = await supabase
    .from("notes")
    .select("id, content, created_at")
    .eq("user_id", uid)
    .is("book_id", null)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((r: any) => ({
    id: r.id,
    text: r.content ?? "",
    createdAt: new Date(r.created_at).getTime(),
  }));
}

export async function appendVoiceNote(text: string): Promise<VoiceNote | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const uid = await getUserId();
  if (!uid) {
    toast.error("Sign in to save notes");
    return null;
  }
  const { data, error } = await supabase
    .from("notes")
    .insert({ user_id: uid, book_id: null, title: VOICE_NOTE_TITLE, content: trimmed })
    .select("id, content, created_at")
    .single();
  if (error || !data) {
    toast.error("Could not save note");
    return null;
  }
  window.dispatchEvent(new CustomEvent("voice-notes-changed"));
  return {
    id: data.id,
    text: data.content ?? "",
    createdAt: new Date(data.created_at).getTime(),
  };
}

async function migrateLegacyLocalNotes() {
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
      return;
    }
    const legacy = JSON.parse(raw) as VoiceNote[];
    const uid = await getUserId();
    if (!uid) return; // try again after sign-in
    if (Array.isArray(legacy) && legacy.length > 0) {
      const rows = legacy
        .filter((n) => n && n.text?.trim())
        .map((n) => ({
          user_id: uid,
          book_id: null,
          title: VOICE_NOTE_TITLE,
          content: n.text.trim(),
        }));
      if (rows.length > 0) {
        await supabase.from("notes").insert(rows);
      }
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
  } catch {
    // non-fatal
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const VoiceNotesPanel: React.FC<Props> = ({ open, onClose }) => {
  const [notes, setNotes] = useState<VoiceNote[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [newText, setNewText] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const newRef = useRef<HTMLTextAreaElement>(null);
  const userIdRef = useRef<string | null>(null);

  const refresh = async () => {
    const next = await loadVoiceNotes();
    setNotes(next);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLegacyLocalNotes();
      userIdRef.current = await getUserId();
      if (!cancelled) await refresh();
    })();

    const onChange = () => { refresh(); };
    window.addEventListener("voice-notes-changed", onChange);

    // Realtime cross-device sync (only voice notes, current user)
    let channel: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const uid = await getUserId();
      if (!uid || cancelled) return;
      channel = supabase
        .channel(`voice-notes-${uid}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${uid}` },
          (payload) => {
            const row: any = (payload.new as any) ?? (payload.old as any);
            // Only react to voice notes (no book attached)
            if (row && row.book_id === null) refresh();
          }
        )
        .subscribe();
    })();

    const { data: authSub } = supabase.auth.onAuthStateChange(() => { refresh(); });

    return () => {
      cancelled = true;
      window.removeEventListener("voice-notes-changed", onChange);
      if (channel) supabase.removeChannel(channel);
      authSub.subscription.unsubscribe();
    };
  }, []);

  const handleAdd = async () => {
    const t = newText.trim();
    if (!t) return;
    const created = await appendVoiceNote(t);
    if (created) {
      setNewText("");
      setShowNew(false);
      // Optimistic: realtime will also refresh
      setNotes((prev) => [created, ...prev.filter((n) => n.id !== created.id)]);
    }
  };

  const handleSaveEdit = async (id: string) => {
    const t = editText.trim();
    if (!t) return;
    const prev = notes;
    setNotes(prev.map((n) => (n.id === id ? { ...n, text: t } : n)));
    setEditingId(null);
    const { error } = await supabase.from("notes").update({ content: t }).eq("id", id);
    if (error) {
      toast.error("Could not save edit");
      setNotes(prev);
    }
  };

  const handleDelete = async (id: string) => {
    const prev = notes;
    setNotes(prev.filter((n) => n.id !== id));
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) {
      toast.error("Could not delete note");
      setNotes(prev);
    }
  };

  const handleClearAll = async () => {
    if (notes.length === 0) return;
    if (!confirm("Delete all voice notes?")) return;
    const uid = userIdRef.current ?? (await getUserId());
    if (!uid) return;
    const prev = notes;
    setNotes([]);
    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("user_id", uid)
      .is("book_id", null);
    if (error) {
      toast.error("Could not clear notes");
      setNotes(prev);
    } else {
      toast.success("All notes cleared");
    }
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
          {loading ? (
            <p className="text-xs text-on-surface-variant text-center py-8">Loading…</p>
          ) : notes.length === 0 ? (
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
