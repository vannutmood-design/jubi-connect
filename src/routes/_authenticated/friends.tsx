import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageCircle, Search, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth, type Profile } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/friends")({
  head: () => ({
    meta: [
      { title: "Friends & requests — JUBI" },
      { name: "description", content: "Search people, send friend requests, manage your friend list and blocked users on JUBI." },
      { property: "og:title", content: "Friends & requests — JUBI" },
      { property: "og:description", content: "Search people, send friend requests and manage your friend list." },
    ],
  }),
  component: FriendsPage,
});

type Friendship = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
};

function FriendsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [term, setTerm] = useState("");

  const { data } = useQuery({
    queryKey: ["friendships", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("friendships")
        .select("*")
        .or(`requester_id.eq.${user!.id},addressee_id.eq.${user!.id}`);
      const list = (rows ?? []) as Friendship[];
      const ids = [
        ...new Set(list.flatMap((f) => [f.requester_id, f.addressee_id]).filter((id) => id !== user!.id)),
      ];
      const { data: profiles } = ids.length
        ? await supabase.from("profiles").select("*").in("id", ids)
        : { data: [] };
      const map = Object.fromEntries(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));
      return list.map((f) => ({
        ...f,
        peer: map[f.requester_id === user!.id ? f.addressee_id : f.requester_id],
      }));
    },
  });

  const { data: results } = useQuery({
    queryKey: ["search-people", term],
    enabled: term.trim().length >= 2,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("profiles")
        .select("*")
        .ilike("username", `%${term.trim().toLowerCase()}%`)
        .neq("id", user!.id)
        .limit(20);
      return (rows ?? []) as Profile[];
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["friendships", user?.id] });

  const sendRequest = async (peer: Profile): Promise<void> => {
    const { error } = await supabase
      .from("friendships")
      .upsert(
        { requester_id: user!.id, addressee_id: peer.id, status: "pending" },
        { onConflict: "requester_id,addressee_id" },
      );
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("notifications").insert({
      user_id: peer.id,
      type: "friend_request",
      title: "New friend request",
      body: `You have a new friend request`,
      link: "/friends",
    });
    toast.success(`Request sent to @${peer.username}`);
    refresh();
  };

  const setStatus = async (id: string, status: string) => {
    const { error } = await supabase.from("friendships").update({ status }).eq("id", id);
    if (error) toast.error(error.message);
    refresh();
  };

  const remove = async (id: string) => {
    await supabase.from("friendships").delete().eq("id", id);
    refresh();
  };

  const accepted = (data ?? []).filter((f) => f.status === "accepted");
  const incoming = (data ?? []).filter((f) => f.status === "pending" && f.addressee_id === user?.id);
  const outgoing = (data ?? []).filter((f) => f.status === "pending" && f.requester_id === user?.id);
  const blocked = (data ?? []).filter((f) => f.status === "blocked" && f.requester_id === user?.id);

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-surface px-4 py-3">
          <h1 className="text-xl font-extrabold">Friends</h1>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search by username"
              className="rounded-full pl-9"
            />
          </div>
        </header>

        <div className="no-scrollbar flex-1 overflow-y-auto px-4 py-3">
          {term.trim().length >= 2 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-bold uppercase text-muted-foreground">Search results</h2>
              <div className="space-y-2">
                {(results ?? []).map((p) => (
                  <Row key={p.id} profile={p}>
                    <Button size="sm" className="h-8 rounded-full" onClick={() => void sendRequest(p)}>
                      <UserPlus className="mr-1 h-3.5 w-3.5" /> Add
                    </Button>
                  </Row>
                ))}
                {(results ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No one found.</p>
                )}
              </div>
            </section>
          )}

          <Tabs defaultValue="friends">
            <TabsList className="w-full">
              <TabsTrigger value="friends" className="flex-1">
                Friends ({accepted.length})
              </TabsTrigger>
              <TabsTrigger value="requests" className="flex-1">
                Requests ({incoming.length})
              </TabsTrigger>
              <TabsTrigger value="blocked" className="flex-1">
                Blocked
              </TabsTrigger>
            </TabsList>

            <TabsContent value="friends" className="mt-3 space-y-2">
              {accepted.length === 0 && <Empty text="No friends yet — search above." />}
              {accepted.map((f) => (
                <Row key={f.id} profile={f.peer}>
                  <Link to="/dm/$peerId" params={{ peerId: f.peer?.id ?? "" }}>
                    <Button size="sm" variant="secondary" className="h-8 rounded-full">
                      <MessageCircle className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 rounded-full text-destructive"
                    onClick={() => void remove(f.id)}
                  >
                    Remove
                  </Button>
                </Row>
              ))}
            </TabsContent>

            <TabsContent value="requests" className="mt-3 space-y-2">
              {incoming.length === 0 && outgoing.length === 0 && <Empty text="No pending requests." />}
              {incoming.map((f) => (
                <Row key={f.id} profile={f.peer}>
                  <Button size="sm" className="h-8 rounded-full" onClick={() => void setStatus(f.id, "accepted")}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 rounded-full"
                    onClick={() => void remove(f.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </Row>
              ))}
              {outgoing.map((f) => (
                <Row key={f.id} profile={f.peer}>
                  <span className="text-xs text-muted-foreground">Pending</span>
                </Row>
              ))}
            </TabsContent>

            <TabsContent value="blocked" className="mt-3 space-y-2">
              {blocked.length === 0 && <Empty text="No blocked users." />}
              {blocked.map((f) => (
                <Row key={f.id} profile={f.peer}>
                  <Button size="sm" variant="secondary" className="h-8 rounded-full" onClick={() => void remove(f.id)}>
                    Unblock
                  </Button>
                </Row>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </AppShell>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{text}</p>;
}

function Row({ profile, children }: { profile?: Profile | undefined; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-2.5">
      <JubiAvatar src={profile?.avatar_url} name={profile?.username} size="sm" online={profile?.status === "online"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{profile?.display_name || profile?.username}</p>
        <p className="truncate text-[11px] text-muted-foreground">@{profile?.username}</p>
      </div>
      {children}
    </div>
  );
}