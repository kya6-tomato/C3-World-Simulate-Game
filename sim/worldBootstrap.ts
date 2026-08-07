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
      `世界が始まりました。あなたは **${id}** です。\n\nこのIssueにコメントで命令を書くと、次に \`node sim/github-turn.ts\` を実行したときに反映されます。書き方は ${"`"}commands_書き方.md${"`"} と同じ考え方（建設・開拓・提案・承諾・破棄・土地提案・土地承諾・奪う・待機）ですが、スマホでも打てる一行形式です。例: \`建設\` / \`提案 p05 わたす 資材 9 もらう 知識 9 8ターン\``,
    );
  }
}
