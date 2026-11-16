-- 001_init — the three tables and the indexes of docs/spec.md §1,
-- plus article_enrichments.attempts (docs/deviations.md row 7) and
-- articles.headline_text (row 15).

CREATE TABLE articles (
  id            bigserial PRIMARY KEY,
  external_id   int UNIQUE,                -- the brief's id
  headline      text,                      -- raw, as received; may be '' (article 17)
  headline_text text NOT NULL,             -- HTML stripped, like body_text. Postgres indexes the
                                           -- words inside a tag (img, onerror, …), so the raw
                                           -- headline must not reach to_tsvector
  body          text NOT NULL,             -- raw, unsanitised; the source is evidence
  body_text     text NOT NULL,             -- HTML stripped; used for search and the LLM.
                                           -- NOT NULL: a null here would make tsv null and
                                           -- the article silently unsearchable
  source        text NOT NULL,
  language      text NOT NULL,             -- 'en' | 'ar' | 'zh' | …
  published_at  timestamptz NOT NULL,
  content_hash  bytea NOT NULL,            -- sha256(normalised headline_text + body_text)
  -- The config is a constant in each branch: a config chosen by an expression is
  -- not immutable and a generated column rejects it.
  tsv           tsvector GENERATED ALWAYS AS (
                  CASE WHEN language = 'en'
                    THEN to_tsvector('english', headline_text || ' ' || body_text)
                    ELSE to_tsvector('simple',  headline_text || ' ' || body_text)
                  END) STORED
);

-- One row per article per run key (requested_model, prompt_version, taxonomy_version):
-- two models over the same articles are two sets of rows.
CREATE TABLE article_enrichments (
  article_id        bigint REFERENCES articles (id),
  requested_model   text,                  -- 'mock', or the model id asked for
  prompt_version    text,
  taxonomy_version  text,
  content_hash      bytea,                 -- the article's hash when this row was produced
  status            text CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  claimed_at        timestamptz,
  summary           text,
  sentiment         text CHECK (sentiment IN ('positive', 'negative', 'neutral', 'mixed')),
  tags              text[],                -- 1..3 ids from the taxonomy
  model             text,                  -- as reported in the provider response
  provider          text,                  -- as reported in the provider response
  input_tokens      int,
  output_tokens     int,
  latency_ms        int,
  cost_usd          numeric(10, 6),
  attempts          int,                   -- provider calls made: 1, or 2 after the retry; null while pending
  error             text,
  updated_at        timestamptz,
  PRIMARY KEY (article_id, requested_model, prompt_version, taxonomy_version)
);

CREATE TABLE enrichment_budget (
  day          date PRIMARY KEY,           -- UTC
  tokens_used  bigint NOT NULL DEFAULT 0
);

-- Keyset pagination: the list's ORDER BY, with id as the tiebreak.
CREATE INDEX articles_published_idx
  ON articles (published_at DESC, id DESC);

-- Source filter: equality column first, then the keyset order and its tiebreak.
CREATE INDEX articles_source_published_idx
  ON articles (source, published_at DESC, id DESC);

-- Language filter: same shape as the source index.
CREATE INDEX articles_language_published_idx
  ON articles (language, published_at DESC, id DESC);

-- Boolean search: every leaf is `tsv @@ <tsquery>`.
CREATE INDEX articles_tsv_idx
  ON articles USING gin (tsv);

-- Topic filter: `tags @> ARRAY[topic]`.
CREATE INDEX article_enrichments_tags_idx
  ON article_enrichments USING gin (tags);

-- Dedup lookup before a provider call; partial, because only finished rows can be copied.
CREATE INDEX article_enrichments_dedup_idx
  ON article_enrichments (content_hash, requested_model, prompt_version, taxonomy_version)
  WHERE status = 'done';
