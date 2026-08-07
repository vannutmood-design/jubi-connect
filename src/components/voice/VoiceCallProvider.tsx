import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { JubiAvatar } from "@/components/JubiAvatar";
import { AudioSink } from "@/components/voice/AudioSink";
import {
  RTC_CONFIG,
  formatDuration,
  getMicStream,
  inboxTopic,
  joinChannel,
  stopStream,
  vibrate,
} from "@/lib/voice";
import { cn } from "@/lib/utils";

type CallStatus = "outgoing" | "incoming" | "connected";

type ActiveCall = {
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  status: CallStatus;
};

type VoiceCallValue = {
  call: ActiveCall | null;
  startCall: (peer: { id: string; name: string; avatar?: string | null }) => void;
};

const VoiceCallContext = createContext<VoiceCallValue>({ call: null, startCall: () => {} });

export const useVoiceCall = () => useContext(VoiceCallContext);

type SignalPayload = {
  from: string;
  fromName?: string;
  fromAvatar?: string | null;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export function VoiceCallProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const outRef = useRef<RealtimeChannel | null>(null);
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const iceQueue = useRef<RTCIceCandidateInit[]>([]);
  const callRef = useRef<ActiveCall | null>(null);

  useEffect(() => {
    callRef.current = call;
  }, [call]);

  const signal = useCallback(
    async (peerId: string, event: string, payload: Record<string, unknown> = {}) => {
      if (!user) return;
      if (!outRef.current) {
        outRef.current = await joinChannel(inboxTopic(peerId));
      }
      await outRef.current.send({
        type: "broadcast",
        event,
        payload: {
          ...payload,
          from: user.id,
          fromName: profile?.display_name || profile?.username || "Someone",
          fromAvatar: profile?.avatar_url ?? null,
        },
      });
    },
    [user, profile],
  );

  const teardown = useCallback(() => {
    pcRef.current?.getSenders().forEach((s) => s.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    stopStream(localRef.current);
    localRef.current = null;
    if (outRef.current) void supabase.removeChannel(outRef.current);
    outRef.current = null;
    pendingOffer.current = null;
    iceQueue.current = [];
    setRemoteStream(null);
    setMuted(false);
    setSeconds(0);
    setCall(null);
  }, []);

  const endCall = useCallback(
    (notify = true, message?: string) => {
      const active = callRef.current;
      if (active && notify) void signal(active.peerId, "voice-hangup");
      if (message) toast.info(message);
      // give the broadcast a tick to flush before the channel is torn down
      setTimeout(teardown, 120);
      setCall(null);
    },
    [signal, teardown],
  );

  const buildPeerConnection = useCallback(
    async (peerId: string) => {
      const stream = await getMicStream();
      localRef.current = stream;
      const pc = new RTCPeerConnection(RTC_CONFIG);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (e) => {
        if (e.candidate) void signal(peerId, "voice-ice", { candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => setRemoteStream(e.streams[0] ?? null);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") endCall(false, "Call connection lost");
      };
      pcRef.current = pc;
      return pc;
    },
    [signal, endCall],
  );

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = iceQueue.current;
    iceQueue.current = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore stale candidate */
      }
    }
  }, []);

  const startCall = useCallback(
    (peer: { id: string; name: string; avatar?: string | null }) => {
      if (!user) return;
      if (callRef.current) {
        toast.error("You're already on a call");
        return;
      }
      const next: ActiveCall = {
        peerId: peer.id,
        peerName: peer.name,
        peerAvatar: peer.avatar ?? null,
        status: "outgoing",
      };
      setCall(next);
      callRef.current = next;
      void (async () => {
        try {
          const pc = await buildPeerConnection(peer.id);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await signal(peer.id, "voice-invite", { sdp: offer });
          await supabase.from("notifications").insert({
            user_id: peer.id,
            type: "call",
            title: "Incoming voice call",
            body: `${profile?.display_name || profile?.username || "Someone"} is calling you`,
            link: `/dm/${user.id}`,
          });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not start the call");
          teardown();
        }
      })();
    },
    [user, profile, buildPeerConnection, signal, teardown],
  );

  const acceptCall = useCallback(() => {
    const active = callRef.current;
    const offer = pendingOffer.current;
    if (!active || !offer) return;
    void (async () => {
      try {
        const pc = await buildPeerConnection(active.peerId);
        await pc.setRemoteDescription(offer);
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await signal(active.peerId, "voice-accept", { sdp: answer });
        setCall({ ...active, status: "connected" });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not join the call");
        endCall(true);
      }
    })();
  }, [buildPeerConnection, flushIce, signal, endCall]);

  const declineCall = useCallback(() => {
    const active = callRef.current;
    if (active) void signal(active.peerId, "voice-decline");
    setTimeout(teardown, 120);
    setCall(null);
  }, [signal, teardown]);

  // Personal inbox: everything addressed to me arrives here.
  useEffect(() => {
    if (!user) return;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    void joinChannel(inboxTopic(user.id), (ch) => {
      ch.on("broadcast", { event: "voice-invite" }, ({ payload }) => {
        const p = payload as SignalPayload;
        if (callRef.current) {
          void signal(p.from, "voice-busy");
          return;
        }
        pendingOffer.current = p.sdp ?? null;
        const next: ActiveCall = {
          peerId: p.from,
          peerName: p.fromName ?? "Someone",
          peerAvatar: p.fromAvatar ?? null,
          status: "incoming",
        };
        callRef.current = next;
        setCall(next);
        vibrate([300, 200, 300]);
      });

      ch.on("broadcast", { event: "voice-accept" }, ({ payload }) => {
        const p = payload as SignalPayload;
        void (async () => {
          const pc = pcRef.current;
          if (!pc || !p.sdp) return;
          await pc.setRemoteDescription(p.sdp);
          await flushIce();
          const active = callRef.current;
          if (active) setCall({ ...active, status: "connected" });
        })();
      });

      ch.on("broadcast", { event: "voice-ice" }, ({ payload }) => {
        const p = payload as SignalPayload;
        if (!p.candidate) return;
        const pc = pcRef.current;
        if (pc?.remoteDescription) void pc.addIceCandidate(p.candidate).catch(() => undefined);
        else iceQueue.current.push(p.candidate);
      });

      ch.on("broadcast", { event: "voice-decline" }, () => endCall(false, "Call declined"));
      ch.on("broadcast", { event: "voice-busy" }, () => endCall(false, "They're on another call"));
      ch.on("broadcast", { event: "voice-hangup" }, () => endCall(false, "Call ended"));
    })
      .then((ch) => {
        if (cancelled) void supabase.removeChannel(ch);
        else channel = ch;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user, signal, flushIce, endCall]);

  // Call timer
  useEffect(() => {
    if (call?.status !== "connected") return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [call?.status]);

  const toggleMute = () => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  };

  return (
    <VoiceCallContext.Provider value={{ call, startCall }}>
      {children}
      <AudioSink stream={remoteStream} />
      {call && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-rail/95 px-6 py-14 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 pt-10">
            <div className={cn(call.status !== "connected" && "animate-pulse")}>
              <JubiAvatar src={call.peerAvatar} name={call.peerName} size="xl" />
            </div>
            <p className="font-display text-2xl font-bold text-rail-foreground">{call.peerName}</p>
            <p className="text-sm text-rail-foreground/70">
              {call.status === "outgoing" && "Calling…"}
              {call.status === "incoming" && "Incoming voice call"}
              {call.status === "connected" && formatDuration(seconds)}
            </p>
          </div>

          <div className="flex items-center gap-6">
            {call.status === "incoming" ? (
              <>
                <button
                  onClick={declineCall}
                  aria-label="Decline call"
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                >
                  <PhoneOff className="h-6 w-6" />
                </button>
                <button
                  onClick={acceptCall}
                  aria-label="Accept call"
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-brand text-brand-foreground"
                >
                  <Phone className="h-6 w-6" />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute" : "Mute"}
                  className={cn(
                    "flex h-14 w-14 items-center justify-center rounded-full",
                    muted ? "bg-rail-foreground text-rail" : "bg-white/15 text-rail-foreground",
                  )}
                >
                  {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </button>
                <button
                  onClick={() => endCall(true)}
                  aria-label="Hang up"
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                >
                  <PhoneOff className="h-6 w-6" />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </VoiceCallContext.Provider>
  );
}