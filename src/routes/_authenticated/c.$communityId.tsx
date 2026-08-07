import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Plus, Settings2, Users, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/ChatView";
import { VoiceRoom } from "@/components/voice/VoiceRoom";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth, type Profile } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/c/$communityId")({
  head: () => ({
    meta: [
      { title: "Community channels — JUBI" },
      { name: "description", content: "Chat with your community across text channels, share files and react to messages on JUBI." },
      { property: "og:title", content: "Community channels — JUBI" },
      { property: "og:description", content: "Chat with your community across text channels on JUBI." },
    ],
  }),
  component: CommunityPage,
});

type Channel = { id: string; name: string; topic: string | null; position: number; kind: string };
type Member = { id: string; user_id: string; role: string };

function CommunityPage() {
  const { communityId } = useParams({ from: "/_authenticated/c/$communityId" });
  const { user } = useAuth();
  const qc = useQueryClient();
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState("");
  const [newChannelKind, setNewChannelKind] = useState<"text" | "voice">("text");

  const { data: community } = useQuery({
    queryKey: ["community", communityId],
    queryFn: async () => {
      const { data } = await supabase.from("communities").select("*").eq("id", communityId).maybeSingle();
      return data as { id: string; name: string; description: string | null; icon_url: string | null; owner_id: string } | null;
    },
  });

  const { data: channels } = useQuery({
    queryKey: ["channels", communityId],
    queryFn: async () => {
      const { data } = await supabase
        .from("channels")
        .select("*")
        .eq("community_id", communityId)
        .order("position");
      return (data ?? []) as Channel[];
    },
  });

  const { data: members } = useQuery({
    queryKey: ["members", communityId],
    queryFn: async () => {
      const { data } = await supabase
        .from("community_members")
        .select("id, user_id, role")
        .eq("community_id", communityId);
      const rows = (data ?? []) as Member[];
      const { data: profiles } = rows.length
        ? await supabase.from("profiles").select("*").in("id", rows.map((r) => r.user_id))
        : { data: [] };
      const map = Object.fromEntries(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));
      return rows.map((r) => ({ ...r, profile: map[r.user_id] }));
    },
  });

  const myRole = members?.find((m) => m.user_id === user?.id)?.role;
  const isAdmin = myRole === "owner" || myRole === "admin";
  const current = activeChannel ?? channels?.[0]?.id ?? null;
  const currentChannel = channels?.find((c) => c.id === current);

  const createChannel = useMutation({
    mutationFn: async () => {
      const name = newChannel.trim().toLowerCase().replace(/\s+/g, "-");
      if (!name) throw new Error("Channel name required");
      const { error } = await supabase.from("channels").insert({
        community_id: communityId,
        name,
        kind: newChannelKind,
        position: (channels?.length ?? 0) + 1,
      });
      if (error) throw error;
      setNewChannel("");
    },
    onError: (e: Error) => toast.error(e.message),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["channels", communityId] }),
  });

  const setRole = async (memberId: string, role: string) => {
    const { error } = await supabase.from("community_members").update({ role }).eq("id", memberId);
    if (error) toast.error(error.message);
    else {
      toast.success("Role updated");
      void qc.invalidateQueries({ queryKey: ["members", communityId] });
    }
  };

  const removeMember = async (memberId: string) => {
    const { error } = await supabase.from("community_members").delete().eq("id", memberId);
    if (error) toast.error(error.message);
    else void qc.invalidateQueries({ queryKey: ["members", communityId] });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-surface px-3 py-2.5">
          <div className="flex items-center gap-2">
            <JubiAvatar src={community?.icon_url} name={community?.name} square size="sm" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-bold leading-tight">{community?.name ?? "…"}</h1>
              <p className="truncate text-[11px] text-muted-foreground">
                {members?.length ?? 0} members ·{" "}
                {currentChannel
                  ? `${currentChannel.kind === "voice" ? "🔊" : "#"}${currentChannel.name}`
                  : "—"}
              </p>
            </div>
            <Sheet>
              <SheetTrigger aria-label="Members" className="p-2">
                <Users className="h-4 w-4" />
              </SheetTrigger>
              <SheetContent side="right" className="w-[85vw] sm:w-96">
                <SheetHeader>
                  <SheetTitle>Members</SheetTitle>
                </SheetHeader>
                <div className="mt-4 space-y-2 overflow-y-auto px-4 pb-6">
                  {(members ?? []).map((m) => (
                    <div key={m.id} className="flex items-center gap-3 rounded-xl border border-border p-2">
                      <JubiAvatar src={m.profile?.avatar_url} name={m.profile?.username} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{m.profile?.username}</p>
                        <p className="text-[11px] uppercase text-muted-foreground">{m.role}</p>
                      </div>
                      {isAdmin && m.role !== "owner" && (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 rounded-full text-[11px]"
                            onClick={() => void setRole(m.id, m.role === "admin" ? "member" : "admin")}
                          >
                            {m.role === "admin" ? "Demote" : "Promote"}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 rounded-full text-[11px]"
                            onClick={() => void removeMember(m.id)}
                          >
                            Kick
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </SheetContent>
            </Sheet>
            {isAdmin && (
              <Sheet>
                <SheetTrigger aria-label="Channels" className="p-2">
                  <Settings2 className="h-4 w-4" />
                </SheetTrigger>
                <SheetContent side="right" className="w-[85vw] sm:w-96">
                  <SheetHeader>
                    <SheetTitle>Manage channels</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4 space-y-3 px-4">
                    <div className="flex gap-2">
                      {(["text", "voice"] as const).map((k) => (
                        <button
                          key={k}
                          onClick={() => setNewChannelKind(k)}
                          className={cn(
                            "flex-1 rounded-full border px-3 py-1.5 text-xs font-medium capitalize",
                            newChannelKind === k
                              ? "border-transparent bg-primary text-primary-foreground"
                              : "border-border bg-secondary text-secondary-foreground",
                          )}
                        >
                          {k} channel
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={newChannel}
                        onChange={(e) => setNewChannel(e.target.value)}
                        placeholder={newChannelKind === "voice" ? "lounge" : "new-channel"}
                      />
                      <Button
                        className="rounded-full"
                        onClick={() => createChannel.mutate()}
                        disabled={createChannel.isPending}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {(channels ?? []).map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
                        <span className="flex items-center gap-1.5">
                          {c.kind === "voice" ? <Volume2 className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />}
                          {c.name}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px] text-destructive"
                          onClick={async () => {
                            await supabase.from("channels").delete().eq("id", c.id);
                            void qc.invalidateQueries({ queryKey: ["channels", communityId] });
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ))}
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </div>

          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {(channels ?? []).map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveChannel(c.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium",
                  c.id === current
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border bg-secondary text-secondary-foreground",
                )}
              >
                {c.kind === "voice" ? <Volume2 className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
                {c.name}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {current && currentChannel?.kind === "voice" ? (
            <VoiceRoom key={current} channelId={current} channelName={currentChannel.name} />
          ) : current ? (
            <ChatView mode="channel" channelId={current} title={`#${currentChannel?.name ?? ""}`} />
          ) : (
            <p className="p-8 text-center text-sm text-muted-foreground">No channels yet.</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}