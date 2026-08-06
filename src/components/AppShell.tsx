import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, Compass, MessageCircle, Plus, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { JubiAvatar } from "@/components/JubiAvatar";
import { cn } from "@/lib/utils";

type Community = { id: string; name: string; icon_url: string | null };

export function useMyCommunities() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["my-communities", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<Community[]> => {
      const { data, error } = await supabase
        .from("community_members")
        .select("communities(id, name, icon_url)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? [])
        .map((r) => (r as unknown as { communities: Community | null }).communities)
        .filter(Boolean) as Community[];
    },
  });
}

function useUnreadNotifications() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["unread-notifications", user?.id],
    enabled: !!user,
    refetchInterval: 20000,
    queryFn: async () => {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user!.id)
        .eq("read", false);
      return count ?? 0;
    },
  });
}

const navItems = [
  { to: "/home", icon: MessageCircle, label: "Chats" },
  { to: "/friends", icon: Users, label: "Friends" },
  { to: "/discover", icon: Compass, label: "Discover" },
  { to: "/notifications", icon: Bell, label: "Alerts" },
  { to: "/settings", icon: Settings, label: "You" },
];

export function AppShell({ children, rail = true }: { children: ReactNode; rail?: boolean }) {
  const { data: communities } = useMyCommunities();
  const { data: unread } = useUnreadNotifications();
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      {rail && (
        <nav className="no-scrollbar flex w-[68px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3">
          <Link
            to="/home"
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-2xl font-display text-lg font-bold transition-all",
              path.startsWith("/home") || path.startsWith("/dm")
                ? "bg-brand text-brand-foreground"
                : "bg-white/10 text-rail-foreground hover:bg-brand hover:text-brand-foreground",
            )}
            aria-label="Direct messages"
          >
            J
          </Link>
          <span className="my-1 h-px w-7 bg-white/15" />
          {(communities ?? []).map((c) => (
            <Link
              key={c.id}
              to="/c/$communityId"
              params={{ communityId: c.id }}
              aria-label={c.name}
              className={cn(
                "rounded-2xl ring-brand transition-all",
                path.includes(c.id) && "ring-2",
              )}
            >
              <JubiAvatar src={c.icon_url} name={c.name} square size="md" />
            </Link>
          ))}
          <Link
            to="/discover"
            aria-label="Add community"
            className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 text-rail-foreground transition-colors hover:bg-brand hover:text-brand-foreground"
          >
            <Plus className="h-5 w-5" />
          </Link>
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        <nav className="flex shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
          {navItems.map((item) => {
            const active = path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <item.icon className={cn("h-5 w-5", active && "text-foreground")} />
                {item.label}
                {item.to === "/notifications" && !!unread && (
                  <span className="absolute right-[22%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                    {unread}
                  </span>
                )}
                {active && <span className="absolute -top-px h-0.5 w-8 rounded-full bg-brand" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}