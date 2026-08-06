
CREATE POLICY "jubi_read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'jubi');
CREATE POLICY "jubi_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'jubi' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "jubi_update_own" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'jubi' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "jubi_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'jubi' AND (storage.foldername(name))[1] = auth.uid()::text);
