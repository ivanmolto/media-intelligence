// npm run search:debug -- '<query>'   (deviation 4)
//
// Prints, for one query: the AST, the leaves that are empty under each config, both
// compiled fragments with their parameter arrays, and the matching ids with the
// warnings, or the error code. It holds no search logic: everything comes from
// lib/search/. The `search-check` skill reads this output to check precedence and
// that no user text reaches the SQL string.
//
// Exit codes: 0 for a result or `invalid_query` (both are answers), 1 otherwise.
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { formatAst } from "../lib/search/ast";
import { CONFIGS, prepareSearch, searchIds } from "../lib/search/compile";
import { InvalidQueryError } from "../lib/search/parser";

async function main(): Promise<number> {
  const query = process.argv[2];
  if (query === undefined || process.argv.length > 3) {
    console.error("usage: npm run search:debug -- '<query>'");
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log("query:    " + query);
    const { debug } = await prepareSearch(client, query);
    console.log("ast:      " + formatAst(debug.ast));
    for (const config of CONFIGS) {
      console.log(
        `empty under ${config}: ` + JSON.stringify(debug.emptyLeaves[config]),
      );
    }
    for (const config of CONFIGS) {
      console.log(`${config} fragment:`);
      console.log("  sql:    " + debug.fragments[config].sql);
      console.log(
        "  params: " + JSON.stringify(debug.fragments[config].params),
      );
    }
    const { ids, warnings } = await searchIds(client, query);
    console.log("ids:      " + JSON.stringify(ids));
    console.log("warnings: " + JSON.stringify(warnings));
    return 0;
  } catch (error) {
    if (error instanceof InvalidQueryError) {
      console.log(`error:    ${error.code} — ${error.message}`);
      return 0;
    }
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
