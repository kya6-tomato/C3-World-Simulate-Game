import { writeFileSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { resolveTurn, score, capitalDistance } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { Rng } from "../src/rng.ts";
import { decide } from "./bots.ts";
import type { BotKind } from "./bots.ts";
import type { World, Command } from "../src/types.ts";

/**
 * 手元で100ターン回して、ゲームが成立しているか確かめるためのプログラム。
 * 実行: node sim/run.ts
 */

/**
 * 部員数を想定した人数でボットを用意する。
 * 実際のサークル規模で回さないと、5人では見えない問題（土地の奪い合い、
 * 交渉相手が見つからない、など）を見逃す。
 */
const PLAYER_COUNT = 30;

function buildRoster(): Record<string, BotKind> {
  const r: Record<string, BotKind> = {};
  for (let i = 0; i < PLAYER_COUNT; i++) {
    // 現実の部員の比率を想定: 大半は普通に交易する、少数が孤立・裏切り
    const kind: BotKind =
      i % 10 === 0 ? "loner" : i % 7 === 0 ? "betrayer" : "trader";
    r[`p${String(i).padStart(2, "0")}`] = kind;
  }
  return r;
}

const ROSTER: Record<string, BotKind> = buildRoster();

function main() {
  const ids = Object.keys(ROSTER);
  let world = createWorld(ids, CONFIG.simSeed);
  const rng = new Rng(CONFIG.simSeed ^ 0x5f3759df);

  const history: World[] = [structuredClone(world)];
  let tradeTurns = 0;
  let breaks = 0;
  let defaults = 0;
  let failedBuilds = 0;

  for (let t = 0; t < CONFIG.simTurns; t++) {
    const commands: Command[] = ids.flatMap((id) =>
      decide(world, id, ROSTER[id], rng)
    );
    world = resolveTurn(world, commands);
    history.push(structuredClone(world));

    if (world.contracts.some((c) => c.status === "active")) tradeTurns++;
    breaks += world.log.filter((l) => l.includes("【破棄】")).length;
    defaults += world.log.filter((l) => l.includes("【不履行】")).length;
    failedBuilds += world.log.filter((l) => l.includes("建設に失敗")).length;
  }

  report(world, tradeTurns, breaks, defaults, failedBuilds);
  writeOutputs(world, history);
}

function report(
  w: World,
  tradeTurns: number,
  breaks: number,
  defaults: number,
  failedBuilds: number,
) {
  console.log(`\n=== ${CONFIG.simTurns}ターン終了 ===\n`);

  const rows = Object.values(w.players)
    .map((p) => ({
      id: p.id,
      kind: ROSTER[p.id],
      lv: p.cities.reduce((s, c) => s + c.level, 0),
      land: w.tiles.filter((t) => t.owner === p.id).length,
      trust: p.trust,
      score: score(w, p.id),
    }))
    .sort((a, b) => b.score - a.score);

  console.log("順位  プレイヤー  型          都市Lv  領土  信用  得点");
  const show = [...rows.slice(0, 5), null, ...rows.slice(-3)];
  show.forEach((r, i) => {
    if (!r) return console.log("      ...");
    const rank = rows.indexOf(r) + 1;
    console.log(
      `${String(rank).padStart(2)}    ${r.id.padEnd(10)} ${r.kind.padEnd(10)} ` +
        `${String(r.lv).padStart(5)}  ${String(r.land).padStart(4)}  ` +
        `${String(r.trust).padStart(4)}  ${String(r.score).padStart(4)}`,
    );
  });

  // 型ごとの平均点。個人の運ではなく戦略の優劣を見るためのもの。
  console.log("\n型ごとの平均得点:");
  for (const k of ["trader", "betrayer", "loner"] as const) {
    const g = rows.filter((r) => r.kind === k);
    if (g.length === 0) continue;
    const avg = g.reduce((s, r) => s + r.score, 0) / g.length;
    const avgTrust = g.reduce((s, r) => s + r.trust, 0) / g.length;
    console.log(
      `  ${k.padEnd(9)} 人数${String(g.length).padStart(3)}  ` +
        `平均得点 ${avg.toFixed(1).padStart(6)}  平均信用 ${avgTrust.toFixed(0).padStart(3)}`,
    );
  }

  const active = w.contracts.filter((c) => c.status === "active").length;
  const total = w.contracts.length;

  console.log(`\n--- バランス診断 ---`);
  console.log(`契約が結ばれた回数        : ${total}`);
  console.log(`最終ターン時点で継続中    : ${active}`);
  console.log(`契約が動いていたターン数  : ${tradeTurns} / ${CONFIG.simTurns}`);
  console.log(`意図的な破棄              : ${breaks}`);
  console.log(`支払い不能による不履行    : ${defaults}`);
  console.log(`資源不足で建設できなかった回数: ${failedBuilds}`);

  console.log(`\n--- 判定 ---`);
  const tradeRate = tradeTurns / CONFIG.simTurns;
  check(
    tradeRate > 0.4,
    `交易が全体の${Math.round(tradeRate * 100)}%のターンで発生している`,
    `交易がほとんど起きていない（${Math.round(tradeRate * 100)}%）。資源のかたまり数を減らすか、建設コストを上げる。`,
  );

  const avgOf = (k: string) => {
    const g = rows.filter((r) => r.kind === k);
    return g.length ? g.reduce((s, r) => s + r.score, 0) / g.length : 0;
  };
  const tAvg = avgOf("trader");
  const lAvg = avgOf("loner");
  const bAvg = avgOf("betrayer");
  check(
    tAvg > lAvg * 1.2,
    `交易型が孤立型より明確に強い（平均 ${tAvg.toFixed(0)} vs ${lAvg.toFixed(0)}）`,
    `孤立型が健闘しすぎ（${tAvg.toFixed(0)} vs ${lAvg.toFixed(0)}）。資源をもっと偏らせる。`,
  );
  check(
    tAvg > bAvg,
    `裏切り型が長期的に損をしている（誠実 ${tAvg.toFixed(0)} vs 裏切り ${bAvg.toFixed(0)}）`,
    `裏切りが得になっている（誠実 ${tAvg.toFixed(0)} vs 裏切り ${bAvg.toFixed(0)}）。破棄の罰則を強める。`,
  );

  // 交渉相手がいない孤島プレイヤーがいないか
  const isolated = Object.keys(w.players).filter((id) => {
    return !Object.keys(w.players).some((o) => {
      if (o === id) return false;
      const d = capitalDistance(w, id, o);
      return d !== null && d <= CONFIG.tradeRange;
    });
  });
  const stuck = rows.filter((r) => r.lv <= 1);
  check(
    stuck.length <= rows.length * 0.05,
    `取り残されたプレイヤーはほぼいない（${stuck.length}/${rows.length}人）`,
    `${stuck.length}/${rows.length}人が112ターンかけて都市Lv1のまま。この人たちは現実には辞める。`,
  );

  check(
    isolated.length === 0,
    `全員に交渉できる隣人がいる`,
    `${isolated.length}人が孤立している（${isolated.slice(0, 5).join(",")}）。地図を狭めるか交易距離を伸ばす。`,
  );

  const maxLv = Math.max(...rows.map((r) => r.lv));
  check(
    maxLv < CONFIG.maxCityLevel * 3,
    `成長が頭打ちになっていない（最大都市Lv合計 ${maxLv}）`,
    `全員が上限に張り付いている。コストを上げるか上限を上げる。`,
  );
}

function check(ok: boolean, good: string, bad: string) {
  console.log(ok ? `  [OK] ${good}` : `  [要調整] ${bad}`);
}

/**
 * 検証専用の出力先。
 *
 * sim/step.ts（本番を1ターンずつ進める道具）が使う out/ とは
 * 意図的に分けてある。同じ場所に書くと、本番シーズン中にうっかり
 * このスクリプトを実行しただけで本番の進行状況が消えてしまう。
 */
const TEST_OUT = "out_test";

function writeOutputs(world: World, history: World[]) {
  mkdirSync(TEST_OUT, { recursive: true });
  writeFileSync(`${TEST_OUT}/map.svg`, renderMapSvg(world));
  writeFileSync(`${TEST_OUT}/state.json`, JSON.stringify(world, null, 2));
  writeFileSync(
    `${TEST_OUT}/history.json`,
    JSON.stringify(
      history.map((w) => ({ turn: w.turn, log: w.log })),
      null,
      2,
    ),
  );
  console.log(`\n出力しました（検証用。本番の out/ とは別物）:`);
  console.log(`  ${TEST_OUT}/map.svg      … 最終ターンの地図（ブラウザで開けます）`);
  console.log(`  ${TEST_OUT}/state.json   … 世界の状態`);
  console.log(`  ${TEST_OUT}/history.json … 毎ターンの出来事`);

  console.log(`\n--- 最終ターンの出来事 ---`);
  world.log.forEach((l) => console.log(`  ${l}`));
}

main();
