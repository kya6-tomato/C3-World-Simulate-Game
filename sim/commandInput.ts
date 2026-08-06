import { RESOURCES } from "../src/types.ts";
import type { World, Command, Resource } from "../src/types.ts";

/** 日本語でも書けるようにするための言い換え表。 */
export const TYPE_JA: Record<string, string> = {
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
export const RESOURCE_JA_TO_EN: Record<string, Resource> = {
  食料: "food",
  資材: "material",
  知識: "knowledge",
};

/**
 * 手書きの命令ファイル（JSON）の中身が正しい形か確かめる。
 * sim/step.ts と sim/solo.ts の両方から使う共通部品。
 */
export function validateCommands(
  w: World,
  commands: unknown,
  path: string,
): { ok: Command[]; errors: string[] } {
  if (!Array.isArray(commands)) {
    return {
      ok: [],
      errors: [`${path} は配列 [ ... ] の形にしてください。`],
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
