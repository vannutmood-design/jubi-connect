DROP POLICY IF EXISTS voice_signals_ack_recipient ON public.voice_signals;
REVOKE UPDATE ON public.voice_signals FROM authenticated;
GRANT UPDATE (acknowledged_at) ON public.voice_signals TO authenticated;
CREATE POLICY voice_signals_ack_recipient ON public.voice_signals FOR UPDATE TO authenticated
  USING (auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = recipient_id);