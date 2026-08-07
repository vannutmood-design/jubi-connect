import { useEffect, useRef } from "react";

/** Invisible <audio> element that plays a remote WebRTC stream. */
export function AudioSink({ stream, muted }: { stream: MediaStream | null; muted?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline muted={muted} className="hidden" />;
}