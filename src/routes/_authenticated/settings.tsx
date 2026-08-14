import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { JubiAvatar } from "@/components/JubiAvatar";
import { useAuth } from "@/lib/auth";
import { uploadFile } from "@/lib/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings & profile — JUBI" },
      { name: "description", content: "Update your JUBI avatar, bio, status, privacy preferences and theme." },
      { property: "og:title", content: "Settings & profile — JUBI" },
      { property: "og:description", content: "Update your avatar, bio, status, privacy and theme on JUBI." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [status, setStatus] = useState("online");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [showOnline, setShowOnline] = useState(true);
  const [dmFromAnyone, setDmFromAnyone] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name ?? "");
    setBio(profile.bio ?? "");
    setStatus(profile.status ?? "online");
  }, [profile]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setTheme((data.theme as "light" | "dark") ?? "dark");
        setShowOnline(data.show_online_status ?? true);
        setDmFromAnyone(data.allow_dms_from_anyone ?? true);
      }
    })();
  }, [user]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: displayName.trim() || null, bio: bio.trim() || null, status })
        .eq("id", user.id);
      if (error) throw error;
      const { error: sErr } = await supabase.from("user_settings").upsert(
        {
          user_id: user.id,
          theme,
          show_online_status: showOnline,
          allow_dms_from_anyone: dmFromAnyone,
        },
        { onConflict: "user_id" },
      );
      if (sErr) throw sErr;
      await refreshProfile();
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const onAvatar = async (file: File) => {
    if (!user) return;
    try {
      const path = await uploadFile(user.id, file, "avatars");
      const { error } = await supabase.from("profiles").update({ avatar_url: path }).eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success("Avatar updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    void navigate({ to: "/auth", replace: true });
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-surface px-4 py-3">
          <h1 className="text-xl font-extrabold">Settings</h1>
        </header>

        <div className="no-scrollbar flex-1 space-y-6 overflow-y-auto px-4 py-4">
          <section className="rounded-3xl border border-border bg-card p-4">
            <div className="flex items-center gap-4">
              <JubiAvatar src={profile?.avatar_url} name={profile?.username} size="lg" />
              <div className="min-w-0">
                <p className="truncate font-bold">@{profile?.username}</p>
                <label className="mt-1 inline-block cursor-pointer text-xs font-medium text-brand underline">
                  Change avatar
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onAvatar(f);
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dn">Display name</Label>
                <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bio">Bio</Label>
                <Textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="idle">Idle</SelectItem>
                    <SelectItem value="dnd">Do not disturb</SelectItem>
                    <SelectItem value="offline">Invisible</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-3xl border border-border bg-card p-4">
            <h2 className="text-sm font-bold uppercase text-muted-foreground">Privacy</h2>
            <ToggleRow
              title="Show online status"
              subtitle="Let others see when you're active"
              checked={showOnline}
              onChange={setShowOnline}
            />
            <ToggleRow
              title="Allow DMs from anyone"
              subtitle="Off means friends only"
              checked={dmFromAnyone}
              onChange={setDmFromAnyone}
            />
          </section>

          <section className="space-y-3 rounded-3xl border border-border bg-card p-4">
            <h2 className="text-sm font-bold uppercase text-muted-foreground">Appearance</h2>
            <ToggleRow
              title="Dark theme"
              subtitle="Black canvas with yellow accents"
              checked={theme === "dark"}
              onChange={(v) => setTheme(v ? "dark" : "light")}
            />
          </section>

          <Button className="w-full rounded-full" onClick={() => void save()} disabled={saving}>
            Save changes
          </Button>
          <Button variant="secondary" className="w-full rounded-full" onClick={() => void signOut()}>
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </Button>
        </div>
      </div>
    </AppShell>
  );
}

function ToggleRow({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}