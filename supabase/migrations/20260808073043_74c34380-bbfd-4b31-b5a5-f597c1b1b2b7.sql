-- 1. Extensions for search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Block helper
CREATE OR REPLACE FUNCTION public.is_blocked(_a uuid, _b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships f
    WHERE f.status = 'blocked'
      AND ((f.requester_id = _a AND f.addressee_id = _b)
        OR (f.requester_id = _b AND f.addressee_id = _a))
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS dm_insert ON public.direct_messages;
CREATE POLICY dm_insert ON public.direct_messages FOR INSERT TO authenticated
WITH CHECK (sender_id = auth.uid() AND NOT public.is_blocked(sender_id, recipient_id));

DROP POLICY IF EXISTS friendships_insert ON public.friendships;
CREATE POLICY friendships_insert ON public.friendships FOR INSERT TO authenticated
WITH CHECK (
  requester_id = auth.uid() AND addressee_id <> auth.uid()
  AND (status = 'blocked' OR NOT public.is_blocked(requester_id, addressee_id))
);

-- 3. Moderation: bans
CREATE TABLE IF NOT EXISTS public.community_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  banned_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, user_id)
);
GRANT SELECT, INSERT, DELETE ON public.community_bans TO authenticated;
GRANT ALL ON public.community_bans TO service_role;
ALTER TABLE public.community_bans ENABLE ROW LEVEL SECURITY;

CREATE POLICY bans_select ON public.community_bans FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_community_admin(community_id, auth.uid()));
CREATE POLICY bans_insert ON public.community_bans FOR INSERT TO authenticated
WITH CHECK (banned_by = auth.uid() AND public.is_community_admin(community_id, auth.uid()));
CREATE POLICY bans_delete ON public.community_bans FOR DELETE TO authenticated
USING (public.is_community_admin(community_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.is_banned(_community uuid, _user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.community_bans WHERE community_id = _community AND user_id = _user);
$$;
GRANT EXECUTE ON FUNCTION public.is_banned(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS members_join ON public.community_members;
CREATE POLICY members_join ON public.community_members FOR INSERT TO authenticated
WITH CHECK (
  (user_id = auth.uid() OR public.is_community_admin(community_id, auth.uid()))
  AND NOT public.is_banned(community_id, user_id)
);

-- 4. Moderation: admins can delete messages in their community channels
DROP POLICY IF EXISTS messages_delete_own ON public.messages;
CREATE POLICY messages_delete_own ON public.messages FOR DELETE TO authenticated
USING (
  author_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.channels c
    WHERE c.id = messages.channel_id AND public.is_community_admin(c.community_id, auth.uid())
  )
);

-- 5. Notifications: stop cross-user spam
CREATE OR REPLACE FUNCTION public.can_notify(_target uuid, _sender uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _target = _sender
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE ((f.requester_id = _sender AND f.addressee_id = _target)
          OR (f.requester_id = _target AND f.addressee_id = _sender))
        AND f.status <> 'blocked'
    )
    OR EXISTS (
      SELECT 1 FROM public.community_members a
      JOIN public.community_members b ON a.community_id = b.community_id
      WHERE a.user_id = _sender AND b.user_id = _target
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_notify(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS notifications_insert ON public.notifications;
CREATE POLICY notifications_insert ON public.notifications FOR INSERT TO authenticated
WITH CHECK (public.can_notify(user_id, auth.uid()));

-- 6. Indexes
CREATE INDEX IF NOT EXISTS community_members_user_idx ON public.community_members(user_id);
CREATE INDEX IF NOT EXISTS channels_community_idx ON public.channels(community_id, position);
CREATE INDEX IF NOT EXISTS reactions_dm_idx ON public.reactions(dm_id);
CREATE INDEX IF NOT EXISTS friendships_requester_idx ON public.friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON public.friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS profiles_username_trgm ON public.profiles USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_display_trgm ON public.profiles USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS communities_name_trgm ON public.communities USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS messages_content_trgm ON public.messages USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS dm_content_trgm ON public.direct_messages USING gin (content gin_trgm_ops);

-- 7. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
ALTER PUBLICATION supabase_realtime ADD TABLE public.community_members;
ALTER PUBLICATION supabase_realtime ADD TABLE public.channels;
ALTER PUBLICATION supabase_realtime ADD TABLE public.communities;