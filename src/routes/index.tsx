import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "JUBI — Communities, Channels & Chat" },
      {
        name: "description",
        content:
          "JUBI is a mobile-first chat app: build communities, talk in text channels, DM friends and share files in real time.",
      },
      { property: "og:title", content: "JUBI — Communities, Channels & Chat" },
      {
        property: "og:description",
        content: "Build communities, talk in text channels and DM friends in real time.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getUser();
      void navigate({ to: data.user ? "/home" : "/auth", replace: true });
    })();
  }, [navigate]);

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background">
      <div className="flex h-16 w-16 animate-pulse items-center justify-center rounded-3xl bg-brand font-display text-3xl font-extrabold text-brand-foreground">
        J
      </div>
      <h1 className="sr-only">JUBI — Communities, Channels & Chat</h1>
    </main>
  );
}
