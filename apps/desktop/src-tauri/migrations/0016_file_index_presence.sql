ALTER TABLE file_records ADD COLUMN present_in_index INTEGER NOT NULL DEFAULT 1 CHECK (present_in_index IN (0, 1));
