import { existsSync as fileExists } from "node:fs";
if (fileExists(".env")) process.loadEnvFile(".env");

import { readFileSync, rmSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { bootstrapWorld } from "./worldBootstrap.ts";

/**
 * シーズンを完全にリセットするプログラム。
 * 実行: node sim/reset-season.ts
 *
 * 今の進行状況（game/ フォルダの中身）を消して、新しい地図で0ターン目から作り直す。
 * 取り返しがつかない操作なので、必ず確認をとってから実行する。
 */

const GAME_DIR = process.env.GAME_DIR || "game";
const PLAYERS_PATH = "players.json";

function loadPlayers(): Record<string, number> {
  return JSON.parse(readFileSync(PLAYERS_PATH, "utf-8"));
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim() === "y";
}

async function main() {
  const players = loadPlayers();
  const ids = Object.keys(players);

  if (existsSync(`${GAME_DIR}/state.json`)) {
    const state = JSON.parse(readFileSync(`${GAME_DIR}/state.json`, "utf-8"));
    console.log(`今の進行状況: ${GAME_DIR}/ は ${state.turn}ターン目です。`);
  } else {
    console.log(`${GAME_DIR}/ にはまだ何も保存されていません。`);
  }

  console.log(`このあと ${GAME_DIR}/ の中身を消して、新しい地図で0ターン目から作り直します。`);
  console.log(`参加者${ids.length}人全員のIssueに「世界が始まりました」が新しく投稿されます。`);
  console.log("元には戻せません。");
  const ok = await confirm("本当に実行しますか？ y と入力してEnter: ");
  if (!ok) {
    console.log("やめました。何も変更していません。");
    return;
  }

  if (existsSync(GAME_DIR)) {
    rmSync(GAME_DIR, { recursive: true, force: true });
  }

  // 日付をそのまま種にする。シーズンごとに違う地図になり、
  // いつ始めたシーズンかも数字から分かる。
  const seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));

  await bootstrapWorld(GAME_DIR, players, seed);
  console.log(`新しい世界を作りました（種: ${seed}）。`);
}

main();
