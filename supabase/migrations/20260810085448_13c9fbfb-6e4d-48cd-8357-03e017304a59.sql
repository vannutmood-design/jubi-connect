-- 1. Profile visibility helper
CREATE OR REPLACE FUNCTION public.can_view_profile(_target uuid, _viewer uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _target = _viewer
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE (f.requester_id = _viewer AND f.addressee_id = _target)
         OR (f.requester_id = _target AND f.addressee_id = _viewer)
    )
    OR EXISTS (
      SELECT 1 FROM public.community_members a
      JOIN public.community_members b ON a.community_id = b.community_id
      WHERE a.user_id = _viewer AND b.user_id = _target
    )
    OR EXISTS (
      SELECT 1 FROM public.direct_messages d
      WHERE (d.sender_id = _viewer AND d.recipient_id = _target)
         OR (d.sender_id = _target AND d.recipient_id = _viewer)
    );
$$;

REVOKE ALL ON FUNCTION public.can_view_profile(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (public.can_view_profile(id, auth.uid()));

-- 2. Safe directory search (limited columns only)
CREATE OR REPLACE FUNCTION public.search_profiles(_q text)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url
  FROM public.profiles p
  WHERE auth.uid() IS NOT NULL
    AND p.id <> auth.uid()
    AND length(btrim(coalesce(_q, ''))) >= 2
    AND (p.username ILIKE '%' || btrim(_q) || '%' OR coalesce(p.display_name, '') ILIKE '%' || btrim(_q) || '%')
  ORDER BY p.username
  LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.search_profiles(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_profiles(text) TO authenticated, service_role;

-- 3. Storage: restrict reads in the private 'jubi' bucket
CREATE OR REPLACE FUNCTION public.can_read_jubi_object(_name text, _user uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _user IS NOT NULL
    AND (
      (storage.foldername(_name))[1] = _user::text
      OR (storage.foldername(_name))[2] = 'avatars'
      OR EXISTS (
        SELECT 1 FROM public.direct_messages d
        WHERE d.attachment_url = _name
          AND (d.sender_id = _user OR d.recipient_id = _user)
      )
      OR EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.attachment_url = _name
          AND public.can_access_channel(m.channel_id, _user)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.can_read_jubi_object(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_jubi_object(text, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS jubi_read ON storage.objects;
CREATE POLICY jubi_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'jubi' AND public.can_read_jubi_object(name, auth.uid()));

-- 4. Community bans: allow admins to maintain ban records
DROP POLICY IF EXISTS bans_update ON public.community_bans;
CREATE POLICY bans_update ON public.community_bans
  FOR UPDATE TO authenticated
  USING (public.is_community_admin(community_id, auth.uid()))
  WITH CHECK (public.is_community_admin(community_id, auth.uid()));

-- 5. Lock down SECURITY DEFINER functions
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_community() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.is_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_community_admin(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_channel(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_banned(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_blocked(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_notify(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_community_admin(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_channel(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_banned(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_notify(uuid, uuid) TO authenticated, service_role;