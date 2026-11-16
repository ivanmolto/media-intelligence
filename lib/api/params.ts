// Request parameters → typed values (spec §4). Every rule is here; a value that
// breaks one throws ParamError (400 `invalid_param`) with a message that names the
// parameter and is written in this file.
//
// - A parameter given twice is rejected: which copy wins would be a guess.
// - An empty value (`q=`) is the same as leaving the parameter out, so a form can
//   submit its empty fields.
// - Unknown parameters are ignored.
// - `sentiment`, `topic`, `bucket` and `group_by` are checked against their lists;
//   `source` and `language` are free values that only ever become `$n` parameters.
import { z } from "zod";
import {
  type Bucket,
  type GroupBy,
  isBucket,
  isGroupBy,
} from "../articles/aggregate";
import type { ArticleFilters } from "../articles/filters";
import { MAX_LIMIT } from "../articles/list";
import { SENTIMENTS, TAXONOMY } from "../enrich/taxonomy";
import { ParamError } from "./errors";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` (UTC midnight) or an ISO time ending in `Z`. */
const instant = z
  .string()
  .refine((text) => DAY.test(text) || INSTANT.test(text))
  .transform((text) => new Date(DAY.test(text) ? text + "T00:00:00Z" : text))
  .refine((date) => !Number.isNaN(date.getTime()));

const RULES = {
  // the search parser owns the query's own limits (length, terms, nesting)
  q: { schema: z.string(), message: "q must be text" },
  source: {
    schema: z.string().max(200),
    message: "source must be at most 200 characters",
  },
  language: {
    schema: z.string().regex(/^[a-z]{2,8}$/),
    message: "language must be a lowercase code such as en, ar or zh",
  },
  sentiment: {
    schema: z.enum(SENTIMENTS),
    message: "sentiment must be one of: " + SENTIMENTS.join(", "),
  },
  topic: {
    schema: z.enum(TAXONOMY),
    message: "topic must be one of: " + TAXONOMY.join(", "),
  },
  from: {
    schema: instant,
    message: "from must be a date (YYYY-MM-DD) or an ISO time ending in Z",
  },
  to: {
    schema: instant,
    message: "to must be a date (YYYY-MM-DD) or an ISO time ending in Z",
  },
  cursor: {
    // what the cursor holds is checked where it is decoded (invalid_cursor)
    schema: z.string().max(512),
    message: "cursor is too long",
  },
  limit: {
    schema: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .refine((n) => n >= 1 && n <= MAX_LIMIT),
    message: `limit must be a whole number from 1 to ${MAX_LIMIT}`,
  },
  bucket: {
    schema: z.string().refine(isBucket),
    message: "bucket must be one of: week, month",
  },
  group_by: {
    schema: z.string().refine(isGroupBy),
    message: "group_by must be one of: sentiment, source, topic",
  },
} as const;

type Name = keyof typeof RULES;
type Value<N extends Name> = z.output<(typeof RULES)[N]["schema"]>;

/** One parameter, validated; undefined when it is absent or empty. */
function read<N extends Name>(
  query: URLSearchParams,
  name: N,
): Value<N> | undefined {
  const values = query.getAll(name);
  if (values.length > 1) {
    throw new ParamError(name + " was given more than once");
  }
  const text = values[0];
  if (text === undefined || text === "") return undefined;
  const parsed = RULES[name].schema.safeParse(text);
  if (!parsed.success) throw new ParamError(RULES[name].message);
  return parsed.data as Value<N>;
}

export type FilterParams = {
  /** the search query as typed; compiled by the caller */
  q?: string;
  filters: Omit<ArticleFilters, "search">;
};

/** The filters the list and the aggregate share. */
export function parseFilters(query: URLSearchParams): FilterParams {
  const from = read(query, "from");
  const toText = query.get("to") ?? "";
  let to = read(query, "to");
  // `to` as a date means "through that day": the filter's bound is exclusive, so
  // it moves to the next midnight. `to` as a time is used as given.
  if (to !== undefined && DAY.test(toText)) {
    to = new Date(to.getTime() + DAY_MS);
  }
  if (from !== undefined && to !== undefined && from >= to) {
    throw new ParamError("from must be before to");
  }
  return {
    q: read(query, "q"),
    filters: {
      source: read(query, "source"),
      language: read(query, "language"),
      sentiment: read(query, "sentiment"),
      topic: read(query, "topic"),
      from,
      to,
    },
  };
}

export function parseListParams(
  query: URLSearchParams,
): FilterParams & { cursor?: string; limit?: number } {
  return {
    ...parseFilters(query),
    cursor: read(query, "cursor"),
    limit: read(query, "limit"),
  };
}

export function parseAggregateParams(
  query: URLSearchParams,
): FilterParams & { bucket?: Bucket; groupBy?: GroupBy } {
  return {
    ...parseFilters(query),
    bucket: read(query, "bucket") as Bucket | undefined,
    groupBy: read(query, "group_by") as GroupBy | undefined,
  };
}
