DROP POLICY IF EXISTS voice_signals_create_sender ON public.voice_signals;
CREATE POLICY voice_signals_create_sender ON public.voice_signals FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND sender_id <> recipient_id
    AND NOT public.is_blocked(sender_id, recipient_id)
    AND (
      public.can_notify(recipient_id, sender_id)
      OR EXISTS (
        SELECT 1 FROM public.direct_messages d
        WHERE (d.sender_id = sender_id AND d.recipient_id = recipient_id)
           OR (d.sender_id = recipient_id AND d.recipient_id = sender_id)
      )
    )
    AND expires_at <= now() + interval '10 minutes'
  );