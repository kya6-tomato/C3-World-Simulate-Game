import type { Command, Resource } from "../src/types.ts";

/**
 * GitHub Issueのコメント（スマホでも打てる一行形式）を Command に変換する。
 *
 * 括弧・引用符・カンマを使わず、単語と数字をスペースで区切るだけの書式にしてある。
 * 「誰が」は書かない。Issueが1人1つの専用スレッドなので、どのIssueに書かれたかで決まる。
 *
 * 詳しい検証（相手が実在するか、距離が届くか等）はここではしない。
 * resolveTurn の中の各 do* 関数が実行時に確かめて、ダメなら理由をログに残す。
 * ここでやるのは「文として読める形になっているか」だけ。
 */

const TYPE_JA: Record<string, Command["type"]> = {
  建設: "build",
  開拓: "expand",
  待機: "pass",
  提案: "offer",
  承諾: "accept",
  破棄: "break",
  土地提案: "offerLand",
  土地承諾: "acceptLand",
  奪う: "seize",
};

const RESOURCE_JA_TO_EN: Record<string, Resource> = {
  食料: "food",
  資材: "material",
  知識: "knowledge",
};

export interface ParseResult {
  command: Command | null;
  error: string | null;
}

const USAGE: Record<string, string> = {
  提案: "提案 相手のID わたす 資源名 数 もらう 資源名 数 期間ターン（例: 提案 p05 わたす 資材 9 もらう 知識 9 8ターン）",
  承諾: "承諾 契約ID（例: 承諾 C5-p00-3）",
  破棄: "破棄 契約ID（例: 破棄 C5-p00-3）",
  土地提案: "土地提案 相手のID x y もらう 資源名 数（例: 土地提案 p05 12 7 もらう 知識 30）",
  土地承諾: "土地承諾 提案ID（例: 土地承諾 L3-p05-1）",
  奪う: "奪う x y（例: 奪う 12 7）",
};

export function parseComment(player: string, rawText: string): ParseResult {
  // 全角スペースも区切りとして扱い、前後の空白は無視する。
  const tokens = rawText
    .trim()
    .split(/[\s　]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { command: null, error: "コメントが空です。" };
  }

  const word = tokens[0];
  const kind = TYPE_JA[word];
  if (!kind) {
    return {
      command: null,
      error: `「${word}」という命令はありません（建設/開拓/待機/提案/承諾/破棄/土地提案/土地承諾/奪う のどれかを先頭に書いてください）。`,
    };
  }

  if (kind === "build" || kind === "expand" || kind === "pass") {
    return { command: { type: kind, player }, error: null };
  }

  if (kind === "accept" || kind === "break") {
    const contractId = tokens[1];
    if (!contractId) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: kind, player, contractId }, error: null };
  }

  if (kind === "acceptLand") {
    const landOfferId = tokens[1];
    if (!landOfferId) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: kind, player, landOfferId }, error: null };
  }

  if (kind === "seize") {
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: "seize", player, x, y }, error: null };
  }

  if (kind === "offer") {
    const to = tokens[1];
    const giveIdx = tokens.indexOf("わたす");
    const takeIdx = tokens.indexOf("もらう");
    const give = giveIdx >= 0 ? RESOURCE_JA_TO_EN[tokens[giveIdx + 1]] : undefined;
    const giveAmount = giveIdx >= 0 ? Number(tokens[giveIdx + 2]) : NaN;
    const take = takeIdx >= 0 ? RESOURCE_JA_TO_EN[tokens[takeIdx + 1]] : undefined;
    const takeAmount = takeIdx >= 0 ? Number(tokens[takeIdx + 2]) : NaN;
    const turnsWord = tokens[tokens.length - 1] ?? "";
    const turns = Number(turnsWord.replace("ターン", ""));

    if (
      !to ||
      !give ||
      !take ||
      !Number.isInteger(giveAmount) ||
      giveAmount <= 0 ||
      !Number.isInteger(takeAmount) ||
      takeAmount <= 0 ||
      !Number.isInteger(turns) ||
      turns <= 0
    ) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return {
      command: { type: "offer", player, to, give, giveAmount, take, takeAmount, turns },
      error: null,
    };
  }

  if (kind === "offerLand") {
    const to = tokens[1];
    const x = Number(tokens[2]);
    const y = Number(tokens[3]);
    const takeIdx = tokens.indexOf("もらう");
    const wantResource = takeIdx >= 0 ? RESOURCE_JA_TO_EN[tokens[takeIdx + 1]] : undefined;
    const wantAmount = takeIdx >= 0 ? Number(tokens[takeIdx + 2]) : NaN;

    if (
      !to ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !wantResource ||
      !Number.isInteger(wantAmount) ||
      wantAmount <= 0
    ) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return {
      command: { type: "offerLand", player, to, x, y, wantResource, wantAmount },
      error: null,
    };
  }

  return { command: null, error: `「${word}」に対応する処理が実装されていません。` };
}
