-- Pipeline sort — cards keep a hand-ordered position inside their stage
-- column. Backfill preserves the order the board showed before (newest
-- activity first).

ALTER TABLE pipeline_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE pipeline_cards SET sort_order = (
  SELECT pos FROM (
    SELECT id, row_number() OVER (PARTITION BY org_id, stage ORDER BY updated_at DESC) - 1 AS pos
      FROM pipeline_cards
  ) ranked WHERE ranked.id = pipeline_cards.id
);
