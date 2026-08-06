import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { resolveTurn } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { RESOURCES } from "../src/types.ts";
import type { World, Command, Resource } from "../src/types.ts";

/** 日本語でも書けるようにするための言い換え表。 */
const TYPE_JA: Record<string, string> = {
  建設: "build",
  開拓: "expand",
  提案: "offer",
  承諾: "accept",
  破棄: "break",
  土地提案: "offerLand",
  土地承諾: "acceptLand",
  奪う: "seize",
  待機: "pass",
};
const RESOURCE_JA_TO_EN: Record<string, Resource> = {
  食料: "food",
  資材: "material",
  知識: "knowledge",
};

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

  const { ok, errors } = validateCommands(world, rawCommands);
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

/** commands.json の中身が正しい形か確かめる。ここは新規のチェック層。 */
function validateCommands(
  w: World,
  commands: unknown,
): { ok: Command[]; errors: string[] } {
  if (!Array.isArray(commands)) {
    return {
      ok: [],
      errors: [`${COMMANDS_PATH} は配列 [ ... ] の形にしてください。`],
    };
  }

  const validTypes = new Set([
    "expand",
    "build",
    "offer",
    "accept",
    "break",
    "offerLand",
    "acceptLand",
    "seize",
    "pass",
  ]);
  const errors: string[] = [];
  const ok: Command[] = [];

  commands.forEach((c, i) => {
    const label = `${i + 1}件目の命令`;
    if (typeof c !== "object" || c === null) {
      errors.push(`${label}: { type: ..., player: ... } の形になっていません。`);
      return;
    }
    const cmd = c as Record<string, unknown>;

    // 日本語で書かれていたら英語に変換してから扱う。
    if (typeof cmd.type === "string" && TYPE_JA[cmd.type]) {
      cmd.type = TYPE_JA[cmd.type];
    }
    if (typeof cmd.give === "string" && RESOURCE_JA_TO_EN[cmd.give]) {
      cmd.give = RESOURCE_JA_TO_EN[cmd.give];
    }
    if (typeof cmd.take === "string" && RESOURCE_JA_TO_EN[cmd.take]) {
      cmd.take = RESOURCE_JA_TO_EN[cmd.take];
    }

    if (!validTypes.has(cmd.type as string)) {
      errors.push(
        `${label}: type "${cmd.type}" は使えません（建設/開拓/提案/承諾/破棄/土地提案/土地承諾/奪う/待機 のどれか）。`,
      );
      return;
    }
    if (typeof cmd.player !== "string" || !w.players[cmd.player]) {
      errors.push(`${label}: player "${cmd.player}" という参加者はいません。`);
      return;
    }

    if (cmd.type === "offer") {
      if (typeof cmd.to !== "string" || !w.players[cmd.to]) {
        errors.push(`${label}: 相手 "${cmd.to}" という参加者はいません。`);
        return;
      }
      if (cmd.to === cmd.player) {
        errors.push(`${label}: 自分自身とは取引できません。`);
        return;
      }
      if (!RESOURCES.includes(cmd.give as never)) {
        errors.push(
          `${label}: give "${cmd.give}" は資源名ではありません（食料/資材/知識）。`,
        );
        return;
      }
      if (!RESOURCES.includes(cmd.take as never)) {
        errors.push(
          `${label}: take "${cmd.take}" は資源名ではありません（食料/資材/知識）。`,
        );
        return;
      }
      if (!(Number.isInteger(cmd.giveAmount) && (cmd.giveAmount as number) > 0)) {
        errors.push(`${label}: giveAmount は1以上の整数にしてください。`);
        return;
      }
      if (!(Number.isInteger(cmd.takeAmount) && (cmd.takeAmount as number) > 0)) {
        errors.push(`${label}: takeAmount は1以上の整数にしてください。`);
        return;
      }
      if (!(Number.isInteger(cmd.turns) && (cmd.turns as number) > 0)) {
        errors.push(`${label}: turns は1以上の整数にしてください。`);
        return;
      }
    }

    if (cmd.type === "accept" || cmd.type === "break") {
      const found = w.contracts.some((ct) => ct.id === cmd.contractId);
      if (typeof cmd.contractId !== "string" || !found) {
        errors.push(`${label}: 契約ID "${cmd.contractId}" が見つかりません。`);
        return;
      }
    }

    const inBounds = (x: unknown, y: unknown) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      (x as number) >= 0 &&
      (x as number) < w.width &&
      (y as number) >= 0 &&
      (y as number) < w.height;

    if (cmd.type === "offerLand") {
      if (typeof cmd.to !== "string" || !w.players[cmd.to]) {
        errors.push(`${label}: 相手 "${cmd.to}" という参加者はいません。`);
        return;
      }
      if (cmd.to === cmd.player) {
        errors.push(`${label}: 自分自身とは取引できません。`);
        return;
      }
      if (!inBounds(cmd.x, cmd.y)) {
        errors.push(`${label}: x, y はマス目の範囲内の整数にしてください（0〜${w.width - 1}, 0〜${w.height - 1}）。`);
        return;
      }
      if (typeof cmd.wantResource === "string" && RESOURCE_JA_TO_EN[cmd.wantResource]) {
        cmd.wantResource = RESOURCE_JA_TO_EN[cmd.wantResource];
      }
      if (!RESOURCES.includes(cmd.wantResource as never)) {
        errors.push(`${label}: wantResource "${cmd.wantResource}" は資源名ではありません（食料/資材/知識）。`);
        return;
      }
      if (!(Number.isInteger(cmd.wantAmount) && (cmd.wantAmount as number) > 0)) {
        errors.push(`${label}: wantAmount は1以上の整数にしてください。`);
        return;
      }
    }

    if (cmd.type === "acceptLand") {
      const found = w.landOffers.some((lo) => lo.id === cmd.landOfferId);
      if (typeof cmd.landOfferId !== "string" || !found) {
        errors.push(`${label}: 土地の提案ID "${cmd.landOfferId}" が見つかりません。`);
        return;
      }
    }

    if (cmd.type === "seize") {
      if (!inBounds(cmd.x, cmd.y)) {
        errors.push(`${label}: x, y はマス目の範囲内の整数にしてください（0〜${w.width - 1}, 0〜${w.height - 1}）。`);
        return;
      }
    }

    ok.push(cmd as unknown as Command);
  });

  return { ok, errors };
}

main();
