import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chapter } from "@/types/library";
import { Pencil, Trash2 } from "lucide-react";

interface ChapterManageDialogProps {
  open: boolean;
  chapters: Chapter[];
  onEdit: (chapterId: string, newName: string) => void;
  onDelete: (chapterId: string) => void;
  onClose: () => void;
}

const ChapterManageDialog: React.FC<ChapterManageDialogProps> = ({
  open,
  chapters,
  onEdit,
  onDelete,
  onClose,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startEdit = (ch: Chapter) => {
    setEditingId(ch.id);
    setEditName(ch.name);
    setConfirmDeleteId(null);
  };

  const saveEdit = () => {
    if (editingId && editName.trim()) {
      onEdit(editingId, editName.trim());
      setEditingId(null);
      setEditName("");
    }
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    setConfirmDeleteId(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-display">Manage Chapters</DialogTitle>
          <DialogDescription>Edit or delete chapter entries.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-2 py-2">
          {chapters.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No chapters yet.</p>
          ) : (
            chapters.map((ch) => (
              <div key={ch.id} className="border border-border rounded-lg p-3 space-y-2">
                {editingId === ch.id ? (
                  <div className="space-y-2">
                    <Label htmlFor={`edit-${ch.id}`}>Chapter name</Label>
                    <Input
                      id={`edit-${ch.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editName.trim()) saveEdit();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEdit} disabled={!editName.trim()}>
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{ch.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Pages {ch.startPage}–{ch.endPage}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startEdit(ch)}
                        title="Edit name"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      {confirmDeleteId === ch.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(ch.id)}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setConfirmDeleteId(ch.id);
                            setEditingId(null);
                          }}
                          title="Delete chapter"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ChapterManageDialog;
