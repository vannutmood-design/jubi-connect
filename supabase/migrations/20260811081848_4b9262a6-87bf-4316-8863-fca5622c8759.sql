CREATE TABLE public.voice_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('invite','accept','ice','decline','busy','hangup','ack')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_signals TO authenticated;
GRANT ALL ON public.voice_signals TO service_role;
ALTER TABLE public.voice_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_signals_read_participant ON public.voice_signals FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE POLICY voice_signals_create_sender ON public.voice_signals FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND sender_id <> recipient_id
    AND public.can_notify(recipient_id, sender_id)
    AND expires_at <= now() + interval '10 minutes'
  );
CREATE POLICY voice_signals_ack_recipient ON public.voice_signals FOR UPDATE TO authenticated
  USING (auth.uid() = recipient_id)
  WITH CHECK (
    auth.uid() = recipient_id
    AND sender_id = (SELECT v.sender_id FROM public.voice_signals v WHERE v.id = voice_signals.id)
    AND recipient_id = (SELECT v.recipient_id FROM public.voice_signals v WHERE v.id = voice_signals.id)
    AND call_id = (SELECT v.call_id FROM public.voice_signals v WHERE v.id = voice_signals.id)
    AND signal_type = (SELECT v.signal_type FROM public.voice_signals v WHERE v.id = voice_signals.id)
    AND payload = (SELECT v.payload FROM public.voice_signals v WHERE v.id = voice_signals.id)
  );
CREATE POLICY voice_signals_delete_participant ON public.voice_signals FOR DELETE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE INDEX voice_signals_recipient_created_idx ON public.voice_signals (recipient_id, created_at DESC);
CREATE INDEX voice_signals_call_idx ON public.voice_signals (call_id, created_at);
ALTER TABLE public.voice_signals REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_signals;