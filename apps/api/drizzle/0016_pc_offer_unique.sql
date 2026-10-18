-- One owned copy per PriceCharting offer. The link import skips offers already
-- in the collection, but two imports confirmed at the same time both pass that
-- check; this index makes the second one's insert a no-op instead.
CREATE UNIQUE INDEX IF NOT EXISTS owned_copies_pc_offer
  ON owned_copies (acquired_url)
  WHERE acquired_source = 'pricecharting_import';
