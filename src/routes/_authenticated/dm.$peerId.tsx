import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Ban } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/ChatView";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth, type Profile } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/dm/$peerId")({
  head: () => ({
    meta: [
      { title: "Direct message — JUBI" },
      { name: "description", content: "Private one-to-one conversation with images, files, replies and reactions on JUBI." },
      { property: "og:title", content: "Direct message — JUBI" },
      { property: "og:description", content: "Private one-to-one conversation on JUBI." },
    ],
  }),
  component: DMPage,
});

function DMPage() {
  const { peerId } = useParams({ from: "/_authenticated/dm/$peerId" });
  const { user } = useAuth();

  const { data: peer } = useQuery({
    queryKey: ["profile", peerId],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", peerId).maybeSingle();
      return (data as Profile) ?? null;
    },
  });

  const block = async () => {
    if (!user) return;
    const { error } = await supabase
      .from("friendships")
      .upsert(
        { requester_id: user.id, addressee_id: peerId, status: "blocked" },
        { onConflict: "requester_id,addressee_id" },
      );
    if (error) toast.error(error.message);
    else toast.success("User blocked");
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-3 py-2.5">
          <Link to="/home" aria-label="Back" className="p-1">
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <JubiAvatar src={peer?.avatar_url} name={peer?.username} size="sm" online={peer?.status === "online"} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold leading-tight">
              {peer?.display_name || peer?.username || "Loading…"}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">@{peer?.username}</p>
          </div>
          <button onClick={block} aria-label="Block user" className="p-2 text-muted-foreground">
            <Ban className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <ChatView mode="dm" peerId={peerId} title={peer?.username ?? "them"} />
        </div>
      </div>
    </AppShell>
  );
}