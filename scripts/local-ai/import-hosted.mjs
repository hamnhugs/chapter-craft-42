#!/usr/bin/env node
// Copy YOUR data from the hosted Chapter Craft into the local Supabase.
//
//   node scripts/local-ai/import-hosted.mjs
//
// Reads only what your own login can read on the hosted project (Row Level
// Security applies — this is the same access the app has), and writes it into
// the Supabase running on this machine under your local account. Nothing is
// deleted on either side. Re-running skips rows that already exist.
//
// What you need (asked interactively if not in the environment):
//   HOSTED_TOKEN     access token from the hosted app. The hosted app signs in
//                    with Google, so there is no password to type: open the
//                    hosted app, DevTools → Application → Local Storage →
//                    key "sb-ktzaysdkdkocqhewwtnn-auth-token" → copy the value
//                    of "access_token". It expires in about an hour.
//   LOCAL_EMAIL / LOCAL_PASSWORD   your account on the local app (created if
//                    it doesn't exist; the first local account is admin).
//
// Vectors are NOT copied: they came from cloud embedding models, and mixing
// them with local ones makes every similarity score noise. Every vector
// column is left NULL and re-embedded locally at the end.
//
// Requires scripts/local-up.sh to be running. Secrets are never printed.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_TABLES = new Set([
  "user_roles",          // hosted roles must not grant anything locally
  "activity_events",     // hosted analytics
  "admin_announcements", // hosted operator content
]);

const say = (m) => console.log(`\x1b[1;33m==>\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[1;31mxx\x1b[0m ${m}`); process.exit(1); };

function envFile(p) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, p), "utf8").split("\n")
      .map((l) => /^([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  } catch { return {}; }
}

async function ask(q, { secret = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  const a = (await rl.question(q)).trim();
  rl.close();
  if (secret) process.stdout.write("\n");
  return a;
}

// --- endpoints & credentials ---------------------------------------------------
const hostedEnv = envFile(".env");
const localEnv = envFile(".env.local");
const HOSTED = hostedEnv.VITE_SUPABASE_URL;
const HOSTED_ANON = hostedEnv.VITE_SUPABASE_PUBLISHABLE_KEY;
const LOCAL = localEnv.VITE_SUPABASE_URL;
const LOCAL_ANON = localEnv.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!HOSTED || !HOSTED_ANON) die(".env has no hosted VITE_SUPABASE_URL / key");
if (!LOCAL || !/127\.0\.0\.1|localhost/.test(LOCAL)) die(".env.local doesn't point at a local Supabase — run scripts/local-up.sh first");

let serviceKey = "";
try {
  const out = execFileSync("npx", ["-y", "supabase@2.120.0", "status", "-o", "env"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  serviceKey = (/^(?:SERVICE_ROLE_KEY|SECRET_KEY)="?([^"\n]+)/m.exec(out) || [])[1] || "";
} catch { /* handled below */ }
if (!serviceKey) die("couldn't read the local service key from 'supabase status' — is the local stack running?");

const hostedToken = process.env.HOSTED_TOKEN || await ask("Hosted access_token (see header of this script): ", { secret: true });
const localEmail = process.env.LOCAL_EMAIL || await ask("Local account email: ");
const localPassword = process.env.LOCAL_PASSWORD || await ask("Local account password (6+ chars): ", { secret: true });

const hostedHeaders = { apikey: HOSTED_ANON, Authorization: `Bearer ${hostedToken}` };
const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

async function json(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- who is who ------------------------------------------------------------------
const hostedUser = await json(await fetch(`${HOSTED}/auth/v1/user`, { headers: hostedHeaders }), "hosted login").catch((e) => die(`hosted token rejected (${e.message}). Copy a fresh access_token.`));
const hostedUid = hostedUser.id;

async function localSession() {
  const h = { apikey: LOCAL_ANON, "Content-Type": "application/json" };
  let r = await fetch(`${LOCAL}/auth/v1/token?grant_type=password`, { method: "POST", headers: h, body: JSON.stringify({ email: localEmail, password: localPassword }) });
  if (r.status === 400) {
    say(`creating local account ${localEmail}`);
    await json(await fetch(`${LOCAL}/auth/v1/signup`, { method: "POST", headers: h, body: JSON.stringify({ email: localEmail, password: localPassword }) }), "local signup");
    r = await fetch(`${LOCAL}/auth/v1/token?grant_type=password`, { method: "POST", headers: h, body: JSON.stringify({ email: localEmail, password: localPassword }) });
  }
  return json(r, "local login");
}
const local = await localSession();
const localUid = local.user.id;
say(`hosted user → local user (ids remapped)`);

// --- tables ------------------------------------------------------------------------
const sql = postgres("postgres://postgres:postgres@127.0.0.1:54322/postgres", { max: 1, onnotice: () => {} });
const tables = (await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`).map((r) => r.table_name);
const cols = await sql`
  select table_name, column_name, is_generated, identity_generation, udt_name
  from information_schema.columns where table_schema = 'public'`;
const colsOf = (t) => cols.filter((c) => c.table_name === t);

const remap = (rows) => JSON.parse(JSON.stringify(rows).split(hostedUid).join(localUid));

async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${HOSTED}/rest/v1/${encodeURIComponent(table)}?select=*`, {
      headers: { ...hostedHeaders, Range: `${from}-${from + 999}`, "Range-Unit": "items", Prefer: "count=none" },
    });
    if (r.status === 404 || r.status === 401 || r.status === 403) return null; // not exposed / not ours
    if (!r.ok && r.status !== 206) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const counts = {};
await sql.begin(async (tx) => {
  // Load in any order: FK and user triggers are deferred to the end of the
  // import by running as a replica (the standard bulk-load switch).
  await tx`set local session_replication_role = replica`;
  for (const t of tables) {
    if (SKIP_TABLES.has(t)) continue;
    let rows;
    try { rows = await fetchAll(t); } catch (e) { console.warn(`   skip ${t}: ${e.message}`); continue; }
    if (!rows || rows.length === 0) continue;
    const c = colsOf(t);
    const writable = c.filter((x) => x.is_generated !== "ALWAYS").map((x) => x.column_name);
    const vectorCols = new Set(c.filter((x) => /^(vector|halfvec|sparsevec)$/.test(x.udt_name)).map((x) => x.column_name));
    const data = remap(rows).map((r) => {
      const o = {};
      for (const k of writable) if (k in r) o[k] = vectorCols.has(k) ? null : r[k];
      return o;
    });
    const present = writable.filter((k) => data.some((r) => k in r));
    if (!present.length) continue;
    const overriding = c.some((x) => x.identity_generation === "ALWAYS") ? tx`overriding system value` : tx``;
    const list = tx(present);
    const res = await tx`
      insert into ${tx("public." + t)} (${list}) ${overriding}
      select ${list} from json_populate_recordset(null::${tx("public." + t)}, ${JSON.stringify(data)}::json)
      on conflict do nothing`;
    counts[t] = `${res.count}/${rows.length}`;
  }
});
// Identity sequences must sit past the imported ids.
for (const c of cols.filter((x) => x.identity_generation)) {
  await sql.unsafe(`select setval(pg_get_serial_sequence('public.${c.table_name}', '${c.column_name}'),
    greatest(coalesce((select max(${c.column_name}) from public.${c.table_name}), 1), 1))`).catch(() => {});
}
say("rows imported (new/seen):");
for (const [t, n] of Object.entries(counts)) console.log(`   ${t.padEnd(34)} ${n}`);

// --- storage -----------------------------------------------------------------------
const buckets = (await sql`select id from storage.buckets`).map((r) => r.id);
let files = 0, bytes = 0;
async function listTree(bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await json(await fetch(`${HOSTED}/storage/v1/object/list/${bucket}`, {
      method: "POST", headers: { ...hostedHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset }),
    }), `list ${bucket}/${prefix}`);
    for (const e of page) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) out.push(...await listTree(bucket, p)); else out.push(p);
    }
    if (page.length < 1000) return out;
  }
}
for (const b of buckets) {
  let paths;
  try { paths = await listTree(b, hostedUid); } catch (e) { console.warn(`   skip bucket ${b}: ${e.message}`); continue; }
  for (const p of paths) {
    const dst = localUid + p.slice(hostedUid.length);
    const head = await fetch(`${LOCAL}/storage/v1/object/info/${b}/${dst.split("/").map(encodeURIComponent).join("/")}`, { headers: serviceHeaders });
    if (head.ok) continue;
    const src = await fetch(`${HOSTED}/storage/v1/object/authenticated/${b}/${p.split("/").map(encodeURIComponent).join("/")}`, { headers: hostedHeaders });
    if (!src.ok) { console.warn(`   could not download ${b}/${p}: ${src.status}`); continue; }
    const body = Buffer.from(await src.arrayBuffer());
    const up = await fetch(`${LOCAL}/storage/v1/object/${b}/${dst.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { ...serviceHeaders, "Content-Type": src.headers.get("content-type") || "application/octet-stream", "x-upsert": "true" },
      body,
    });
    if (!up.ok) { console.warn(`   could not upload ${b}/${dst}: ${up.status}`); continue; }
    files++; bytes += body.length;
  }
}
say(`storage: ${files} files, ${(bytes / 2 ** 20).toFixed(1)} MB`);
await sql.end();

// --- re-embed locally -------------------------------------------------------------
const fn = (name, body) => fetch(`${LOCAL}/functions/v1/${name}`, {
  method: "POST",
  headers: { apikey: LOCAL_ANON, Authorization: `Bearer ${local.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));

say("re-embedding memories with the local model (this can take a while)");
for (let i = 0; i < 200; i++) {
  const r = await fn("knowledge-embed", { all_missing: true });
  const n = Number(r.body?.updated ?? r.body?.embedded ?? 0);
  if (!r.ok) { console.warn(`   knowledge-embed: ${JSON.stringify(r.body).slice(0, 200)}`); break; }
  if (!n) break;
  process.stdout.write(`   +${n}`);
}
for (let i = 0; i < 200; i++) {
  const r = await fn("embed-entries", { backfill: true, limit: 200 });
  const n = Number(r.body?.embedded ?? r.body?.count ?? 0);
  if (!r.ok || !n) break;
  process.stdout.write(`   v2 +${n}`);
}
await fn("recompute-centroids", {}).catch(() => {});
console.log();
say("done. Open http://127.0.0.1:8080 and sign in with your local account.");
