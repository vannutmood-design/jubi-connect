import { useEffect, useRef } from "react";

/**
 * Invisible <audio> element that plays a remote WebRTC stream.
 * `playToken` should be bumped from a user gesture (e.g. Accept) so browsers
 * that block autoplay still start the audio.
 */
export function AudioSink({
  stream,
  muted,
  playToken = 0,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  playToken?: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;

    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      void el.play().catch(() => undefined);
    };
    attempt();
    // Tracks can be added to the stream after it is attached; retry on those.
    stream.addEventListener("addtrack", attempt);
    const retry = setTimeout(attempt, 500);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      stream.removeEventListener("addtrack", attempt);
    };
  }, [stream, playToken]);

  return <audio ref={ref} autoPlay playsInline muted={muted} className="hidden" />;
}