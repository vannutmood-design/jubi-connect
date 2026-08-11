import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

export const useVoiceCall = () => useContext(VoiceCallContext);

type SignalPayload = {
  from: string;
  fromName?: string;
  fromAvatar?: string | null;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  ackType?: string;
};

type SignalType = "invite" | "accept" | "ice" | "decline" | "busy" | "hangup" | "ack";

type SignalRow = {
  id: string;
  call_id: string;
  sender_id: string;
  recipient_id: string;
  signal_type: string;
  payload: unknown;
  created_at: string;
};

type SignalingDiagnostics = {
  role: "CALLER" | "CALLEE" | "IDLE";
  currentUserId: string;
  targetUserId: string;
  topic: string;
  channelStatus: string;
  invitationSent: string;
  invitationReceived: string;
  offerSent: string;
  offerReceived: string;
  offerAck: string;
  answerSent: string;
  lastEvent: string;
};

const EMPTY_SIGNALING: SignalingDiagnostics = {
  role: "IDLE",
  currentUserId: "—",
  targetUserId: "—",
  topic: "—",
  channelStatus: "CREATED",
  invitationSent: "no",
  invitationReceived: "no",
  offerSent: "no",
  offerReceived: "no",
  offerAck: "pending",
  answerSent: "no",
  lastEvent: "—",
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
  micLive: string;
  localTrackCount: number;
  remoteTrackCount: number;
  outPackets: number;
  outBytes: number;
  outDelta: number;
  inPackets: number;
  inBytes: number;
  inDelta: number;
  candidateType: string;
  audioPlaying: string;
  audioMuted: string;
  audioVolume: string;
  audioError: string;
  updatedAt: string;
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
  micLive: "NOT LIVE",
  localTrackCount: 0,
  remoteTrackCount: 0,
  outPackets: 0,
  outBytes: 0,
  outDelta: 0,
  inPackets: 0,
  inBytes: 0,
  inDelta: 0,
  candidateType: "none",
  audioPlaying: "paused",
  audioMuted: "—",
  audioVolume: "—",
  audioError: "none",
  updatedAt: "—",
};

function trackSummary(tracks: MediaStreamTrack[]) {
  return tracks.length
    ? tracks
        .map((track) => `${track.kind}:${track.readyState}, enabled=${track.enabled}, muted=${track.muted}`)
        .join("; ")
    : "0 tracks";
}

function DiagRow({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <p className="flex items-start justify-between gap-3">
      <span className="text-white/70">{label}</span>
      <span className={cn("text-right font-bold", bad ? "text-red-400" : "text-emerald-400")}>{value}</span>
    </p>
  );
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
  const [signalingDiagnostics, setSignalingDiagnostics] = useState<SignalingDiagnostics>(EMPTY_SIGNALING);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  const processedSignals = useRef(new Set<string>());
  const invitationTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const signal = useCallback(
    async (peerId: string, event: SignalType, payload: Record<string, unknown> = {}) => {
      const callId = callIdRef.current;
      if (!user || !callId) throw new Error("Call signaling is not initialized");
      const topic = `voice_signals:${peerId}`;
      const timestamp = new Date().toISOString();
      console.info("[JUBI voice signal] outgoing", {
        type: event, callId, senderUserId: user.id, targetUserId: peerId, topic, timestamp,
      });
      const { error } = await supabase.from("voice_signals").insert({
        call_id: callId,
        sender_id: user.id,
        recipient_id: peerId,
        signal_type: event,
        payload: {
          ...payload,
          from: user.id,
          fromName: profile?.display_name || profile?.username || "Someone",
          fromAvatar: profile?.avatar_url ?? null,
        },
      });
      if (error) {
        console.error("[JUBI voice signal] persistence failed", { type: event, callId, topic, message: error.message });
        throw new Error("Could not deliver call signal");
      }
      setSignalingDiagnostics((current) => ({
        ...current,
        targetUserId: peerId,
        invitationSent: event === "invite" ? "yes (persisted)" : current.invitationSent,
        offerSent: event === "invite" ? "yes" : current.offerSent,
        answerSent: event === "accept" ? "yes (persisted)" : current.answerSent,
        lastEvent: `sent ${event} · ${new Date().toLocaleTimeString()}`,
      }));
    },
    [user, profile],
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
    if (invitationTimeout.current) clearTimeout(invitationTimeout.current);
    invitationTimeout.current = null;
    callIdRef.current = null;
    pendingOffer.current = null;
    iceQueue.current = [];
    remoteRef.current?.getTracks().forEach((t) => t.stop());
    remoteRef.current = null;
    setRemoteStream(null);
    setMuted(false);
    setSeconds(0);
    setDiagnostics(EMPTY_DIAGNOSTICS);
    setPlaybackState(null);
    setSignalingDiagnostics((current) => ({ ...EMPTY_SIGNALING, currentUserId: current.currentUserId, topic: current.topic, channelStatus: current.channelStatus }));
    candidateCounts.current = { sent: 0, received: 0 };
    previousPackets.current = { outbound: 0, inbound: 0 };
    setCall(null);
    callRef.current = null;
  }, []);

  const endCall = useCallback(
    (notify = true, message?: string) => {
      const active = callRef.current;
      if (!active && !pcRef.current) return;
      if (active && notify) void signal(active.peerId, "hangup");
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
          void signal(peerId, "ice", { candidate: e.candidate.toJSON() });
        }
      };
      pc.ontrack = (e) => {
        // Preserve the browser-provided remote stream whenever available.
        // Reconstructing it from a track can lose the negotiated stream/track
        // association on WebKit even while RTP is flowing.
        const negotiatedStream = e.streams[0];
        let target = remoteRef.current;
        if (negotiatedStream && target !== negotiatedStream) {
          target = negotiatedStream;
          remoteRef.current = negotiatedStream;
          setRemoteStream(negotiatedStream);
        } else if (target && !target.getTracks().includes(e.track)) {
          target.addTrack(e.track);
        }
        if (!target) {
          target = new MediaStream([e.track]);
          remoteRef.current = target;
          setRemoteStream(target);
        }
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
      callIdRef.current = crypto.randomUUID();
      setSignalingDiagnostics((current) => ({
        ...EMPTY_SIGNALING,
        role: "CALLER",
        currentUserId: user.id,
        targetUserId: peer.id,
        topic: current.topic,
        channelStatus: current.channelStatus,
      }));
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
          await signal(peer.id, "invite", { sdp: pc.localDescription ?? offer });
          invitationTimeout.current = setTimeout(() => {
            if (callRef.current?.status !== "outgoing") return;
            toast.error("Call could not reach the other user");
            teardown();
          }, 12000);
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
        await signal(active.peerId, "accept", { sdp: pc.localDescription ?? answer });
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
    if (active) void signal(active.peerId, "decline");
    setTimeout(teardown, 120);
    setCall(null);
    callRef.current = null;
  }, [signal, teardown]);

  const processSignal = useCallback(async (row: SignalRow) => {
    if (!user || row.recipient_id !== user.id || processedSignals.current.has(row.id)) return;
    processedSignals.current.add(row.id);
    void supabase.from("voice_signals").update({ acknowledged_at: new Date().toISOString() }).eq("id", row.id);
    const p = (row.payload ?? {}) as SignalPayload;
    const type = row.signal_type as SignalType;
    const topic = `voice_signals:${user.id}`;
    console.info("[JUBI voice signal] incoming", {
      type, callId: row.call_id, senderUserId: row.sender_id, targetUserId: row.recipient_id, topic, timestamp: row.created_at,
    });
    setSignalingDiagnostics((current) => ({
      ...current,
      currentUserId: user.id,
      targetUserId: row.sender_id,
      invitationReceived: type === "invite" ? "yes" : current.invitationReceived,
      offerReceived: type === "invite" && p.sdp ? "yes" : current.offerReceived,
      offerAck: type === "ack" && p.ackType === "invite" ? "delivered" : current.offerAck,
      lastEvent: `received ${type} · ${new Date().toLocaleTimeString()}`,
    }));

    if (type === "invite") {
      if (callRef.current || pcRef.current) {
        callIdRef.current = row.call_id;
        await signal(row.sender_id, "busy");
        return;
      }
      callIdRef.current = row.call_id;
      pendingOffer.current = p.sdp ?? null;
      const next: ActiveCall = {
        peerId: row.sender_id,
        peerName: p.fromName ?? "Someone",
        peerAvatar: p.fromAvatar ?? null,
        status: "incoming",
      };
      callRef.current = next;
      setCall(next);
      setSignalingDiagnostics((current) => ({ ...current, role: "CALLEE" }));
      await signal(row.sender_id, "ack", { ackType: "invite" });
      vibrate([300, 200, 300]);
      return;
    }
    if (row.call_id !== callIdRef.current) return;
    if (type === "ack" && p.ackType === "invite") {
      if (invitationTimeout.current) clearTimeout(invitationTimeout.current);
      invitationTimeout.current = null;
      return;
    }
    if (type === "accept") {
      const pc = pcRef.current;
      if (!pc || !p.sdp || pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(p.sdp);
      await flushIce();
      if (invitationTimeout.current) clearTimeout(invitationTimeout.current);
      const active = callRef.current;
      if (active?.status === "outgoing") {
        const next = { ...active, status: "connecting" as const };
        callRef.current = next;
        setCall(next);
      }
      return;
    }
    if (type === "ice" && p.candidate) {
      candidateCounts.current.received += 1;
      const pc = pcRef.current;
      if (pc?.remoteDescription) await pc.addIceCandidate(p.candidate).catch(() => undefined);
      else iceQueue.current.push(p.candidate);
      return;
    }
    if (type === "decline") endCall(false, "Call declined");
    if (type === "busy") endCall(false, "They're on another call");
    if (type === "hangup") endCall(false, "Call ended");
  }, [user, signal, flushIce, endCall]);

  // Persistent database signals close the race where Realtime broadcasts sent
  // before a callee subscribed were permanently lost. Realtime wakes the inbox;
  // the initial query recovers anything sent during mounts, route changes or reconnects.
  const handlers = useRef({ processSignal });
  useEffect(() => {
    handlers.current = { processSignal };
  }, [processSignal]);

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const topic = `voice_signals:${userId}`;
    setSignalingDiagnostics((current) => ({ ...current, currentUserId: userId, topic, channelStatus: "CREATED" }));
    console.info("[JUBI voice signal] inbox", { userId, topic, status: "CREATED", timestamp: new Date().toISOString() });
    const channel = supabase
      .channel(topic)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "voice_signals", filter: `recipient_id=eq.${userId}` }, (change) => {
        void handlers.current.processSignal(change.new as SignalRow);
      })
      .subscribe((status) => {
        const display = status === "CHANNEL_ERROR" ? "ERROR" : status;
        setSignalingDiagnostics((current) => ({ ...current, channelStatus: display }));
        console.info("[JUBI voice signal] inbox", { userId, topic, status: display, timestamp: new Date().toISOString() });
        if (status === "SUBSCRIBED") {
          void supabase.from("voice_signals").select("*")
            .eq("recipient_id", userId).is("acknowledged_at", null).gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: true })
            .then(({ data, error }) => {
              if (error) console.error("[JUBI voice signal] inbox recovery failed", { topic, message: error.message });
              for (const row of data ?? []) void handlers.current.processSignal(row as SignalRow);
            });
        }
      });
    return () => {
      console.info("[JUBI voice signal] inbox", { userId, topic, status: "CLOSED", timestamp: new Date().toISOString() });
      void supabase.removeChannel(channel);
    };
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
      const localTracks = localRef.current?.getAudioTracks() ?? [];
      const remoteTracks = remoteRef.current?.getAudioTracks() ?? [];
      const micTrack = localTracks[0];
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
        micLive: micTrack && micTrack.readyState === "live" ? "LIVE" : "NOT LIVE",
        localTrackCount: localTracks.length,
        remoteTrackCount: remoteTracks.length,
        outPackets: outboundPackets,
        outBytes: outboundBytes,
        outDelta: outboundDelta,
        inPackets: inboundPackets,
        inBytes: inboundBytes,
        inDelta: inboundDelta,
        candidateType: selectedCandidate === "none" ? "none" : (selectedCandidate.split(" ")[0] ?? "none"),
        audioPlaying: audio ? (audio.paused ? "paused" : "playing") : "no element",
        audioMuted: audio ? String(audio.muted) : "—",
        audioVolume: audio ? String(audio.volume) : "—",
        audioError: playbackState?.error ?? "none",
        updatedAt: new Date().toLocaleTimeString(),
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

          <section
            aria-label="Connection diagnostics"
            className="max-h-[45vh] w-full max-w-md shrink-0 overflow-auto rounded-xl border-2 border-brand bg-black/85 px-3 py-2 font-mono text-[11px] leading-5 text-white shadow-lg"
          >
            <p className="mb-1 border-b border-white/20 pb-1 text-[12px] font-bold uppercase tracking-wide text-brand">
              Connection Diagnostics · {diagnostics.updatedAt}
            </p>
            <DiagRow label="Microphone" value={diagnostics.micLive} bad={diagnostics.micLive !== "LIVE"} />
            <DiagRow label="Local audio tracks" value={String(diagnostics.localTrackCount)} bad={diagnostics.localTrackCount === 0} />
            <DiagRow label="Outbound RTP packets" value={`${diagnostics.outPackets} (Δ${diagnostics.outDelta})`} bad={diagnostics.outDelta === 0} />
            <DiagRow label="Outbound RTP bytes" value={String(diagnostics.outBytes)} />
            <DiagRow label="Remote audio tracks" value={String(diagnostics.remoteTrackCount)} bad={diagnostics.remoteTrackCount === 0} />
            <DiagRow label="Inbound RTP packets" value={`${diagnostics.inPackets} (Δ${diagnostics.inDelta})`} bad={diagnostics.inDelta === 0} />
            <DiagRow label="Inbound RTP bytes" value={String(diagnostics.inBytes)} bad={diagnostics.inBytes === 0} />
            <DiagRow label="ICE connection state" value={diagnostics.ice} bad={diagnostics.ice !== "connected" && diagnostics.ice !== "completed"} />
            <DiagRow label="Peer connection state" value={diagnostics.connection} bad={diagnostics.connection !== "connected"} />
            <DiagRow label="Selected ICE candidate" value={diagnostics.candidateType} bad={diagnostics.candidateType === "none"} />
            <DiagRow label="Remote audio element" value={diagnostics.audioPlaying} bad={diagnostics.audioPlaying !== "playing"} />
            <DiagRow label="Remote audio muted" value={diagnostics.audioMuted} bad={diagnostics.audioMuted === "true"} />
            <DiagRow label="Remote audio volume" value={diagnostics.audioVolume} bad={diagnostics.audioVolume === "0"} />
            <DiagRow label="Audio playback error" value={diagnostics.audioError} bad={diagnostics.audioError !== "none"} />
            <DiagRow label="TURN relay" value={diagnostics.turn} bad={!diagnostics.turn.startsWith("configured")} />
            <DiagRow label="ICE candidates" value={diagnostics.candidates} />
            <DiagRow label="Signaling / SDP" value={`${diagnostics.signaling} · ${diagnostics.localDescription}/${diagnostics.remoteDescription}`} />
            <p className="my-1 border-y border-white/20 py-1 text-[12px] font-bold uppercase text-brand">
              Signaling Diagnostics · {signalingDiagnostics.role}
            </p>
            <DiagRow label="Current user ID" value={signalingDiagnostics.currentUserId} />
            <DiagRow label="Target user ID" value={signalingDiagnostics.targetUserId} />
            <DiagRow label="Signaling topic" value={signalingDiagnostics.topic} />
            <DiagRow label="Channel status" value={signalingDiagnostics.channelStatus} bad={signalingDiagnostics.channelStatus !== "SUBSCRIBED"} />
            <DiagRow label="Invitation sent" value={signalingDiagnostics.invitationSent} bad={signalingDiagnostics.role === "CALLER" && signalingDiagnostics.invitationSent === "no"} />
            <DiagRow label="Invitation received" value={signalingDiagnostics.invitationReceived} bad={signalingDiagnostics.role === "CALLEE" && signalingDiagnostics.invitationReceived === "no"} />
            <DiagRow label="Offer sent / received" value={`${signalingDiagnostics.offerSent} / ${signalingDiagnostics.offerReceived}`} />
            <DiagRow label="Offer delivery / ack" value={signalingDiagnostics.offerAck} bad={signalingDiagnostics.role === "CALLER" && signalingDiagnostics.offerAck !== "delivered"} />
            <DiagRow label="Answer sent" value={signalingDiagnostics.answerSent} />
            <DiagRow label="Last signal" value={signalingDiagnostics.lastEvent} />
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