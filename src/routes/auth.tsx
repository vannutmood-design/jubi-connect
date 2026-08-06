import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usernameToEmail } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in to JUBI — Communities & Chat" },
      { name: "description", content: "Log in or create your JUBI account to join communities, chat in channels and message friends." },
      { property: "og:title", content: "Sign in to JUBI" },
      { property: "og:description", content: "Join communities, chat in channels and message friends on JUBI." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const handle = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,20}$/.test(handle)) {
      toast.error("Username must be 3-20 characters (letters, numbers, . _ -)");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const email = usernameToEmail(handle);
      if (mode === "register") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: handle } },
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await navigate({ to: "/home" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] flex-col justify-center bg-background px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-brand font-display text-3xl font-extrabold text-brand-foreground">
            J
          </div>
          <h1 className="text-3xl font-extrabold">JUBI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Communities, channels and chat — all in your pocket.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-3xl border border-border bg-card p-5">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              autoCapitalize="none"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="yourname"
              maxLength={20}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <Button type="submit" className="w-full rounded-full" disabled={busy}>
            {mode === "login" ? "Log in" : "Create account"}
          </Button>
          <button
            type="button"
            className="w-full text-center text-xs text-muted-foreground underline"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}
          </button>
        </form>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Username-only accounts. Keep your password safe — there is no email recovery.
        </p>
      </div>
    </main>
  );
}