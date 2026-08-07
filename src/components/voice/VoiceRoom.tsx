import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Headphones, Mic, MicOff, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type Profile } from "@/lib/auth";
import { JubiAvatar } from "@/components/JubiAvatar";
import { AudioSink } from "@/components/voice/AudioSink";
import { Button } from "@/components/ui/button";
import { RTC_CONFIG, getMicStream, joinChannel, roomTopic, stopStream } from "@/lib/voice";
import { cn } from "@/lib/utils";

type Participant = { userId: string; username: string; avatar: string | null };

type Signal = {
  from: string;
  to: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

/** Discord-style voice channel: everyone in the room is meshed peer-to-peer. */
export function VoiceRoom({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { user, profile } = useAuth();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});

  const channelRef = useRef<RealtimeChannel | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Record<string, RTCPeerConnection>>({});
  const iceQueue = useRef<Record<string, RTCIceCandidateInit[]>>({});

  const send = useCallback((event: string, payload: Omit<Signal, "from">) => {
    const ch = channelRef.current;
    if (!ch || !user) return;
    void ch.send({ type: "broadcast", event, payload: { ...payload, from: user.id } });
  }, [user]);

  const dropPeer = useCallback((peerId: string) => {
    peersRef.current[peerId]?.close();
    delete peersRef.current[peerId];
    delete iceQueue.current[peerId];
    setStreams((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const getPeer = useCallback(
    (peerId: string) => {
      const existing = peersRef.current[peerId];
      if (existing) return existing;
      const pc = new RTCPeerConnection(RTC_CONFIG);
      localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current!));
      pc.onicecandidate = (e) => {
        if (e.candidate) send("room-ice", { to: peerId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (stream) setStreams((prev) => ({ ...prev, [peerId]: stream }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") dropPeer(peerId);
      };
      peersRef.current[peerId] = pc;
      return pc;
    },
    [send, dropPeer],
  );

  const leave = useCallback(() => {
    Object.keys(peersRef.current).forEach((id) => {
      peersRef.current[id]?.close();
      delete peersRef.current[id];
    });
    iceQueue.current = {};
    stopStream(localRef.current);
    localRef.current = null;
    if (channelRef.current) void supabase.removeChannel(channelRef.current);
    channelRef.current = null;
    setStreams({});
    setParticipants([]);
    setMuted(false);
    setConnected(false);
  }, []);

  const join = useCallback(() => {
    if (!user || connecting || connected) return;
    setConnecting(true);
    void (async () => {
      try {
        localRef.current = await getMicStream();
        const me = user.id;

        const ch = await joinChannel(
          roomTopic(channelId),
          (channel) => {
            channel.on("presence", { event: "sync" }, () => {
              const state = channel.presenceState<{
                userId: string;
                username: string;
                avatar: string | null;
              }>();
              const people = Object.values(state)
                .flat()
                .map((p) => ({ userId: p.userId, username: p.username, avatar: p.avatar }));
              setParticipants(people);

              const ids = new Set(people.map((p) => p.userId));
              // tear down peers that left
              Object.keys(peersRef.current).forEach((id) => {
                if (!ids.has(id)) dropPeer(id);
              });
              // the lower user id always makes the offer, so both sides agree on roles
              people.forEach((p) => {
                if (p.userId === me || peersRef.current[p.userId]) return;
                if (me < p.userId) {
                  const pc = getPeer(p.userId);
                  void (async () => {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    send("room-offer", { to: p.userId, sdp: offer });
                  })();
                }
              });
            });

            channel.on("broadcast", { event: "room-offer" }, ({ payload }) => {
              const p = payload as Signal;
              if (p.to !== me) return;
              const pc = getPeer(p.from);
              void (async () => {
                if (!p.sdp) return;
                await pc.setRemoteDescription(p.sdp);
                for (const c of iceQueue.current[p.from] ?? []) {
                  await pc.addIceCandidate(c).catch(() => undefined);
                }
                iceQueue.current[p.from] = [];
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                send("room-answer", { to: p.from, sdp: answer });
              })();
            });

            channel.on("broadcast", { event: "room-answer" }, ({ payload }) => {
              const p = payload as Signal;
              if (p.to !== me || !p.sdp) return;
              const pc = peersRef.current[p.from];
              if (!pc) return;
              void (async () => {
                await pc.setRemoteDescription(p.sdp!);
                for (const c of iceQueue.current[p.from] ?? []) {
                  await pc.addIceCandidate(c).catch(() => undefined);
                }
                iceQueue.current[p.from] = [];
              })();
            });

            channel.on("broadcast", { event: "room-ice" }, ({ payload }) => {
              const p = payload as Signal;
              if (p.to !== me || !p.candidate) return;
              const pc = peersRef.current[p.from];
              if (pc?.remoteDescription) void pc.addIceCandidate(p.candidate).catch(() => undefined);
              else (iceQueue.current[p.from] ??= []).push(p.candidate);
            });
          },
          { presenceKey: me },
        );

        channelRef.current = ch;
        await ch.track({
          userId: me,
          username: profile?.display_name || profile?.username || "Member",
          avatar: profile?.avatar_url ?? null,
        });
        setConnected(true);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not join the voice channel");
        leave();
      } finally {
        setConnecting(false);
      }
    })();
  }, [user, profile, channelId, connecting, connected, getPeer, send, dropPeer, leave]);

  useEffect(() => leave, [leave, channelId]);

  const toggleMute = () => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  };

  const others = participants.filter((p) => p.userId !== user?.id);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      {Object.entries(streams).map(([id, stream]) => (
        <AudioSink key={id} stream={stream} />
      ))}

      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary">
        <Headphones className="h-7 w-7" />
      </div>
      <div>
        <h2 className="font-display text-xl font-bold">{channelName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {connected
            ? others.length === 0
              ? "You're the only one here"
              : `${participants.length} people connected`
            : "Voice channel — join to talk with the room"}
        </p>
      </div>

      {connected && (
        <div className="flex flex-wrap items-center justify-center gap-4">
          {participants.map((p) => (
            <div key={p.userId} className="flex w-20 flex-col items-center gap-1">
              <JubiAvatar
                src={p.avatar}
                name={p.username}
                size="lg"
                className={cn(p.userId !== user?.id && "ring-2 ring-brand rounded-full")}
              />
              <span className="w-full truncate text-[11px] text-muted-foreground">
                {p.userId === user?.id ? "You" : p.username}
              </span>
            </div>
          ))}
        </div>
      )}

      {connected ? (
        <div className="flex items-center gap-4">
          <button
            onClick={toggleMute}
            aria-label={muted ? "Unmute" : "Mute"}
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-full",
              muted ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground",
            )}
          >
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <button
            onClick={leave}
            aria-label="Disconnect"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          >
            <PhoneOff className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <Button className="rounded-full px-8" onClick={join} disabled={connecting}>
          {connecting ? "Connecting…" : "Join voice"}
        </Button>
      )}
    </div>
  );
}