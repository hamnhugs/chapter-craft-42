#!/usr/bin/env node
// End-to-end check of a running TTS cache, signed exactly like the app signs:
//   node check.mjs https://tts.yourdomain.com <key-id> <signing-key>
// Stores a tiny test clip, reads it back, deletes it, and prints /v1/stats.

import crypto from "node:crypto";

const [, , base, keyId, key] = process.argv;
if (!base || !keyId || !key) {
  console.error("usage: node check.mjs <cache-url> <key-id> <signing-key>");
  process.exit(2);
}

const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function call(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const sig = crypto.createHmac("sha256", key).update(`${ts}.${method}.${path}.${sha256Hex(raw)}.${nonce}`).digest("hex");
  const res = await fetch(new URL(path, base), {
    method,
    headers: { "Content-Type": "application/json", "X-Key-Id": keyId, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig },
    body: raw || undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const book = "selfcheck";
const clipKey = sha256Hex("chapter-craft tts-cache self-check");
// Smallest valid-looking MP3: an MPEG frame header followed by silence.
const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]).toString("base64");
const timestampInfo = { wordAlignment: { words: ["check"], wordStartTimeSeconds: [0], wordEndTimeSeconds: [0.1] } };

let ok = true;
const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  ${JSON.stringify(detail)}`}`);
  ok &&= cond;
};

const miss = await call("GET", `/v1/clips/${book}/${clipKey}`);
expect("unknown clip is a miss (404)", miss.status === 404, miss);
const put = await call("PUT", `/v1/clips/${book}/${clipKey}`, { audioContent: audio, timestampInfo, voiceId: "check", model: "check", chars: 5 });
expect("store a clip (204)", put.status === 204, put);
const hit = await call("GET", `/v1/clips/${book}/${clipKey}`);
expect("read it back (200, same audio + timestamps)", hit.status === 200 && hit.json?.audioContent === audio && hit.json?.timestampInfo?.wordAlignment?.words?.[0] === "check", hit.status);
const del = await call("DELETE", `/v1/books/${book}`);
expect("delete the book's audio", del.status === 200 && del.json?.clips === 1, del);
const bad = await fetch(new URL(`/v1/clips/${book}/${clipKey}`, base));
expect("unsigned request refused (401)", bad.status === 401, bad.status);
const stats = await call("GET", "/v1/stats");
console.log("stats:", stats.json);
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
