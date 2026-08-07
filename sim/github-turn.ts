import { existsSync as fileExists } from "node:fs";
// .env はローカルでの手元テスト用。GitHub Actions上には存在しないので、
// あるときだけ読み込む（無いと process.loadEnvFile がエラーで止まってしまうため）。
if (fileExists(".env")) process.loadEnvFile(".env");

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { resolveTurn } from "../src/rules.ts";
import { renderMapSvg } from "../src/render.ts";
import { CONFIG } from "../src/config.ts";
import { listComments, postComment } from "./github.ts";
import { parseComment } from "./commentParser.ts";
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

// Botが投稿する返信の先頭に必ず付ける、目に見えない印。
// これが付いたコメントは、次にコメントを読み取るときに「命令」として扱わない。
// 手元でテストするときはBotも自分と同じアカウントで投稿するため、
// 投稿者では見分けられない。内容に印を付けることで確実に区別する。
const SYSTEM_MARKER = "<!-- system-reply -->";

function isSystemReply(body: string): boolean {
  return body.trimStart().startsWith(SYSTEM_MARKER);
}

async function postSystemComment(issueNumber: number, body: string): Promise<void> {
  await postComment(issueNumber, `${SYSTEM_MARKER}\n${body}`);
}

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
  mkdirSync(GAME_DIR, { recursive: true });
  const players = loadPlayers();
  const ids = Object.keys(players);

  if (ids.length === 0) {
    console.log(`${PLAYERS_PATH} に参加者が1人もいません。`);
    return;
  }

  if (!existsSync(STATE_PATH)) {
    const world = createWorld(ids, SEED);
    writeFileSync(STATE_PATH, JSON.stringify(world, null, 2));
    writeFileSync(MAP_PATH, renderMapSvg(world));
    writeFileSync(
      HISTORY_PATH,
      JSON.stringify([{ turn: world.turn, log: world.log }], null, 2),
    );
    writeFileSync(
      RUN_PATH,
      JSON.stringify({ processedAt: new Date().toISOString() }, null, 2),
    );
    console.log("GitHub連携用の世界を作りました（0ターン目）。");
    for (const id of ids) {
      await postSystemComment(
        players[id],
        `世界が始まりました。あなたは **${id}** です。\n\nこのIssueにコメントで命令を書くと、次に \`node sim/github-turn.ts\` を実行したときに反映されます。書き方は ${"`"}commands_書き方.md${"`"} と同じ考え方（建設・開拓・提案・承諾・破棄・土地提案・土地承諾・奪う・待機）ですが、スマホでも打てる一行形式です。例: \`建設\` / \`提案 p05 わたす 資材 9 もらう 知識 9 8ターン\``,
      );
    }
    console.log("各参加者のIssueに開始のお知らせを投稿しました。");
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

  // 各参加者に、自分に関係する出来事だけを返信する。
  for (const id of ids) {
    const issueNumber = players[id];
    const mine = next.log.filter((l) => l.includes(id));
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
    await postSystemComment(issueNumber, lines.join("\n"));
  }
  console.log("各参加者のIssueに結果を返信しました。");
}

main();
