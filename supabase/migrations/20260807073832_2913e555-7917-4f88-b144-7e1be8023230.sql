ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';

ALTER TABLE public.channels
  ADD CONSTRAINT channels_kind_check CHECK (kind IN ('text','voice'));