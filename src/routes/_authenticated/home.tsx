import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth, type Profile } from "@/lib/auth";
import { formatTime } from "@/lib/media";

export const Route = createFileRoute("/_authenticated/home")({
  head: () => ({
    meta: [
      { title: "Your chats — JUBI" },
      { name: "description", content: "All your direct messages and community conversations in one place on JUBI." },
      { property: "og:title", content: "Your chats — JUBI" },
      { property: "og:description", content: "All your direct messages and community conversations in one place." },
    ],
  }),
  component: Home,
});

type DM = {
  id: string;
  sender_id: string;
  recipient_id: string;
  content: string | null;
  created_at: string;
};

function Home() {
  const { user, profile } = useAuth();

  const { data } = useQuery({
    queryKey: ["dm-threads", user?.id],
    enabled: !!user,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("direct_messages")
        .select("id, sender_id, recipient_id, content, created_at")
        .or(`sender_id.eq.${user!.id},recipient_id.eq.${user!.id}`)
        .order("created_at", { ascending: false })
        .limit(200);
      const dms = (rows ?? []) as DM[];
      const threads = new Map<string, DM>();
      for (const m of dms) {
        const peer = m.sender_id === user!.id ? m.recipient_id : m.sender_id;
        if (!threads.has(peer)) threads.set(peer, m);
      }
      const ids = [...threads.keys()];
      const { data: profiles } = ids.length
        ? await supabase.from("profiles").select("*").in("id", ids)
        : { data: [] };
      const map = Object.fromEntries(((profiles ?? []) as Profile[]).map((p) => [p.id, p]));
      return [...threads.entries()].map(([peerId, last]) => ({ peerId, last, peer: map[peerId] }));
    },
  });

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <div>
            <h1 className="text-xl font-extrabold">Chats</h1>
            <p className="text-xs text-muted-foreground">
              Signed in as @{profile?.username ?? "…"}
            </p>
          </div>
          <Link to="/settings">
            <JubiAvatar src={profile?.avatar_url} name={profile?.username} size="sm" online />
          </Link>
        </header>

        <div className="no-scrollbar flex-1 overflow-y-auto">
          {(data ?? []).length === 0 && (
            <div className="px-6 py-16 text-center">
              <p className="text-sm text-muted-foreground">
                No conversations yet. Add a friend to start chatting.
              </p>
              <Link
                to="/friends"
                className="mt-4 inline-block rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
              >
                Find friends
              </Link>
            </div>
          )}
          {(data ?? []).map((t) => (
            <Link
              key={t.peerId}
              to="/dm/$peerId"
              params={{ peerId: t.peerId }}
              className="flex items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
            >
              <JubiAvatar src={t.peer?.avatar_url} name={t.peer?.username} online={t.peer?.status === "online"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">
                    {t.peer?.display_name || t.peer?.username || "Unknown"}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatTime(t.last.created_at)}
                  </span>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {t.last.content ?? "Attachment"}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}