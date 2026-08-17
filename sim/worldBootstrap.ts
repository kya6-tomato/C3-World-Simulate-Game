import { writeFileSync, mkdirSync } from "node:fs";
import { createWorld } from "../src/worldgen.ts";
import { renderMapSvg } from "../src/render.ts";
import { postSystemComment } from "./github.ts";

/**
 * 0ターン目の世界を作り、保存し、参加者全員のIssueに開始のお知らせを投稿する。
 * sim/github-turn.ts（初回実行時）と sim/reset-season.ts（シーズン切り替え時）の
 * 両方から使う共通処理。
 */
export async function bootstrapWorld(
  gameDir: string,
  players: Record<string, number>,
  seed: number,
): Promise<void> {
  mkdirSync(gameDir, { recursive: true });
  const ids = Object.keys(players);
  const world = createWorld(ids, seed);

  writeFileSync(`${gameDir}/state.json`, JSON.stringify(world, null, 2));
  writeFileSync(`${gameDir}/map.svg`, renderMapSvg(world));
  writeFileSync(
    `${gameDir}/history.json`,
    JSON.stringify([{ turn: world.turn, log: world.log }], null, 2),
  );
  writeFileSync(
    `${gameDir}/lastRun.json`,
    JSON.stringify({ processedAt: new Date().toISOString() }, null, 2),
  );

  for (const id of ids) {
    await postSystemComment(
      players[id],
      `世界が始まりました。あなたは **${id}** です。\n\n` +
        `**最初にすること**\n` +
        `このIssueに、今回したいことを一言コメントしてください。\n` +
        `例: \`建設\` / \`開拓\` / \`提案 p05 わたす 資材 9 もらう 知識 9 8ターン\`\n\n` +
        `**今後の流れ**\n` +
        `1日4回（9時・13時・17時・21時）、そのときまでの一番新しいコメントが自動で反映されて、結果がこのIssueに返信されます。\n` +
        `何も書かなくても、いつもの行動が自動で続くので、書き忘れても大丈夫です。\n` +
        `今回は約1週間のお試し期間です。\n\n` +
        `盤面はここで誰でも見られます: https://kya6-tomato.github.io/C3-World-Simulate-Game/\n\n` +
        `詳しい書き方は [コメントの書き方.md](https://github.com/kya6-tomato/C3-World-Simulate-Game/blob/main/コメントの書き方.md)、` +
          `ルールの中身は [ルールブック.md](https://github.com/kya6-tomato/C3-World-Simulate-Game/blob/main/ルールブック.md) を見てください。`,
    );
  }
}
