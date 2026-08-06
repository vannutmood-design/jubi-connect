import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export const Route = createFileRoute("/_authenticated/discover")({
  head: () => ({
    meta: [
      { title: "Discover communities — JUBI" },
      { name: "description", content: "Browse public communities, join servers that match your interests, or create your own on JUBI." },
      { property: "og:title", content: "Discover communities — JUBI" },
      { property: "og:description", content: "Browse public communities or create your own on JUBI." },
    ],
  }),
  component: DiscoverPage,
});

type Community = {
  id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  is_public: boolean;
};

function DiscoverPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [term, setTerm] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);

  const { data: communities } = useQuery({
    queryKey: ["public-communities", term],
    queryFn: async () => {
      let q = supabase.from("communities").select("*").eq("is_public", true).limit(50);
      if (term.trim()) q = q.ilike("name", `%${term.trim()}%`);
      const { data } = await q;
      return (data ?? []) as Community[];
    },
  });

  const { data: myIds } = useQuery({
    queryKey: ["my-community-ids", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("community_members")
        .select("community_id")
        .eq("user_id", user!.id);
      return new Set((data ?? []).map((r) => r.community_id as string));
    },
  });

  const join = async (c: Community) => {
    const { error } = await supabase
      .from("community_members")
      .insert({ community_id: c.id, user_id: user!.id, role: "member" });
    if (error) return toast.error(error.message);
    toast.success(`Joined ${c.name}`);
    void qc.invalidateQueries({ queryKey: ["my-communities"] });
    void qc.invalidateQueries({ queryKey: ["my-community-ids", user?.id] });
    void navigate({ to: "/c/$communityId", params: { communityId: c.id } });
  };

  const create = async () => {
    if (!name.trim()) return toast.error("Give your community a name");
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("communities")
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          is_public: isPublic,
          owner_id: user!.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      await supabase
        .from("community_members")
        .insert({ community_id: data.id, user_id: user!.id, role: "owner" });
      await supabase.from("channels").insert({ community_id: data.id, name: "general", position: 1 });
      void qc.invalidateQueries({ queryKey: ["my-communities"] });
      void navigate({ to: "/c/$communityId", params: { communityId: data.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create community");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-surface px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-extrabold">Discover</h1>
            <Sheet>
              <SheetTrigger asChild>
                <Button size="sm" className="h-8 rounded-full">
                  <Plus className="mr-1 h-3.5 w-3.5" /> New
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="rounded-t-3xl">
                <SheetHeader>
                  <SheetTitle>Create a community</SheetTitle>
                </SheetHeader>
                <div className="space-y-4 px-4 pb-8">
                  <div className="space-y-1.5">
                    <Label htmlFor="cname">Name</Label>
                    <Input id="cname" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cdesc">Description</Label>
                    <Textarea
                      id="cdesc"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={300}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-2xl border border-border p-3">
                    <div>
                      <p className="text-sm font-semibold">Public</p>
                      <p className="text-xs text-muted-foreground">Anyone can find and join</p>
                    </div>
                    <Switch checked={isPublic} onCheckedChange={setIsPublic} />
                  </div>
                  <Button className="w-full rounded-full" onClick={() => void create()} disabled={busy}>
                    Create community
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search communities"
              className="rounded-full pl-9"
            />
          </div>
        </header>

        <div className="no-scrollbar flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {(communities ?? []).map((c) => {
            const joined = myIds?.has(c.id);
            return (
              <div key={c.id} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <JubiAvatar src={c.icon_url} name={c.name} square />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {c.description || "No description"}
                  </p>
                </div>
                {joined ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 rounded-full"
                    onClick={() => void navigate({ to: "/c/$communityId", params: { communityId: c.id } })}
                  >
                    Open
                  </Button>
                ) : (
                  <Button size="sm" className="h-8 rounded-full" onClick={() => void join(c)}>
                    Join
                  </Button>
                )}
              </div>
            );
          })}
          {(communities ?? []).length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No public communities yet — create the first one.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}