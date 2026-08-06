import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { resolveTurn } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { validateCommands } from "./commandInput.ts";
import type { World } from "../src/types.ts";

/**
 * 命令を手で書いて、世界を1ターンだけ進めるプログラム。
 * 実行: node sim/step.ts
 *
 * sim/run.ts（ボットで112ターン一気に回してバランスを見る道具）とは別物。
 * こちらは人間が commands.json に書いた命令で、本番のように1ターンずつ進める。
 */

const STATE_PATH = "out/state.json";
const COMMANDS_PATH = "commands.json";
const HISTORY_PATH = "out/history.json";
const MAP_PATH = "out/map.svg";

/**
 * 本番の参加者ID。まだ実際の部員名簿がないので仮のIDを使う。
 * M2でGitHub Issueから本物のIDを拾えるようになったら、ここは役目を終える。
 */
const PLAYER_IDS = Array.from(
  { length: 30 },
  (_, i) => `p${String(i).padStart(2, "0")}`,
);

function main() {
  mkdirSync("out", { recursive: true });

  if (!existsSync(STATE_PATH)) {
    const world = createWorld(PLAYER_IDS, CONFIG.simSeed);
    writeFileSync(STATE_PATH, JSON.stringify(world, null, 2));
    writeFileSync(MAP_PATH, renderMapSvg(world));
    writeFileSync(
      HISTORY_PATH,
      JSON.stringify([{ turn: world.turn, log: world.log }], null, 2),
    );
    console.log("世界を新しく作りました（0ターン目）。");
    console.log(
      `${COMMANDS_PATH} に1ターン目の命令を書いてから、もう一度 node sim/step.ts を実行してください。`,
    );
    console.log(`書き方の見本は commands_書き方.md を見てください。`);
    return;
  }

  const world: World = JSON.parse(readFileSync(STATE_PATH, "utf-8"));

  let rawCommands: unknown = [];
  if (existsSync(COMMANDS_PATH)) {
    try {
      rawCommands = JSON.parse(readFileSync(COMMANDS_PATH, "utf-8"));
    } catch {
      console.log(`\n${COMMANDS_PATH} がJSONとして読めませんでした。`);
      console.log(`世界はまだ進めていません。よくある原因:`);
      console.log(`  - { や [ の数が合っていない`);
      console.log(`  - 文字列を " で囲み忘れている`);
      console.log(`  - 最後の項目のあとに余計な , が付いている`);
      console.log(`\n書き方の見本は commands_書き方.md を見てください。`);
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

  const next = resolveTurn(world, ok);

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
  console.log(`\n${COMMANDS_PATH} を空にしました。次のターンの命令を書いてください。`);
  console.log(`（書き方の見本: commands_書き方.md）`);
}

main();
