import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { getMicStream, formatDuration, stopStream } from "@/lib/voice";
import { cn } from "@/lib/utils";

/** Tap to record a voice message, tap again to stop — hands the clip to the composer. */
export function VoiceRecorder({ onRecorded }: { onRecorded: (file: File) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    return () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      stopStream(streamRef.current);
    };
  }, []);

  const start = async () => {
    try {
      if (typeof MediaRecorder === "undefined") throw new Error("Recording isn't supported here");
      const stream = await getMicStream();
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunks, { type });
        stopStream(streamRef.current);
        streamRef.current = null;
        setRecording(false);
        setSeconds(0);
        if (blob.size > 0) {
          onRecorded(new File([blob], `voice-message-${Date.now()}.${ext}`, { type }));
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Microphone unavailable");
      stopStream(streamRef.current);
      streamRef.current = null;
    }
  };

  const stop = () => recorderRef.current?.stop();

  return (
    <button
      type="button"
      onClick={() => (recording ? stop() : void start())}
      aria-label={recording ? "Stop recording" : "Record voice message"}
      className={cn(
        "flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors",
        recording
          ? "bg-destructive text-destructive-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {recording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
      {recording && <span className="text-xs font-semibold">{formatDuration(seconds)}</span>}
    </button>
  );
}