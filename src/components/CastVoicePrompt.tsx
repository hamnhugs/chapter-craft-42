/**
 * "Who should this character sound like?" — shown when a character speaks
 * for the first time while Character voices is on. The listener taps through
 * the voices, each one reading the character's own line, until one fits.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { synthesizeSpeech, type InworldVoice, type VoiceStyle } from "@/lib/inworldTts";
import { rankVoices } from "@/lib/castVoices/casting";
import type { CastMember } from "@/lib/castVoices/attribute";

export interface CastVoicePromptProps {
  member: CastMember;
  /** The line they are about to say: what each voice reads as a sample. */
  line: string;
  voices: InworldVoice[] | null;
  narratorVoiceId: string;
  style?: VoiceStyle;
  /** A voice id = use it; null = pick for me; undefined = closed unanswered. */
  onDone: (voiceId: string | null | undefined) => void;
  /** Stop asking for the rest of the book (answers this one as "pick for me"). */
  onStopAsking: () => void;
}

const SAMPLE_CHARS = 180;

const CastVoicePrompt: React.FC<CastVoicePromptProps> = ({ member, line, voices, narratorVoiceId, style, onDone, onStopAsking }) => {
  const ranked = useMemo(
    () => (voices ? rankVoices(member, voices, { narratorVoiceId }) : []),
    [member, voices, narratorVoiceId],
  );
  const [picked, setPicked] = useState<string>(member.voiceId ?? "");
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** One fetch per voice: tapping a voice again replays it for free. */
  const samplesRef = useRef(new Map<string, string>());
  const wantRef = useRef("");

  useEffect(() => { if (!picked && ranked[0]) setPicked(ranked[0].voice_id); }, [picked, ranked]);
  useEffect(() => {
    const samples = samplesRef.current;
    return () => {
      audioRef.current?.pause();
      for (const url of samples.values()) URL.revokeObjectURL(url);
      samples.clear();
    };
  }, []);

  const sample = line.length > SAMPLE_CHARS ? `${line.slice(0, SAMPLE_CHARS).replace(/\s+\S*$/, "")}…` : line;

  const hear = async (voiceId: string) => {
    setPicked(voiceId);
    setFailed(null);
    wantRef.current = voiceId;
    audioRef.current?.pause();
    let url = samplesRef.current.get(voiceId);
    if (!url) {
      setLoading(voiceId);
      try {
        const audio = await synthesizeSpeech(sample, undefined, voiceId, undefined, { style });
        url = URL.createObjectURL(new Blob([audio], { type: "audio/mpeg" }));
        samplesRef.current.set(voiceId, url);
      } catch {
        if (wantRef.current === voiceId) { setFailed(voiceId); setLoading(null); }
        return;
      }
      if (wantRef.current !== voiceId) return;
      setLoading(null);
    }
    const a = audioRef.current ?? (audioRef.current = new Audio());
    a.src = url;
    a.play().catch(() => { /* a tap will replay it */ });
  };

  const pickedName = ranked.find((v) => v.voice_id === picked)?.name;
  const who = [member.gender !== "unknown" ? member.gender : "", member.age !== "unknown" ? member.age : ""].filter(Boolean).join(", ");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(undefined); }}>
      <DialogContent className="flex max-h-[92dvh] w-[min(94vw,28rem)] flex-col gap-3 p-4">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-base">{member.name} speaks for the first time</DialogTitle>
          <DialogDescription className="text-xs">
            Tap a voice to hear it read this line. Pick the one that fits{who ? ` (${who})` : ""}.
          </DialogDescription>
        </DialogHeader>
        <blockquote className="max-h-20 overflow-y-auto border-l-2 border-primary/50 pl-3 text-sm italic text-muted-foreground">
          “{sample}”
        </blockquote>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" role="listbox" aria-label={`Voices for ${member.name}`}>
          {voices === null && <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading voices…</div>}
          {voices !== null && ranked.length === 0 && <div className="py-6 text-sm text-muted-foreground">No voices are available right now.</div>}
          {ranked.map((v, i) => {
            const on = v.voice_id === picked;
            const traits = [v.traits.gender !== "unknown" ? v.traits.gender : "", v.traits.age !== "unknown" ? v.traits.age : ""].filter(Boolean).join(" · ");
            return (
              <button
                key={v.voice_id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => void hear(v.voice_id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${on ? "bg-primary/15 ring-1 ring-primary/60" : "hover:bg-muted/60"}`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
                  {loading === v.voice_id ? <Loader2 className="h-4 w-4 animate-spin" /> : on ? <Check className="h-4 w-4 text-primary" /> : <Volume2 className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {v.name}
                    {i === 0 && v.voice_id === member.voiceId && <span className="ml-2 text-[10px] uppercase tracking-widest text-primary">Suggested</span>}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {failed === v.voice_id ? "Couldn't play this one — tap to try again" : (traits || (v as { description?: string }).description || "")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button disabled={!picked} onClick={() => onDone(picked)}>
            {pickedName ? `Use ${pickedName} for ${member.name}` : "Use this voice"}
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => onDone(null)}>Pick for me</Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onStopAsking}>Stop asking, pick them all</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CastVoicePrompt;
