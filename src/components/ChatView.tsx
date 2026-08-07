import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerUpLeft, ImagePlus, SendHorizonal, Smile, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type Profile } from "@/lib/auth";
import { JubiAvatar } from "@/components/JubiAvatar";
import { formatTime, uploadFile, useSignedUrl } from "@/lib/media";
import { Button } from "@/components/ui/button";
import { VoiceRecorder } from "@/components/voice/VoiceRecorder";
import { cn } from "@/lib/utils";

export type ChatMessage = {
  id: string;
  content: string | null;
  attachment_url: string | null;
  attachment_type: string | null;
  reply_to: string | null;
  created_at: string;
  author_id: string;
};

const EMOJIS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

type Props =
  | { mode: "channel"; channelId: string; title: string }
  | { mode: "dm"; peerId: string; title: string };

export function ChatView(props: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = props.mode === "channel" ? props.channelId : props.peerId;
  const queryKey = ["chat", props.mode, key];
  const bottomRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<ChatMessage | null>(null);

  const { data } = useQuery({
    queryKey,
    enabled: !!user && !!key,
    queryFn: async () => {
      const { data: rows, error } =
        props.mode === "channel"
          ? await supabase
              .from("messages")
              .select("*")
              .eq("channel_id", props.channelId)
              .order("created_at", { ascending: true })
              .limit(200)
          : await supabase
              .from("direct_messages")
              .select("*")
              .or(
                `and(sender_id.eq.${user!.id},recipient_id.eq.${props.peerId}),and(sender_id.eq.${props.peerId},recipient_id.eq.${user!.id})`,
              )
              .order("created_at", { ascending: true })
              .limit(200);
      if (error) throw error;
      const messages = ((rows ?? []) as unknown as Record<string, unknown>[]).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row['id'] as string,
          content: (row['content'] as string) ?? null,
          attachment_url: (row['attachment_url'] as string) ?? null,
          attachment_type: (row['attachment_type'] as string) ?? null,
          reply_to: (row['reply_to'] as string) ?? null,
          created_at: row['created_at'] as string,
          author_id: (row['author_id'] ?? row['sender_id']) as string,
        } satisfies ChatMessage;
      });
      const ids = [...new Set(messages.map((m) => m.author_id))];
      const { data: profiles } = ids.length
        ? await supabase.from("profiles").select("*").in("id", ids)
        : { data: [] };
      const reactions =
        props.mode === "channel" && messages.length
          ? (
              await supabase
                .from("reactions")
                .select("*")
                .in(
                  "message_id",
                  messages.map((m) => m.id),
                )
            ).data
          : [];
      return {
        messages,
        profiles: Object.fromEntries(((profiles ?? []) as Profile[]).map((p) => [p.id, p])),
        reactions: (reactions ?? []) as { id: string; message_id: string; user_id: string; emoji: string }[],
      };
    },
  });

  useEffect(() => {
    if (!key) return;
    const table = props.mode === "channel" ? "messages" : "direct_messages";
    const channel = supabase
      .channel(`chat-${props.mode}-${key}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        void qc.invalidateQueries({ queryKey });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, () => {
        void qc.invalidateQueries({ queryKey });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, props.mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages.length]);

  const send = useMutation({
    mutationFn: async ({ text, file }: { text: string; file: File | null }) => {
      let attachment_url: string | null = null;
      let attachment_type: string | null = null;
      if (file) {
        attachment_url = await uploadFile(user!.id, file, "attachments");
        attachment_type = file.type;
      }
      if (props.mode === "channel") {
        const { error } = await supabase.from("messages").insert({
          channel_id: props.channelId,
          author_id: user!.id,
          content: text || null,
          attachment_url,
          attachment_type,
          reply_to: reply?.id ?? null,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("direct_messages").insert({
          sender_id: user!.id,
          recipient_id: props.peerId,
          content: text || null,
          attachment_url,
          attachment_type,
          reply_to: reply?.id ?? null,
        });
        if (error) throw error;
        await supabase.from("notifications").insert({
          user_id: props.peerId,
          type: "message",
          title: "New message",
          body: text.slice(0, 90) || "Sent an attachment",
          link: `/dm/${user!.id}`,
        });
      }
      setReply(null);
    },
    onError: (e: Error) => toast.error(e.message),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
  });

  const react = async (messageId: string, emoji: string) => {
    const existing = data?.reactions.find(
      (r) => r.message_id === messageId && r.user_id === user!.id && r.emoji === emoji,
    );
    if (existing) await supabase.from("reactions").delete().eq("id", existing.id);
    else await supabase.from("reactions").insert({ message_id: messageId, user_id: user!.id, emoji });
    void qc.invalidateQueries({ queryKey });
  };

  const byId = useMemo(
    () => Object.fromEntries((data?.messages ?? []).map((m) => [m.id, m])),
    [data?.messages],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {(data?.messages ?? []).length === 0 && (
          <p className="pt-10 text-center text-sm text-muted-foreground">
            No messages yet. Say hello to {props.title}.
          </p>
        )}
        {(data?.messages ?? []).map((m) => {
          const author = data?.profiles[m.author_id];
          const mine = m.author_id === user?.id;
          const parent = m.reply_to ? byId[m.reply_to] : null;
          const reacts = (data?.reactions ?? []).filter((r) => r.message_id === m.id);
          const grouped = Object.entries(
            reacts.reduce<Record<string, number>>((acc, r) => {
              acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
              return acc;
            }, {}),
          );
          return (
            <div key={m.id} className="group flex gap-3">
              <JubiAvatar src={author?.avatar_url} name={author?.username} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">
                    {author?.display_name || author?.username || "Unknown"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{formatTime(m.created_at)}</span>
                  {mine && <span className="text-[10px] text-muted-foreground">· you</span>}
                </div>
                {parent && (
                  <div className="mt-1 truncate border-l-2 border-brand pl-2 text-xs text-muted-foreground">
                    {data?.profiles[parent.author_id]?.username}: {parent.content}
                  </div>
                )}
                {m.content && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{m.content}</p>}
                {m.attachment_url && <Attachment path={m.attachment_url} type={m.attachment_type} />}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {grouped.map(([emoji, count]) => (
                    <button
                      key={emoji}
                      onClick={() => void react(m.id, emoji)}
                      className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs"
                    >
                      {emoji} {count}
                    </button>
                  ))}
                  <button
                    onClick={() => setReply(m)}
                    className="rounded-full p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Reply"
                  >
                    <CornerUpLeft className="h-3.5 w-3.5" />
                  </button>
                  {props.mode === "channel" && (
                    <details className="relative">
                      <summary className="list-none rounded-full p-1 text-muted-foreground hover:text-foreground">
                        <Smile className="h-3.5 w-3.5" />
                      </summary>
                      <div className="absolute bottom-7 left-0 z-10 flex gap-1 rounded-full border border-border bg-popover p-1 shadow-lg">
                        {EMOJIS.map((e) => (
                          <button key={e} className="px-1 text-base" onClick={() => void react(m.id, e)}>
                            {e}
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <Composer
        reply={reply}
        onCancelReply={() => setReply(null)}
        sending={send.isPending}
        onSend={(text, file) => send.mutate({ text, file })}
      />
    </div>
  );
}

function Attachment({ path, type }: { path: string; type: string | null }) {
  const url = useSignedUrl(path);
  if (!url) return null;
  if (type?.startsWith("image/"))
    return <img src={url} alt="attachment" className="mt-2 max-h-64 rounded-xl border border-border" />;
  if (type?.startsWith("audio/"))
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        className="mt-2 h-10 w-full max-w-[260px]"
        aria-label="Voice message"
      />
    );
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm underline">
      Download attachment
    </a>
  );
}

function Composer({
  onSend,
  sending,
  reply,
  onCancelReply,
}: {
  onSend: (text: string, file: File | null) => void;
  sending: boolean;
  reply: ChatMessage | null;
  onCancelReply: () => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    if (!text.trim() && !file) return;
    onSend(text.trim(), file);
    setText("");
    setFile(null);
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface p-3">
      {reply && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-secondary px-3 py-1.5 text-xs">
          <span className="truncate">Replying to: {reply.content ?? "attachment"}</span>
          <button onClick={onCancelReply} aria-label="Cancel reply">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {file && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-secondary px-3 py-1.5 text-xs">
          <span className="truncate">
            {file.type.startsWith("audio/") ? "🎙️ Voice message ready to send" : file.name}
          </span>
          <button onClick={() => setFile(null)} aria-label="Remove file">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach file"
        >
          <ImagePlus className="h-5 w-5" />
        </Button>
        <VoiceRecorder onRecorded={(f) => setFile(f)} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Message…"
          className={cn(
            "max-h-28 min-h-10 flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-2 text-sm",
            "outline-none focus:ring-2 focus:ring-ring",
          )}
        />
        <Button
          size="icon"
          className="shrink-0 rounded-full"
          disabled={sending}
          onClick={submit}
          aria-label="Send"
        >
          <SendHorizonal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}