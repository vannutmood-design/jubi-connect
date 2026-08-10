import { useCallback, useEffect, useRef, type RefObject } from "react";

export type AudioPlaybackState = {
  hasSrcObject: boolean;
  paused: boolean;
  muted: boolean;
  volume: number;
  error: string | null;
};

/**
 * Invisible <audio> element that plays a remote WebRTC stream.
 * `playToken` should be bumped from a user gesture (e.g. Accept) so browsers
 * that block autoplay still start the audio.
 */
export function AudioSink({
  stream,
  muted,
  playToken = 0,
  audioRef,
  onPlaybackState,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  playToken?: number;
  audioRef?: RefObject<HTMLAudioElement | null>;
  onPlaybackState?: (state: AudioPlaybackState) => void;
}) {
  const internalRef = useRef<HTMLAudioElement>(null);
  const ref = audioRef ?? internalRef;

  const report = useCallback(
    (error: string | null = null) => {
      const el = ref.current;
      if (!el) return;
      onPlaybackState?.({
        hasSrcObject: el.srcObject instanceof MediaStream,
        paused: el.paused,
        muted: el.muted,
        volume: el.volume,
        error,
      });
    },
    [onPlaybackState, ref],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.autoplay = true;
    el.setAttribute("playsinline", "true");
    el.muted = Boolean(muted);
    el.volume = 1;
    report();
    if (!stream) return;

    let cancelled = false;
    const attempt = async () => {
      if (cancelled) return;
      try {
        await el.play();
        report();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Audio playback was rejected";
        console.error("[JUBI voice] remote audio play() rejected", error);
        report(message);
      }
    };
    void attempt();
    // Tracks can be added to the stream after it is attached; retry on those.
    const handleTrack = () => void attempt();
    stream.addEventListener("addtrack", handleTrack);
    const retry = setTimeout(() => void attempt(), 500);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      stream.removeEventListener("addtrack", handleTrack);
    };
  }, [stream, playToken, muted, ref, report]);

  return (
    <audio
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      onCanPlay={() => report()}
      onPause={() => report()}
      onPlaying={() => report()}
      className="hidden"
    />
  );
}