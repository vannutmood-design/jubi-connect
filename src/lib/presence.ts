import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

const HEARTBEAT_MS = 60_000;
const AWAY_AFTER_MS = 3 * 60_000;

async function push(userId: string, status: string) {
  await supabase
    .from("profiles")
    .update({ status, last_seen: new Date().toISOString() })
    .eq("id", userId);
}

/** Keeps profiles.status / last_seen fresh: online, away when idle, offline on leave. */
export function usePresence(userId: string | undefined) {
  useEffect(() => {
    if (!userId || typeof window === "undefined") return;
    let lastActive = Date.now();
    let current = "";

    const sync = () => {
      const hidden = document.visibilityState === "hidden";
      const next = hidden || Date.now() - lastActive > AWAY_AFTER_MS ? "idle" : "online";
      if (next !== current) {
        current = next;
        void push(userId, next);
      } else {
        void push(userId, next);
      }
    };

    const activity = () => {
      lastActive = Date.now();
      if (current !== "online" && document.visibilityState === "visible") sync();
    };

    sync();
    const timer = window.setInterval(sync, HEARTBEAT_MS);
    const events = ["pointerdown", "keydown", "focus", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    document.addEventListener("visibilitychange", sync);

    const leave = () => {
      void push(userId, "offline");
    };
    window.addEventListener("pagehide", leave);

    return () => {
      window.clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, activity));
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [userId]);
}
