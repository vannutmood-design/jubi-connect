import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Bell } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth";
import { formatTime } from "@/lib/media";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — JUBI" },
      { name: "description", content: "Catch up on new messages, mentions and friend requests across your JUBI communities." },
      { property: "og:title", content: "Notifications — JUBI" },
      { property: "og:description", content: "New messages, mentions and friend requests on JUBI." },
    ],
  }),
  component: NotificationsPage,
});

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  created_at: string;
};

function NotificationsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["notifications", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(100);
      return (rows ?? []) as Notification[];
    },
  });

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("notif-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        () => void qc.invalidateQueries({ queryKey: ["notifications", user.id] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, qc]);

  const markAll = async () => {
    await supabase.from("notifications").update({ read: true }).eq("user_id", user!.id).eq("read", false);
    void qc.invalidateQueries({ queryKey: ["notifications", user?.id] });
    void qc.invalidateQueries({ queryKey: ["unread-count", user?.id] });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <h1 className="text-xl font-extrabold">Notifications</h1>
          <Button size="sm" variant="secondary" className="h-8 rounded-full" onClick={() => void markAll()}>
            Mark all read
          </Button>
        </header>
        <div className="no-scrollbar flex-1 overflow-y-auto">
          {(data ?? []).length === 0 && (
            <div className="px-6 py-20 text-center text-muted-foreground">
              <Bell className="mx-auto mb-3 h-8 w-8 opacity-40" />
              <p className="text-sm">You're all caught up.</p>
            </div>
          )}
          {(data ?? []).map((n) => (
            <div
              key={n.id}
              className={`border-b border-border px-4 py-3 ${n.read ? "" : "bg-brand-soft"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">{n.title}</p>
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(n.created_at)}</span>
              </div>
              {n.body && <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p>}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}