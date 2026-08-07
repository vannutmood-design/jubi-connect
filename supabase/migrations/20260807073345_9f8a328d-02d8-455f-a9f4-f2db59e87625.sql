GRANT EXECUTE ON FUNCTION public.is_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_community_admin(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_channel(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_member(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_community_admin(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_access_channel(uuid, uuid) TO service_role;