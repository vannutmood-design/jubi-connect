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
import { AudioSink, type AudioPlaybackState } from "@/components/voice/AudioSink";
import {
  RTC_CONFIG,
  formatDuration,
  getMicStream,
  getRtcConfig,
  hasTurnRelay,
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

type VoiceDiagnostics = {
  connection: string;
  ice: string;
  gathering: string;
  signaling: string;
  localDescription: string;
  remoteDescription: string;
  localAudio: string;
  remoteAudio: string;
  outbound: string;
  inbound: string;
  selectedCandidate: string;
  playback: string;
  candidates: string;
  turn: string;
};

const EMPTY_DIAGNOSTICS: VoiceDiagnostics = {
  connection: "new",
  ice: "new",
  gathering: "new",
  signaling: "stable",
  localDescription: "none",
  remoteDescription: "none",
  localAudio: "0 tracks",
  remoteAudio: "0 tracks",
  outbound: "0 packets / 0 bytes (Δ0)",
  inbound: "0 packets / 0 bytes (Δ0)",
  selectedCandidate: "none",
  playback: "no remote stream",
  candidates: "sent 0 / received 0",
  turn: "checking…",
};

function trackSummary(tracks: MediaStreamTrack[]) {
  if (!tracks.length) return "0 tracks";
  return tracks
    .map((track) => `${track.kind}:${track.readyState}, enabled=${track.enabled}, muted=${track.muted}`)
    .join("; ");
}

function assertAudioSdp(description: RTCSessionDescriptionInit, side: "offer" | "answer") {
  const sdp = description.sdp ?? "";
  const audioLine = sdp.split("\n").find((line) => line.startsWith("m=audio"));
  const rejected = /^m=audio 0\s/.test(audioLine ?? "");
  console.info(`[JUBI voice] ${side} SDP audio`, { audioLine, rejected });
  if (!audioLine || rejected) throw new Error(`${side} rejected the audio media section`);
}

export function VoiceCallProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [playToken, setPlayToken] = useState(0);
  const [diagnostics, setDiagnostics] = useState<VoiceDiagnostics>(EMPTY_DIAGNOSTICS);
  const [playbackState, setPlaybackState] = useState<AudioPlaybackState | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  // Single in-flight promise per peer topic so rapid ICE candidates never race
  // into creating (and sending on) multiple unsubscribed channels.
  const outRef = useRef<{ topic: string; channel: Promise<RealtimeChannel> } | null>(null);
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const iceQueue = useRef<RTCIceCandidateInit[]>([]);
  const callRef = useRef<ActiveCall | null>(null);
  const candidateCounts = useRef({ sent: 0, received: 0 });
  const previousPackets = useRef({ outbound: 0, inbound: 0 });

  useEffect(() => {
    callRef.current = call;
  }, [call]);

  const unlockRemoteAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.muted = false;
    audio.volume = 1;
    void audio.play().catch((error) => {
      // A remote stream may not be attached yet. AudioSink retries when the
      // track arrives, while preserving the element unlocked by this gesture.
      console.info("[JUBI voice] playback unlock pending remote media", error);
    });
  }, []);

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
    setDiagnostics(EMPTY_DIAGNOSTICS);
    setPlaybackState(null);
    candidateCounts.current = { sent: 0, received: 0 };
    previousPackets.current = { outbound: 0, inbound: 0 };
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
      const microphone = stream.getAudioTracks()[0];
      console.info("[JUBI voice] getUserMedia audio track", microphone ? {
        kind: microphone.kind,
        readyState: microphone.readyState,
        enabled: microphone.enabled,
        muted: microphone.muted,
      } : { missing: true });
      if (!microphone || microphone.readyState !== "live") {
        stopStream(stream);
        throw new Error("Microphone did not provide a live audio track");
      }
      localRef.current = stream;
      const config = await getRtcConfig().catch(() => RTC_CONFIG);
      console.info("[JUBI voice] ICE configuration", {
        serverCount: config.iceServers?.length ?? 0,
        turnConfigured: hasTurnRelay(),
      });
      const pc = new RTCPeerConnection(config);

      const remote = new MediaStream();
      remoteRef.current = remote;
      setRemoteStream(remote);

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      if (!pc.getSenders().some((sender) => sender.track?.kind === "audio")) {
        pc.close();
        stopStream(stream);
        throw new Error("Microphone track could not be attached to the call");
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          candidateCounts.current.sent += 1;
          console.info("[JUBI voice] local ICE candidate", {
            type: e.candidate.type,
            protocol: e.candidate.protocol,
          });
          void signal(peerId, "voice-ice", { candidate: e.candidate.toJSON() });
        }
      };
      pc.ontrack = (e) => {
        const target = remoteRef.current;
        if (!target) return;
        if (!target.getTracks().includes(e.track)) target.addTrack(e.track);
        console.info("[JUBI voice] remote track received", {
          kind: e.track.kind,
          readyState: e.track.readyState,
          enabled: e.track.enabled,
          muted: e.track.muted,
          streamCount: e.streams.length,
        });
        e.track.onunmute = () => {
          console.info("[JUBI voice] remote track unmuted", { readyState: e.track.readyState });
          setPlayToken((t) => t + 1);
        };
        e.track.onended = () => {
          console.info("[JUBI voice] remote track ended");
        };
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
      unlockRemoteAudio();
      void (async () => {
        try {
          const pc = await buildPeerConnection(peer.id);
          if (!pc.getSenders().some((sender) => sender.track?.kind === "audio")) {
            throw new Error("Microphone was not attached before creating the offer");
          }
          const offer = await pc.createOffer();
          assertAudioSdp(offer, "offer");
          await pc.setLocalDescription(offer);
          await signal(peer.id, "voice-invite", { sdp: pc.localDescription ?? offer });
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
    [user, profile, buildPeerConnection, signal, teardown, unlockRemoteAudio],
  );

  const acceptCall = useCallback(() => {
    const active = callRef.current;
    const offer = pendingOffer.current;
    if (!active || !offer || pcRef.current) return;
    const connecting: ActiveCall = { ...active, status: "connecting" };
    callRef.current = connecting;
    setCall(connecting);
    setPlayToken((t) => t + 1);
    // Run in the Accept click gesture. The same persistent element is retained
    // for the whole call so browser autoplay permission and srcObject survive
    // subsequent React renders and track events.
    unlockRemoteAudio();
    void (async () => {
      try {
        const pc = await buildPeerConnection(active.peerId);
        await pc.setRemoteDescription(offer);
        pendingOffer.current = null;
        await flushIce();
        if (!pc.getSenders().some((sender) => sender.track?.kind === "audio")) {
          throw new Error("Microphone was not attached before creating the answer");
        }
        const answer = await pc.createAnswer();
        assertAudioSdp(answer, "answer");
        await pc.setLocalDescription(answer);
        await signal(active.peerId, "voice-accept", { sdp: pc.localDescription ?? answer });
        const next: ActiveCall = { ...active, status: "connecting" };
        callRef.current = next;
        setCall(next);
        setPlayToken((t) => t + 1);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not join the call");
        endCall(true);
      }
    })();
  }, [buildPeerConnection, flushIce, signal, endCall, unlockRemoteAudio]);

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
        candidateCounts.current.received += 1;
        console.info("[JUBI voice] remote ICE candidate", {
          type: p.candidate.candidate?.split(" ")[8] ?? "unknown",
        });
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

  useEffect(() => {
    if (!call || call.status === "incoming") return;
    let cancelled = false;
    const inspect = async () => {
      const pc = pcRef.current;
      if (!pc || cancelled) return;
      let outboundPackets = 0;
      let outboundBytes = 0;
      let inboundPackets = 0;
      let inboundBytes = 0;
      let packetsLost = 0;
      let jitter = 0;
      let outboundCodec = "none";
      let inboundCodec = "none";
      let selectedCandidate = "none";
      try {
        const stats = await pc.getStats();
        let selectedPairId: string | undefined;
        stats.forEach((report) => {
          if (report.type === "transport" && report.selectedCandidatePairId) {
            selectedPairId = report.selectedCandidatePairId as string;
          }
          if (report.type === "outbound-rtp" && !report.isRemote && (report.kind === "audio" || report.mediaType === "audio")) {
            outboundPackets += Number(report.packetsSent ?? 0);
            outboundBytes += Number(report.bytesSent ?? 0);
            outboundCodec = String(report.codecId ?? "none");
          }
          if (report.type === "inbound-rtp" && !report.isRemote && (report.kind === "audio" || report.mediaType === "audio")) {
            inboundPackets += Number(report.packetsReceived ?? 0);
            inboundBytes += Number(report.bytesReceived ?? 0);
            packetsLost += Number(report.packetsLost ?? 0);
            jitter = Math.max(jitter, Number(report.jitter ?? 0));
            inboundCodec = String(report.codecId ?? "none");
          }
        });
        let pair = selectedPairId ? stats.get(selectedPairId) : undefined;
        if (!pair) {
          stats.forEach((report) => {
            if (!pair && report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) pair = report;
          });
        }
        if (pair) {
          const local = stats.get(pair.localCandidateId as string);
          const remote = stats.get(pair.remoteCandidateId as string);
          const route = local?.candidateType === "relay" || remote?.candidateType === "relay"
            ? "relay"
            : local?.candidateType === "srflx" || remote?.candidateType === "srflx"
              ? "srflx"
              : "host";
          selectedCandidate = `${route} (${local?.candidateType ?? "?"} → ${remote?.candidateType ?? "?"})`;
        }
      } catch (error) {
        console.error("[JUBI voice] getStats failed", error);
      }
      const outboundDelta = outboundPackets - previousPackets.current.outbound;
      const inboundDelta = inboundPackets - previousPackets.current.inbound;
      previousPackets.current = { outbound: outboundPackets, inbound: inboundPackets };
      const audio = audioRef.current;
      const next: VoiceDiagnostics = {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        localDescription: pc.localDescription?.type ?? "none",
        remoteDescription: pc.remoteDescription?.type ?? "none",
        localAudio: trackSummary(localRef.current?.getAudioTracks() ?? []),
        remoteAudio: trackSummary(remoteRef.current?.getAudioTracks() ?? []),
        outbound: `${outboundPackets} packets / ${outboundBytes} bytes (Δ${outboundDelta}), codec=${outboundCodec}`,
        inbound: `${inboundPackets} packets / ${inboundBytes} bytes (Δ${inboundDelta}), lost=${packetsLost}, jitter=${jitter.toFixed(3)}, codec=${inboundCodec}`,
        selectedCandidate,
        playback: audio
          ? `srcObject=${audio.srcObject instanceof MediaStream}, paused=${audio.paused}, muted=${audio.muted}, volume=${audio.volume}${playbackState?.error ? `, error=${playbackState.error}` : ""}`
          : "audio element missing",
        candidates: `sent ${candidateCounts.current.sent} / received ${candidateCounts.current.received}`,
        turn: hasTurnRelay() ? "configured" : "NOT configured — STUN only",
      };
      console.info("[JUBI voice] media diagnostics", next);
      if (!cancelled) setDiagnostics(next);
    };
    void inspect();
    const id = setInterval(() => void inspect(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [call, playbackState]);

  const toggleMute = () => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  };

  return (
    <VoiceCallContext.Provider value={{ call, startCall }}>
      {children}
      <AudioSink
        stream={remoteStream}
        playToken={playToken}
        audioRef={audioRef}
        onPlaybackState={setPlaybackState}
      />
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

          <section className="w-full max-w-md overflow-auto rounded-lg border border-rail-foreground/20 bg-rail px-3 py-2 font-mono text-[10px] leading-4 text-rail-foreground/80" aria-label="Voice call diagnostics">
            <p>Connection: {diagnostics.connection}</p>
            <p>ICE: {diagnostics.ice} / gathering {diagnostics.gathering}</p>
            <p>Signaling: {diagnostics.signaling}</p>
            <p>Descriptions: {diagnostics.localDescription} / {diagnostics.remoteDescription}</p>
            <p>Local audio: {diagnostics.localAudio}</p>
            <p>Remote audio: {diagnostics.remoteAudio}</p>
            <p>Outbound audio packets: {diagnostics.outbound}</p>
            <p>Inbound audio packets: {diagnostics.inbound}</p>
            <p>Selected ICE candidate: {diagnostics.selectedCandidate}</p>
            <p>ICE candidates: {diagnostics.candidates}</p>
            <p>TURN: {diagnostics.turn}</p>
            <p>Remote audio playback: {diagnostics.playback}</p>
          </section>

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