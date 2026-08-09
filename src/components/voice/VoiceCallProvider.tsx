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
  getRtcConfig,
  inboxTopic,
  joinChannel,
  stopStream,
  vibrate,
} from "@/lib/voice";
import { cn } from "@/lib/utils";

type CallStatus = "outgoing" | "incoming" | "connecting" | "connected" | "reconnecting";

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

// A single shared inbox subscription per user. Two channels on the same realtime
// topic fight over the same server-side join, so remounts (StrictMode, route
// changes) must reuse one channel instead of joining twice.
let inbox: {
  userId: string;
  promise: Promise<RealtimeChannel>;
  count: number;
} | null = null;

function acquireInbox(userId: string, setup: (ch: RealtimeChannel) => void) {
  if (!inbox || inbox.userId !== userId) {
    if (inbox) {
      const stale = inbox;
      void stale.promise.then((ch) => supabase.removeChannel(ch)).catch(() => undefined);
    }
    inbox = { userId, promise: joinChannel(inboxTopic(userId), setup), count: 0 };
  }
  inbox.count += 1;
  const current = inbox;
  return () => {
    current.count -= 1;
    setTimeout(() => {
      if (current.count > 0 || inbox !== current) return;
      inbox = null;
      void current.promise.then((ch) => supabase.removeChannel(ch)).catch(() => undefined);
    }, 800);
  };
}

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
  const [playToken, setPlayToken] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  // Single in-flight promise per peer topic so rapid ICE candidates never race
  // into creating (and sending on) multiple unsubscribed channels.
  const outRef = useRef<{ topic: string; channel: Promise<RealtimeChannel> } | null>(null);
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const iceQueue = useRef<RTCIceCandidateInit[]>([]);
  const callRef = useRef<ActiveCall | null>(null);

  useEffect(() => {
    callRef.current = call;
  }, [call]);

  const outChannel = useCallback((peerId: string) => {
    const topic = inboxTopic(peerId);
    if (!outRef.current || outRef.current.topic !== topic) {
      outRef.current = { topic, channel: joinChannel(topic) };
    }
    return outRef.current.channel;
  }, []);

  const signal = useCallback(
    async (peerId: string, event: string, payload: Record<string, unknown> = {}) => {
      if (!user) return;
      let channel: RealtimeChannel;
      try {
        channel = await outChannel(peerId);
      } catch {
        return;
      }
      await channel.send({
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
    [user, profile, outChannel],
  );

  const teardown = useCallback(() => {
    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
    }
    pcRef.current = null;
    stopStream(localRef.current);
    localRef.current = null;
    const out = outRef.current;
    if (out) void out.channel.then((ch) => supabase.removeChannel(ch)).catch(() => undefined);
    outRef.current = null;
    pendingOffer.current = null;
    iceQueue.current = [];
    remoteRef.current?.getTracks().forEach((t) => t.stop());
    remoteRef.current = null;
    setRemoteStream(null);
    setMuted(false);
    setSeconds(0);
    setCall(null);
    callRef.current = null;
  }, []);

  const endCall = useCallback(
    (notify = true, message?: string) => {
      const active = callRef.current;
      if (!active && !pcRef.current) return;
      if (active && notify) void signal(active.peerId, "voice-hangup");
      if (message) toast.info(message);
      // give the broadcast a tick to flush before the channel is torn down
      setTimeout(teardown, 120);
      setCall(null);
      callRef.current = null;
    },
    [signal, teardown],
  );

  const buildPeerConnection = useCallback(
    async (peerId: string) => {
      // Join the signalling channel BEFORE any candidate can be produced,
      // otherwise early trickled candidates are sent on an unsubscribed
      // channel and silently dropped (call connects, but no audio).
      await outChannel(peerId).catch(() => undefined);
      const stream = await getMicStream();
      localRef.current = stream;
      const config = await getRtcConfig().catch(() => RTC_CONFIG);
      const pc = new RTCPeerConnection(config);

      const remote = new MediaStream();
      remoteRef.current = remote;
      setRemoteStream(remote);

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (e) => {
        if (e.candidate) void signal(peerId, "voice-ice", { candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const target = remoteRef.current;
        if (!target) return;
        if (!target.getTracks().includes(e.track)) target.addTrack(e.track);
        setPlayToken((t) => t + 1);
      };
      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const active = callRef.current;
        if (pc.connectionState === "connected") {
          setPlayToken((t) => t + 1);
          if (active) setCall({ ...active, status: "connected" });
        } else if (pc.connectionState === "disconnected") {
          if (active) setCall({ ...active, status: "reconnecting" });
        } else if (pc.connectionState === "failed") {
          endCall(true, "Call connection lost");
        }
      };
      pcRef.current = pc;
      return pc;
    },
    [signal, endCall, outChannel],
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
      if (callRef.current || pcRef.current) {
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
    if (!active || !offer || pcRef.current) return;
    const connecting: ActiveCall = { ...active, status: "connecting" };
    callRef.current = connecting;
    setCall(connecting);
    setPlayToken((t) => t + 1);
    void (async () => {
      try {
        const pc = await buildPeerConnection(active.peerId);
        await pc.setRemoteDescription(offer);
        pendingOffer.current = null;
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await signal(active.peerId, "voice-accept", { sdp: answer });
        const next: ActiveCall = { ...active, status: "connecting" };
        callRef.current = next;
        setCall(next);
        setPlayToken((t) => t + 1);
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
    callRef.current = null;
  }, [signal, teardown]);

  // Personal inbox: everything addressed to me arrives here.
  // Handlers live in a ref so identity churn (profile loading, call state) can
  // never tear down and re-create the subscription mid-call.
  const handlers = useRef({ signal, flushIce, endCall });
  useEffect(() => {
    handlers.current = { signal, flushIce, endCall };
  }, [signal, flushIce, endCall]);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const release = acquireInbox(userId, (ch) => {
      ch.on("broadcast", { event: "voice-invite" }, ({ payload }) => {
        const p = payload as SignalPayload;
        if (callRef.current || pcRef.current) {
          void handlers.current.signal(p.from, "voice-busy");
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
          if (pc.signalingState !== "have-local-offer") return;
          await pc.setRemoteDescription(p.sdp);
          await handlers.current.flushIce();
          const active = callRef.current;
          if (active && active.status === "outgoing") {
            const next: ActiveCall = { ...active, status: "connecting" };
            callRef.current = next;
            setCall(next);
          }
        })();
      });

      ch.on("broadcast", { event: "voice-ice" }, ({ payload }) => {
        const p = payload as SignalPayload;
        if (!p.candidate) return;
        const pc = pcRef.current;
        if (pc?.remoteDescription) void pc.addIceCandidate(p.candidate).catch(() => undefined);
        else iceQueue.current.push(p.candidate);
      });

      ch.on("broadcast", { event: "voice-decline" }, () =>
        handlers.current.endCall(false, "Call declined"),
      );
      ch.on("broadcast", { event: "voice-busy" }, () =>
        handlers.current.endCall(false, "They're on another call"),
      );
      ch.on("broadcast", { event: "voice-hangup" }, () =>
        handlers.current.endCall(false, "Call ended"),
      );
    });
    return release;
  }, [userId]);

  // Call timer
  useEffect(() => {
    if (call?.status !== "connected" && call?.status !== "reconnecting") return;
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
      <AudioSink stream={remoteStream} playToken={playToken} />
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
              {call.status === "connecting" && "Connecting…"}
              {call.status === "connected" && formatDuration(seconds)}
              {call.status === "reconnecting" && `Reconnecting… ${formatDuration(seconds)}`}
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