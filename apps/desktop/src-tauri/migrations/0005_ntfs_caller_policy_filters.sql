ALTER TABLE ntfs_caller_policies ADD COLUMN excluded_roots_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ntfs_caller_policies ADD COLUMN file_categories_json TEXT NOT NULL DEFAULT '["documents","sourceCode"]';
