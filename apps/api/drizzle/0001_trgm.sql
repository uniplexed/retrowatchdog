CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX game_names_name_trgm ON game_names USING gin (name gin_trgm_ops);
CREATE INDEX source_mappings_title_trgm ON source_mappings USING gin (source_title gin_trgm_ops);
