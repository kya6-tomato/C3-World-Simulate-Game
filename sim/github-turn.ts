import { existsSync as fileExists } from "node:fs";
// .env はローカルでの手元テスト用。GitHub Actions上には存在しないので、
// あるときだけ読み込む（無いと process.loadEnvFile がエラーで止まってしまうため）。
if (fileExists(".env")) process.loadEnvFile(".env");

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolveTurn } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { listComments, isSystemReply, postSystemComment } from "./github.ts";
import { parseComment } from "./commentParser.ts";
import { bootstrapWorld } from "./worldBootstrap.ts";
import { statusHint, riskHint } from "./statusHint.ts";
import type { World, Command } from "../src/types.ts";

/**
 * GitHub Issueのコメントを命令として読み取り、1ターン進めて、
 * 結果を各参加者のIssueに返信するプログラム。
 * 実行: node sim/github-turn.ts
 *
 * 保存先は環境変数 GAME_DIR で切り替える。
 *   - 手元で試すとき: 既定の out_github/（.gitignore で除外、消えても困らない）
 *   - GitHub Actions（本番の自動実行）: game/（Gitでコミットして残す。
 *     これが無いと、Actionsは毎回まっさらな環境で動くので、
 *     実行するたびに0ターン目からやり直しになってしまう）
 */

const GAME_DIR = process.env.GAME_DIR || "out_github";
const STATE_PATH = `${GAME_DIR}/state.json`;
const HISTORY_PATH = `${GAME_DIR}/history.json`;
const MAP_PATH = `${GAME_DIR}/map.svg`;
const RUN_PATH = `${GAME_DIR}/lastRun.json`;
const PLAYERS_PATH = "players.json";
const SEED = CONFIG.simSeed + 2000; // 本番・練習用の地図と混同しないよう別の種にする

function loadPlayers(): Record<string, number> {
  return JSON.parse(readFileSync(PLAYERS_PATH, "utf-8"));
}

async function main() {
  const players = loadPlayers();
  const ids = Object.keys(players);

  if (ids.length === 0) {
    console.log(`${PLAYERS_PATH} に参加者が1人もいません。`);
    return;
  }

  if (!existsSync(STATE_PATH)) {
    await bootstrapWorld(GAME_DIR, players, SEED);
    console.log("世界を作りました（0ターン目）。各参加者のIssueに開始のお知らせを投稿しました。");
    return;
  }

  const world: World = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  const lastRun: { processedAt: string } = JSON.parse(
    readFileSync(RUN_PATH, "utf-8"),
  );
  const since = lastRun.processedAt;
  const now = new Date().toISOString();

  const commands: Command[] = [];
  const errorsByPlayer: Record<string, string[]> = {};

  for (const id of ids) {
    const issueNumber = players[id];
    const comments = (await listComments(issueNumber, since)).filter(
      (c) => !isSystemReply(c.body),
    );
    if (comments.length === 0) continue;

    // 前回の処理より後に書かれたコメントのうち、一番新しいものだけを今ターンの命令にする。
    const last = comments[comments.length - 1];
    const { command, error } = parseComment(id, last.body);
    if (command) {
      commands.push(command);
    } else if (error) {
      errorsByPlayer[id] = [error];
    }
  }

  const next = resolveTurn(world, commands);

  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  writeFileSync(MAP_PATH, renderMapSvg(next));

  const history = existsSync(HISTORY_PATH)
    ? JSON.parse(readFileSync(HISTORY_PATH, "utf-8"))
    : [];
  history.push({ turn: next.turn, log: next.log });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  writeFileSync(RUN_PATH, JSON.stringify({ processedAt: now }, null, 2));

  console.log(`=== ${next.turn}ターン目まで進みました ===`);
  next.log.forEach((l) => console.log(`  ${l}`));

  // 2人以上のプレイヤーが関わる出来事（取引・土地のやり取り・奪取など）は、
  // 当事者だけでなく全員に共有する。市場の動きが見えないと交渉相手を探しにくいため。
  const interactiveLines = next.log.filter(
    (l) => ids.filter((pid) => l.includes(pid)).length >= 2,
  );

  // 各参加者に、自分に関係する出来事・全体の出来事・今の状況・次の目安を返信する。
  for (const id of ids) {
    const issueNumber = players[id];
    const mine = next.log.filter((l) => l.includes(id));
    const others = interactiveLines.filter((l) => !mine.includes(l));
    const errs = errorsByPlayer[id] ?? [];

    const lines: string[] = [`**${next.turn}ターン目の結果**`];
    if (errs.length > 0) {
      lines.push("", "あなたの命令は読み取れませんでした:");
      errs.forEach((e) => lines.push(`- ${e}`));
    }
    if (mine.length > 0) {
      lines.push("", ...mine.map((l) => `- ${l}`));
    }
    if (errs.length === 0 && mine.length === 0) {
      lines.push("", "（今回は特に動きはありませんでした）");
    }

    if (others.length > 0) {
      lines.push("", "**全体のできごと**", ...others.map((l) => `- ${l}`));
    }

    const p = next.players[id];
    if (p) {
      const land = next.tiles.filter((t) => t.owner === id).length;
      const cityLv = p.cities.reduce((s, c) => s + c.level, 0);
      const score = cityLv * 10 + land;
      lines.push(
        "",
        "**今の状況**",
        `都市 Lv${cityLv} ・ 領土 ${land}マス ・ 信用 ${p.trust} ・ 得点 ${score}（都市Lv×10＋領土）`,
        `食料 ${p.stock.food} ・ 資材 ${p.stock.material} ・ 知識 ${p.stock.knowledge}`,
      );
    }

    const risks = riskHint(next, id);
    if (risks.length > 0) {
      lines.push("", "**このままだと起きるかもしれない危険**", ...risks.map((r) => `- ${r}`));
    }

    const hints = statusHint(next, id);
    if (hints.length > 0) {
      lines.push("", "**次の目安**", ...hints.map((h) => `- ${h}`));
    }

    lines.push(
      "",
      `次の命令をこのIssueにコメントしてください（次のターンは ${CONFIG.turnTimesJst.map((t) => `${t}時${CONFIG.turnMinuteJst}分`).join("・")} のいずれか）。何も書かなければ、いつもの行動が自動で続きます。`,
    );
    await postSystemComment(issueNumber, lines.join("\n"));
  }
  console.log("各参加者のIssueに結果を返信しました。");
}

main();
