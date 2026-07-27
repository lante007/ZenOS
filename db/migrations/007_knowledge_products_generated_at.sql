-- Store explicit generation timestamp for knowledge products.

ALTER TABLE zenex.knowledge_products
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();
