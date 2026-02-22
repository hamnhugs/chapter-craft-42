import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ChapterNameDialogProps {
  open: boolean;
  defaultName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

const ChapterNameDialog: React.FC<ChapterNameDialogProps> = ({
  open,
  defaultName,
  onConfirm,
  onCancel,
}) => {
  const [name, setName] = useState(defaultName);

  React.useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Name this chapter</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="chapter-name">Chapter / Section name</Label>
          <Input
            id="chapter-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Chapter 3 – The Plan"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(name.trim())} disabled={!name.trim()}>
            Save chapter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ChapterNameDialog;
