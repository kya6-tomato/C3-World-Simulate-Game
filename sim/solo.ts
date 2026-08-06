import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { resolveTurn } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { Rng } from "../src/rng.ts";
import { validateCommands, parseCommandsJson } from "./commandInput.ts";
import { decide } from "./bots.ts";
import type { BotKind } from "./bots.ts";
import type { World, Command } from "../src/types.ts";

/**
 * 自分1人 + ボット4人で試し打ちするための道具。
 * 実行: node sim/solo.ts
 *
 * 本番（out/、sim/step.ts）とは完全に別の out_solo/ に保存するので、
 * 練習で本番を壊す心配はない。地図の大きさなどは本番と同じ設定（30人向け）を
 * そのまま使うので、5人にしては土地が広すぎてバランスは本番と一致しない。
 * あくまで「遊び方に慣れる」ための練習用。
 */

const ME = "p00";
const ROSTER: Record<string, BotKind> = {
  p00: "trader", // 自分。ボットの型は使われないが値は必要
  p01: "trader",
  p02: "trader",
  p03: "loner",
  p04: "betrayer",
};
const BOT_IDS = Object.keys(ROSTER).filter((id) => id !== ME);

const STATE_PATH = "out_solo/state.json";
const COMMANDS_PATH = "commands_solo.json";
const HISTORY_PATH = "out_solo/history.json";
const MAP_PATH = "out_solo/map.svg";
const SEED = CONFIG.simSeed + 1000; // 本番の地図と混同しないよう別の種にする

function main() {
  mkdirSync("out_solo", { recursive: true });

  if (!existsSync(STATE_PATH)) {
    const world = createWorld(Object.keys(ROSTER), SEED);
    writeFileSync(STATE_PATH, JSON.stringify(world, null, 2));
    writeFileSync(MAP_PATH, renderMapSvg(world));
    writeFileSync(
      HISTORY_PATH,
      JSON.stringify([{ turn: world.turn, log: world.log }], null, 2),
    );
    console.log("練習用の世界を作りました（0ターン目）。あなたは p00 です。");
    console.log(
      `${COMMANDS_PATH} に自分（p00）の命令を書いてから、もう一度 node sim/solo.ts を実行してください。`,
    );
    console.log(`他の4人（p01〜p04）はボットが自動で動きます。`);
    console.log(`書き方の見本は commands_書き方.md を見てください（type/資源名の書き方は同じです）。`);
    return;
  }

  const world: World = JSON.parse(readFileSync(STATE_PATH, "utf-8"));

  let rawCommands: unknown = [];
  if (existsSync(COMMANDS_PATH)) {
    try {
      rawCommands = parseCommandsJson(readFileSync(COMMANDS_PATH, "utf-8"));
    } catch {
      console.log(`\n${COMMANDS_PATH} がJSONとして読めませんでした。`);
      console.log(`世界はまだ進めていません。よくある原因:`);
      console.log(`  - { や [ の数が合っていない`);
      console.log(`  - 文字列を " で囲み忘れている`);
      console.log(`  - 最後の項目のあとに余計な , が付いている`);
      process.exitCode = 1;
      return;
    }
  }

  const { ok, errors } = validateCommands(world, rawCommands, COMMANDS_PATH);
  if (errors.length > 0) {
    console.log(`\n${COMMANDS_PATH} に直したほうがいい点があります。`);
    console.log(`世界はまだ進めていません（安全のため、直るまで待ちます）。\n`);
    errors.forEach((e) => console.log(`  - ${e}`));
    process.exitCode = 1;
    return;
  }

  // 自分（p00）以外の命令が紛れ込んでいたら無視する。ボット側と重複させないため。
  const myCommands = ok.filter((c) => c.player === ME);
  const ignored = ok.length - myCommands.length;
  if (ignored > 0) {
    console.log(`（${ME} 以外の命令が${ignored}件書かれていたので無視しました）`);
  }

  const rng = new Rng(SEED + world.turn * 7919);
  const botCommands: Command[] = BOT_IDS.flatMap((id) =>
    decide(world, id, ROSTER[id], rng),
  );

  const next = resolveTurn(world, [...myCommands, ...botCommands]);

  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  writeFileSync(MAP_PATH, renderMapSvg(next));

  const history = existsSync(HISTORY_PATH)
    ? JSON.parse(readFileSync(HISTORY_PATH, "utf-8"))
    : [];
  history.push({ turn: next.turn, log: next.log });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  writeFileSync(COMMANDS_PATH, "[]\n");

  console.log(`\n=== ${next.turn}ターン目まで進みました ===\n`);
  next.log.forEach((l) => console.log(`  ${l}`));
  console.log(`\n${COMMANDS_PATH} を空にしました。次のターンの命令（p00）を書いてください。`);
}

main();
