import { existsSync as fileExists } from "node:fs";
if (fileExists(".env")) process.loadEnvFile(".env");

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createIssue } from "./github.ts";

/**
 * members.txt（1行に1人ずつ名前を書いたファイル）を読んで、
 * まだIssueが無い人だけ新しくIssueを作り、players.json を更新するプログラム。
 * 実行: node sim/sync-members.ts
 *
 * 何度実行しても安全。既にいる人には何もしない（Issueを二重に作らない）。
 * シーズンごとに members.txt を書き換えて、これを実行するだけでよい。
 */

const MEMBERS_PATH = "members.txt";
const PLAYERS_PATH = "players.json";

function loadMembers(): string[] {
  const text = readFileSync(MEMBERS_PATH, "utf-8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function loadPlayers(): Record<string, number> {
  return existsSync(PLAYERS_PATH)
    ? JSON.parse(readFileSync(PLAYERS_PATH, "utf-8"))
    : {};
}

async function main() {
  if (!existsSync(MEMBERS_PATH)) {
    console.log(
      `${MEMBERS_PATH} が見つかりません。1行に1人ずつ名前を書いたファイルを、このフォルダに作ってください。`,
    );
    return;
  }

  const names = loadMembers();
  if (names.length === 0) {
    console.log(`${MEMBERS_PATH} に名前が1つも書かれていません。`);
    return;
  }

  const seen = new Set<string>();
  for (const name of names) {
    if (/\s/.test(name)) {
      console.log(`「${name}」にスペースが含まれています。詰めて書くか、ローマ字にしてください。`);
      return;
    }
    if (seen.has(name)) {
      console.log(`「${name}」が2回書かれています。名前は1人1つのユニークなものにしてください。`);
      return;
    }
    seen.add(name);
  }

  const players = loadPlayers();

  let created = 0;
  for (const name of names) {
    if (players[name] !== undefined) continue; // 既にIssueがある人はそのまま
    const issue = await createIssue(
      name,
      `${name} さん専用のIssueです。ここに命令をコメントしてください。書き方は「コメントの書き方.md」を見てください。`,
    );
    players[name] = issue.number;
    created++;
    console.log(`作成しました: ${name} → Issue #${issue.number}`);
  }

  const removed = Object.keys(players).filter((id) => !seen.has(id));
  if (removed.length > 0) {
    console.log(`\n${MEMBERS_PATH} には無いが、players.json には残っている人がいます:`);
    removed.forEach((id) => console.log(`  - ${id}（Issue #${players[id]}）`));
    console.log(
      "自動では消しません。本当に抜けた人なら、players.json から手で削除してください。",
    );
  }

  writeFileSync(PLAYERS_PATH, JSON.stringify(players, null, 2));

  if (created === 0) {
    console.log("新しく作った人はいませんでした（全員すでに登録済みです）。");
  } else {
    console.log(`\n${created}人分、新しくIssueを作りました。players.json を更新しました。`);
  }
}

main();
