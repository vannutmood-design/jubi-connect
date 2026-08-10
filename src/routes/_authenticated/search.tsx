import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Hash, Search as SearchIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth, type Profile } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/lib/media";

export const Route = createFileRoute("/_authenticated/search")({
  head: () => ({
    meta: [
      { title: "Search JUBI — people, communities, messages" },
      {
        name: "description",
        content:
          "Search across your JUBI world: find people by username, discover communities, and jump back to any message you sent or received.",
      },
      { property: "og:title", content: "Search JUBI — people, communities, messages" },
      { property: "og:description", content: "Find people, communities and messages across JUBI." },
    ],
  }),
  component: SearchPage,
});

type CommunityHit = { id: string; name: string; description: string | null; icon_url: string | null };
type DmHit = { id: string; content: string | null; created_at: string; sender_id: string; recipient_id: string };
type MsgHit = { id: string; content: string | null; created_at: string; channel_id: string };

function SearchPage() {
  const { user } = useAuth();
  const [term, setTerm] = useState("");
  const q = term.trim();

  const { data, isFetching } = useQuery({
    queryKey: ["global-search", q, user?.id],
    enabled: q.length >= 2 && !!user,
    queryFn: async () => {
      const like = `%${q}%`;
      const [people, communities, dms, msgs] = await Promise.all([
        supabase.rpc("search_profiles", { _q: q }),
        supabase.from("communities").select("id,name,description,icon_url").ilike("name", like).limit(15),
        supabase
          .from("direct_messages")
          .select("id,content,created_at,sender_id,recipient_id")
          .ilike("content", like)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("messages")
          .select("id,content,created_at,channel_id")
          .ilike("content", like)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      const channelIds = [...new Set(((msgs.data ?? []) as MsgHit[]).map((m) => m.channel_id))];
      const { data: channels } = channelIds.length
        ? await supabase.from("channels").select("id,name,community_id").in("id", channelIds)
        : { data: [] };
      return {
        people: (people.data ?? []) as Profile[],
        communities: (communities.data ?? []) as CommunityHit[],
        dms: (dms.data ?? []) as DmHit[],
        msgs: (msgs.data ?? []) as MsgHit[],
        channels: Object.fromEntries(
          ((channels ?? []) as { id: string; name: string; community_id: string }[]).map((c) => [c.id, c]),
        ),
      };
    },
  });

  const empty =
    !!data &&
    !data.people.length &&
    !data.communities.length &&
    !data.dms.length &&
    !data.msgs.length;

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-surface px-4 py-3">
          <h1 className="text-xl font-extrabold">Search</h1>
          <div className="relative mt-2">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="People, communities, messages…"
              className="rounded-full pl-9"
            />
          </div>
        </header>

        <div className="no-scrollbar flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {q.length < 2 && (
            <p className="pt-10 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search across JUBI.
            </p>
          )}
          {q.length >= 2 && isFetching && !data && (
            <p className="text-center text-sm text-muted-foreground">Searching…</p>
          )}
          {empty && <p className="pt-10 text-center text-sm text-muted-foreground">No results for “{q}”.</p>}

          {!!data?.people.length && (
            <Section title="People">
              {data.people.map((p) => (
                <Link
                  key={p.id}
                  to="/dm/$peerId"
                  params={{ peerId: p.id }}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-secondary"
                >
                  <JubiAvatar src={p.avatar_url} name={p.username} size="sm" status={p.status} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p.display_name || p.username}</p>
                    <p className="truncate text-xs text-muted-foreground">@{p.username}</p>
                  </div>
                </Link>
              ))}
            </Section>
          )}

          {!!data?.communities.length && (
            <Section title="Communities">
              {data.communities.map((c) => (
                <Link
                  key={c.id}
                  to="/c/$communityId"
                  params={{ communityId: c.id }}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-secondary"
                >
                  <JubiAvatar src={c.icon_url} name={c.name} square size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.description ?? "Community"}</p>
                  </div>
                </Link>
              ))}
            </Section>
          )}

          {!!data?.dms.length && (
            <Section title="Direct messages">
              {data.dms.map((m) => (
                <Link
                  key={m.id}
                  to="/dm/$peerId"
                  params={{ peerId: m.sender_id === user?.id ? m.recipient_id : m.sender_id }}
                  className="block rounded-xl px-2 py-2 hover:bg-secondary"
                >
                  <p className="truncate text-sm">{m.content}</p>
                  <p className="text-[10px] text-muted-foreground">{formatTime(m.created_at)}</p>
                </Link>
              ))}
            </Section>
          )}

          {!!data?.msgs.length && (
            <Section title="Channel messages">
              {data.msgs.map((m) => {
                const ch = data.channels[m.channel_id];
                return (
                  <Link
                    key={m.id}
                    to="/c/$communityId"
                    params={{ communityId: ch?.community_id ?? "" }}
                    className="block rounded-xl px-2 py-2 hover:bg-secondary"
                  >
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Hash className="h-3 w-3" />
                      {ch?.name ?? "channel"}
                    </p>
                    <p className="truncate text-sm">{m.content}</p>
                    <p className="text-[10px] text-muted-foreground">{formatTime(m.created_at)}</p>
                  </Link>
                );
              })}
            </Section>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}
