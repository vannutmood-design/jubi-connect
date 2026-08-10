import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getIceServers } from "@/lib/ice.functions";

/** Public STUN servers — enough for peer-to-peer audio on most networks. */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

let iceCache: Promise<RTCConfiguration> | null = null;
let turnAvailable = false;

/**
 * ICE configuration including TURN relay when the server has it configured.
 * Falls back to public STUN only if the lookup fails.
 */
export function getRtcConfig(): Promise<RTCConfiguration> {
  if (!iceCache) {
    iceCache = getIceServers()
      .then((r) => {
        turnAvailable = r.hasTurn;
        return {
          iceServers: r.iceServers,
          iceCandidatePoolSize: 4,
          bundlePolicy: "max-bundle" as const,
        };
      })
      .catch(() => {
        turnAvailable = false;
        return RTC_CONFIG;
      });
  }
  return iceCache;
}

export function hasTurnRelay() {
  return turnAvailable;
}

export async function getMicStream(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone is not available on this device");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Subscribe to a realtime channel and resolve once it is actually joined. */
export function joinChannel(
  topic: string,
  setup?: (channel: RealtimeChannel) => void,
  opts?: { presenceKey?: string },
): Promise<RealtimeChannel> {
  const channel = supabase.channel(topic, {
    config: {
      broadcast: { self: false },
      ...(opts?.presenceKey ? { presence: { key: opts.presenceKey } } : {}),
    },
  });
  setup?.(channel);
  return new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve(channel);
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(new Error("Could not connect to the voice service"));
      }
    });
  });
}

export function inboxTopic(userId: string) {
  return `jubi-voice-inbox-${userId}`;
}

export function roomTopic(channelId: string) {
  return `jubi-voice-room-${channelId}`;
}

export function formatDuration(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function vibrate(pattern: number | number[]) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }
}