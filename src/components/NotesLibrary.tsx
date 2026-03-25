import React, { useEffect, useState, useCallback } from "react";
import { StickyNote, Plus, Trash2, Pencil, Save, X, BookOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface Note {
  id: string;
  book_id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

const NotesLibrary: React.FC = () => {
  const { books, activeBookId } = useApp();
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(activeBookId);

  useEffect(() => {
    if (activeBookId) setSelectedBookId(activeBookId);
  }, [activeBookId]);

  const loadNotes = useCallback(async () => {
    if (!user || !selectedBookId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .eq("book_id", selectedBookId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to load notes:", error);
    } else {
      setNotes((data as Note[]) || []);
    }
    setLoading(false);
  }, [user, selectedBookId]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleCreate = async () => {
    if (!user || !selectedBookId) return;
    const { data, error } = await supabase
      .from("notes")
      .insert({ book_id: selectedBookId, user_id: user.id, title: newTitle, content: newContent })
      .select()
      .single();

    if (error) {
      toast.error("Failed to create note");
      return;
    }
    setNotes((prev) => [data as Note, ...prev]);
    setNewTitle("");
    setNewContent("");
    setShowNew(false);
    toast.success("Note created");
  };

  const handleUpdate = async (id: string) => {
    const { error } = await supabase
      .from("notes")
      .update({ title: editTitle, content: editContent, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      toast.error("Failed to update note");
      return;
    }
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, title: editTitle, content: editContent, updated_at: new Date().toISOString() } : n)));
    setEditingId(null);
    toast.success("Note updated");
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete note");
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== id));
    toast.success("Note deleted");
  };

  const activeBookTitle = books.find((b) => b.id === selectedBookId)?.title;

  return (
    <div className="flex flex-col h-full">
      {/* Book selector */}
      <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center gap-3 flex-wrap">
        <StickyNote className="w-5 h-5 text-primary" />
        <span className="text-sm font-medium text-foreground">Notes for:</span>
        <select
          value={selectedBookId || ""}
          onChange={(e) => setSelectedBookId(e.target.value || null)}
          className="text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground max-w-[250px] truncate"
        >
          <option value="">Select a book…</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>{b.title}</option>
          ))}
        </select>
        {selectedBookId && (
          <Button size="sm" variant="outline" onClick={() => { setShowNew(true); setNewTitle(""); setNewContent(""); }} className="ml-auto">
            <Plus className="w-3.5 h-3.5 mr-1" /> New Note
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedBookId ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <BookOpen className="w-10 h-10" />
            <p className="text-sm">Open a book to see its notes</p>
          </div>
        ) : loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading notes…</p>
        ) : (
          <div className="space-y-3 max-w-2xl mx-auto">
            {/* New note form */}
            {showNew && (
              <div className="border border-primary/30 rounded-lg p-4 bg-primary/5 space-y-2">
                <Input placeholder="Note title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className="text-sm" />
                <Textarea placeholder="Note content…" value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={4} className="text-sm" />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreate}><Save className="w-3.5 h-3.5 mr-1" /> Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowNew(false)}><X className="w-3.5 h-3.5 mr-1" /> Cancel</Button>
                </div>
              </div>
            )}

            {notes.length === 0 && !showNew && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No notes yet for "{activeBookTitle}". Click "New Note" or have your bot add notes via the API.
              </p>
            )}

            {notes.map((note) => (
              <div key={note.id} className="border border-border rounded-lg p-4 bg-card space-y-2">
                {editingId === note.id ? (
                  <>
                    <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-sm" />
                    <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={4} className="text-sm" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleUpdate(note.id)}><Save className="w-3.5 h-3.5 mr-1" /> Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-3.5 h-3.5 mr-1" /> Cancel</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-medium text-sm text-foreground">{note.title || "Untitled"}</h3>
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => { setEditingId(note.id); setEditTitle(note.title); setEditContent(note.content); }} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Edit">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(note.id)} className="p-1 text-muted-foreground hover:text-destructive transition-colors" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{note.content}</p>
                    <p className="text-xs text-muted-foreground/60">{new Date(note.updated_at).toLocaleString()}</p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesLibrary;
