-- Every price point carries the source product id its row came from, so the
-- stale-point invalidation keys on THAT instead of on the shape of a stored
-- URL. Spec 4.10 of the plugin standard.
--
-- Nullable, and null is a real answer: an aggregate (the app's own median) is
-- about no single product, and nothing may invent one for it.
ALTER TABLE price_points ADD COLUMN IF NOT EXISTS source_product_id text;

-- Backfill from the two URL shapes the old family switch understood, so the
-- re-keying loses no existing row. This is the LAST place those two patterns
-- appear: they are a one-time reading of history, not a rule the app keeps.
--
--   CeX  — the link is built from the box id: .../product-detail?id=<box>
--   eBay — the seller's own link, whose only stable part is /itm/<legacy id>,
--          matched back to the mapping whose id is v1|<legacy>|<variation>
UPDATE price_points pp
SET source_product_id = sm.source_product_id
FROM source_mappings sm
WHERE pp.source_product_id IS NULL
  AND sm.source = pp.source
  AND sm.game_id = pp.game_id
  AND pp.source_url IS NOT NULL
  AND (
    pp.source_url LIKE '%/product-detail?id=' || sm.source_product_id
    OR (
      split_part(sm.source_product_id, '|', 2) <> ''
      AND pp.source_url LIKE '%/itm/' || split_part(sm.source_product_id, '|', 2) || '%'
    )
  );

-- The sweep joins price_points to source_mappings on (source, game_id,
-- source_product_id); the existing price_points_lookup index does not cover
-- the last one.
CREATE INDEX IF NOT EXISTS price_points_product
  ON price_points (source, source_product_id);
