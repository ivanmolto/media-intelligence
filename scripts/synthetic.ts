// npm run db:synthetic [-- --rows=N] — fills the synthetic database with generated
// articles and matching enrichment rows, for the scale evidence (spec §1; deviation 6).
//
// - Only ever the database named `media_synthetic`, reached through
//   SYNTHETIC_DATABASE_URL. DATABASE_URL is not read: the app database keeps its 20.
// - No provider is called. Enrichment rows are written directly under the active
//   run key, so the join the API uses finds them.
// - Deterministic: article n is generated from n alone, so a re-run inserts 0 rows.
//
// The text is not news. Words are drawn evenly from short lists, and the terms the
// queries in scripts/explain-queries.json search for are added at the RATES below.
// Those rates are choices made here, not measured from a corpus; they set how
// selective each query is, and with it what the planner picks.
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { RunKey } from "../lib/articles/filters";
import type { Queryable } from "../lib/db";
import { activeRunKey } from "../lib/enrich/provider";
import { SENTIMENTS, TAXONOMY } from "../lib/enrich/taxonomy";
import { migrate } from "./migrate";
import { seed, type SourceArticle } from "./seed";

export const SYNTHETIC_DATABASE = "media_synthetic";
export const DEFAULT_ROWS = 200_000;
const BATCH = 5_000;

/** The one place the synthetic database URL is resolved; also used by db:explain. */
export function syntheticDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.SYNTHETIC_DATABASE_URL;
  if (!url) {
    throw new Error(
      `SYNTHETIC_DATABASE_URL is not set. It must name the database "${SYNTHETIC_DATABASE}".`,
    );
  }
  const name = new URL(url).pathname.slice(1);
  if (name !== SYNTHETIC_DATABASE) {
    throw new Error(
      `SYNTHETIC_DATABASE_URL must name the database "${SYNTHETIC_DATABASE}", not "${name}". Refusing to run.`,
    );
  }
  return url;
}

/** Share of articles that get each term. Independent of each other. */
export const RATES = {
  renewable: 0.02,
  nuclear: 0.015,
  coal: 0.015,
  "oil prices": 0.01,
  // the two words apart, so the phrase is not the same set as `oil AND prices`
  oil: 0.03,
  prices: 0.03,
} as const;

const LANGUAGES = [
  { code: "en", share: 0.8 },
  { code: "ar", share: 0.1 },
  { code: "zh", share: 0.1 },
] as const;

const SENTIMENT_SHARES = [0.25, 0.25, 0.4, 0.1]; // in SENTIMENTS order

export const SOURCES = Array.from(
  { length: 12 },
  (_, i) => "Synthetic Wire " + String(i + 1).padStart(2, "0"),
);

// 24 months, UTC.
const FIRST_DAY = Date.UTC(2024, 6, 1);
const LAST_DAY = Date.UTC(2026, 6, 1);

// None of these is a search term of the queries file or shares a stem with one.
const WORDS: Record<string, string[]> = {
  en: (
    "government minister report market company bank trade growth policy city " +
    "region council election court judge school hospital doctor patient study " +
    "research university student teacher transport railway airport road bridge " +
    "housing budget tax spending inflation wage worker union factory export " +
    "import harvest farmer weather storm flood drought river forest island " +
    "football match league season coach player stadium festival film music " +
    "museum library software network device chip satellite launch mission " +
    "security police border treaty summit talks agreement dispute protest " +
    "strike reform law bill vote parliament president mayor spokesperson " +
    "analyst investor shares profit revenue merger startup founder customer " +
    "supply demand shipment port cargo vessel pipeline grid turbine battery " +
    "vehicle traffic tourism hotel visitor heritage tradition community family " +
    "children health vaccine clinic outbreak recovery warning forecast record " +
    "announced confirmed expected following according officials said week " +
    "month year quarter million billion percent higher lower steady early late"
  ).split(" "),
  ar: (
    "الحكومة الوزير تقرير السوق شركة بنك تجارة نمو سياسة مدينة منطقة مجلس " +
    "انتخابات محكمة مدرسة مستشفى طبيب دراسة جامعة طالب نقل مطار طريق جسر " +
    "ميزانية ضريبة تضخم عامل مصنع تصدير طقس عاصفة نهر مباراة موسم مهرجان"
  ).split(" "),
  // Space-separated here, which real Chinese is not: `simple` splits on whitespace
  // only, so unsegmented text would be one lexeme per sentence (spec §2, limits).
  zh: (
    "政府 部长 报告 市场 公司 银行 贸易 增长 政策 城市 地区 议会 选举 法院 学校 " +
    "医院 医生 研究 大学 学生 交通 机场 道路 桥梁 预算 税收 通胀 工人 工厂 出口 " +
    "天气 风暴 河流 比赛 赛季 节日"
  ).split(" "),
};

/** mulberry32: a small seeded generator, so article n is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function pickByShare(random: () => number, shares: readonly number[]): number {
  let left = random();
  for (let i = 0; i < shares.length; i++) {
    left -= shares[i] as number;
    if (left < 0) return i;
  }
  return shares.length - 1;
}

export type SyntheticArticle = {
  article: SourceArticle;
  sentiment: string;
  tags: string[];
};

/** Article number n (1-based; it becomes external_id), generated from n alone. */
export function generateArticle(n: number): SyntheticArticle {
  const random = prng(n);
  const language = (
    LANGUAGES[
      pickByShare(
        random,
        LANGUAGES.map((l) => l.share),
      )
    ] as (typeof LANGUAGES)[number]
  ).code;
  const vocabulary = WORDS[language] as string[];

  const words = (count: number): string[] =>
    Array.from({ length: count }, () => pick(random, vocabulary));
  const headline = words(6 + Math.floor(random() * 5));
  const body = words(60 + Math.floor(random() * 61));
  // Each term goes in at a random position, as one unit, so a phrase stays adjacent.
  for (const [term, rate] of Object.entries(RATES)) {
    if (random() < rate) {
      body.splice(Math.floor(random() * (body.length + 1)), 0, term);
    }
  }

  // Skewed towards the first sources, so their selectivity differs.
  const source = SOURCES[Math.floor(random() ** 2 * SOURCES.length)] as string;
  const publishedAt = new Date(
    FIRST_DAY + Math.floor(random() * (LAST_DAY - FIRST_DAY)),
  );

  const sentiment = SENTIMENTS[pickByShare(random, SENTIMENT_SHARES)] as string;
  const tags = new Set<string>();
  const tagCount = 1 + Math.floor(random() * 3);
  while (tags.size < tagCount) tags.add(pick(random, TAXONOMY));

  return {
    article: {
      id: n,
      headline: headline.join(" "),
      body: body.join(" "),
      source,
      published_at: publishedAt.toISOString(),
      language,
    },
    sentiment,
    tags: [...tags],
  };
}

/**
 * Enrichment rows for a batch, written directly: `done`, with no tokens, cost,
 * latency or attempts, because no call was made. `model` and `provider` say so.
 */
async function insertEnrichments(
  db: Queryable,
  key: RunKey,
  batch: SyntheticArticle[],
): Promise<number> {
  const result = await db.query(
    `INSERT INTO article_enrichments
       (article_id, requested_model, prompt_version, taxonomy_version, content_hash,
        status, summary, sentiment, tags, model, provider, updated_at)
     SELECT a.id, $1, $2, $3, a.content_hash,
            'done', 'Synthetic row: no model produced this text.', s.sentiment,
            string_to_array(s.tags, ','), 'synthetic', 'synthetic', now()
       FROM unnest($4::int[], $5::text[], $6::text[]) AS s(external_id, sentiment, tags)
       JOIN articles a ON a.external_id = s.external_id
     ON CONFLICT DO NOTHING`,
    [
      key.requestedModel,
      key.promptVersion,
      key.taxonomyVersion,
      batch.map((row) => row.article.id),
      batch.map((row) => row.sentiment),
      batch.map((row) => row.tags.join(",")),
    ],
  );
  return result.rowCount ?? 0;
}

async function createDatabaseIfMissing(url: string): Promise<void> {
  // CREATE DATABASE cannot run inside the database it creates.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [SYNTHETIC_DATABASE],
    );
    if (found.rowCount === 0) {
      // The name is the constant above; CREATE DATABASE takes no parameter.
      await client.query("CREATE DATABASE media_synthetic");
      console.log(`synthetic: created database ${SYNTHETIC_DATABASE}`);
    }
  } finally {
    await client.end();
  }
}

function rowsArgument(args: string[]): number {
  const given = args.find((arg) => arg.startsWith("--rows="));
  if (given === undefined) return DEFAULT_ROWS;
  const rows = Number(given.slice("--rows=".length));
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error("--rows must be a whole number, 1 or more");
  }
  return rows;
}

async function main(): Promise<void> {
  const url = syntheticDatabaseUrl();
  const rows = rowsArgument(process.argv.slice(2));
  const key = activeRunKey();

  await createDatabaseIfMissing(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client);
    let articles = 0;
    let enrichments = 0;
    for (let first = 1; first <= rows; first += BATCH) {
      const batch: SyntheticArticle[] = [];
      for (let n = first; n < first + BATCH && n <= rows; n++) {
        batch.push(generateArticle(n));
      }
      articles += await seed(
        client,
        batch.map((row) => row.article),
      );
      enrichments += await insertEnrichments(client, key, batch);
    }
    await client.query("VACUUM (ANALYZE) articles");
    await client.query("VACUUM (ANALYZE) article_enrichments");
    const total = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM articles",
    );
    console.log(
      `synthetic: inserted ${articles} articles and ${enrichments} enrichment rows ` +
        `(run key ${key.requestedModel} / ${key.promptVersion} / ${key.taxonomyVersion}); ` +
        `articles now holds ${total.rows[0]?.count}`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
