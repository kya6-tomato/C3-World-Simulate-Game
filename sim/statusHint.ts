import type { World, Player, Resource, Tile } from "../src/types.ts";
import { RESOURCE_JA, RESOURCES } from "../src/types.ts";
import { CONFIG } from "../src/config.ts";
import {
  ACHIEVEMENTS,
  buildCostFor,
  dominantResourceOf,
  effectiveTradeRange,
  expandCostTotal,
  isUnderdog,
  seizeCostFor,
  territoryDistance,
  totalCityLevel,
  totalScore,
  totalStock,
  underdogCostDiscount,
  underdogTier,
} from "../src/rules.ts";
import { tileAt, neighbors } from "../src/worldgen.ts";

/** そのマスに、誰かの都市が建っているか（rules.tsの同名関数と同じ判定）。 */
function hasCityAt(w: World, x: number, y: number): boolean {
  return Object.values(w.players).some((pl) =>
    pl.cities.some((c) => c.x === x && c.y === y),
  );
}

/** 自分の領土に隣接している、まだ誰のものでもない土地（重複なし）。 */
function adjacentUnowned(w: World, playerId: string): Tile[] {
  const found = new Map<string, Tile>();
  for (const t of w.tiles) {
    if (t.owner !== playerId) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "waste" && nt.kind !== "river") {
        found.set(`${nt.x},${nt.y}`, nt);
      }
    }
  }
  return [...found.values()];
}

/** 自分の領土に隣接していて、信用が低いために奪える他人の土地（都市マスは除く）。 */
function seizableNeighbors(w: World, playerId: string): Tile[] {
  const found = new Map<string, Tile>();
  for (const t of w.tiles) {
    if (t.owner !== playerId) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (!nt || !nt.owner || nt.owner === playerId) continue;
      const victim = w.players[nt.owner];
      if (!victim || victim.trust >= CONFIG.seizeBelowTrust) continue;
      if (hasCityAt(w, nt.x, nt.y)) continue;
      found.set(`${nt.x},${nt.y}`, nt);
    }
  }
  return [...found.values()];
}

/**
 * 「今どうすると次どうなるか」の目安を、プレイヤーへの返信に添えるための行を作る。
 * ゲームの結果には影響しない、参考情報だけの関数。
 */
export function statusHint(w: World, playerId: string): string[] {
  const p = w.players[playerId];
  if (!p) return [];

  const lines: string[] = [];
  const pointless: string[] = [];
  const underdogRate = underdogCostDiscount(w, playerId);

  if (underdogRate > 0) {
    const tierLabel = underdogTier(w, playerId) === 2 ? "危機的" : "劣勢";
    lines.push(
      `平均得点より${tierLabel}のため、開拓・建設・奪うのコストが${Math.round(underdogRate * 100)}%割引されています。`,
    );
  }

  // 建設まで、あと何が足りないか
  const city = p.cities
    .slice()
    .sort((a, b) => a.level - b.level)
    .find((c) => c.level < CONFIG.maxCityLevel);
  if (!city) {
    lines.push("すべての都市が最大レベルです。");
    pointless.push("建設（すべての都市が最大レベルのため）");
  } else {
    const cost = buildCostFor(city.level + 1, p.trust, underdogRate);
    const missing = RESOURCES.filter((r) => p.stock[r] < cost[r]).map(
      (r) => `${RESOURCE_JA[r]}${cost[r] - p.stock[r]}`,
    );
    if (missing.length === 0) {
      lines.push(`建設すれば都市が Lv${city.level + 1} になります。`);
    } else {
      lines.push(
        `都市を Lv${city.level + 1} にするには、あと${missing.join("、")}が必要です。`,
      );
      pointless.push("建設（資源が足りないため）");
    }
  }

  // 開拓まで、あと合計いくつ足りないか
  const owned = w.tiles.filter((t) => t.owner === playerId).length;
  const expandCost = expandCostTotal(owned, totalCityLevel(p), underdogRate);
  const have = totalStock(p.stock);
  const expandCandidates = adjacentUnowned(w, playerId);
  if (expandCandidates.length === 0) {
    lines.push("隣接する開拓できる土地が今はありません。");
    pointless.push("開拓（隣接する未開拓地がないため）");
  } else if (have >= expandCost) {
    lines.push(`開拓できます（必要は資源の合計${expandCost}、今は合計${have}）。`);
  } else {
    lines.push(
      `開拓するには、あと合計${expandCost - have}の資源が必要です（必要 合計${expandCost}）。`,
    );
    pointless.push("開拓（資源が足りないため）");
  }

  // 隣接している、まだ誰のものでもない土地には何があるか
  if (expandCandidates.length > 0) {
    const ownedKinds = new Set<Resource>();
    for (const t of w.tiles) {
      if (t.owner === playerId && t.kind !== "waste" && t.kind !== "river") {
        ownedKinds.add(t.kind as Resource);
      }
    }
    const counts = new Map<Resource, number>();
    for (const t of expandCandidates) {
      const k = t.kind as Resource;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([kind, n]) => {
      const isNew = !ownedKinds.has(kind);
      return `${RESOURCE_JA[kind]}${n}マス${isNew ? "（今は持っていない資源）" : ""}`;
    });
    lines.push(`隣接する開拓候補: ${parts.join("、")}。`);
  }

  // 提案は、信用が低いと誰にもできない
  if (p.trust < CONFIG.tradeBlockedBelow) {
    pointless.push(`提案（信用が低く誰とも契約できないため。今の信用${p.trust}）`);
  }

  // 奪う：対象がいるか、いても資源が足りるか
  const seizeTargets = seizableNeighbors(w, playerId);
  if (seizeTargets.length === 0) {
    pointless.push("奪う（隣接して信用の低い相手がいないため）");
  } else {
    // 相手の都市レベルによる防衛分はここでは考慮しない（対象が複数あり得るため）。
    const seizeCost = seizeCostFor(owned, totalCityLevel(p), 0, underdogRate);
    if (have < seizeCost) {
      pointless.push(`奪う（資源が足りないため。必要 合計${seizeCost}）`);
    }
  }

  if (pointless.length > 0) {
    lines.push(`今やっても効果がない行動: ${pointless.join("、")}。`);
  }

  // 今の常時行動（コメントしなかった時に自動で続く行動）が、その「効果がない行動」に
  // 当てはまっている場合は、特に見落としやすいので念押しする。
  const standingLabel: Record<Player["standing"], string> = {
    build: "建設",
    expand: "開拓",
    pass: "待機",
  };
  if (
    p.standing !== "pass" &&
    pointless.some((x) => x.startsWith(standingLabel[p.standing]))
  ) {
    lines.push(
      `※ 今の常時行動は「${standingLabel[p.standing]}」ですが、上の理由でこのままでは何も起きません。`,
    );
  }

  return lines;
}

/**
 * 「今のまま何もしなければ、この先どんな危険があるか」を、プレイヤーへの
 * 返信に添えるための行を作る。実際に何かが起きるとは限らない、事前の注意喚起。
 */
export function riskHint(w: World, playerId: string): string[] {
  const p = w.players[playerId];
  if (!p) return [];

  const lines: string[] = [];
  const mult = p.trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustYieldPenalty : 1;
  const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);

  // 食料が尽きて都市が縮む危険（次のターンの収支を先読みする）
  const foodTiles = w.tiles.filter(
    (t) => t.owner === playerId && t.kind === "food",
  ).length;
  const foodIncome =
    CONFIG.yieldPerTile * foodTiles * mult + CONFIG.cityFoodPerLevel * totalLevel * mult;
  const upkeep =
    CONFIG.upkeepPerCityLevel * totalLevel +
    CONFIG.upkeepGrowthPerLevel * totalLevel * totalLevel;
  const nextFood = p.stock.food + foodIncome - upkeep;
  if (nextFood < 0) {
    lines.push(
      `このままだと次のターンで食料が尽きて、都市が飢えて縮んでしまう可能性があります（食料の収支が${Math.round(foodIncome - upkeep)}）。`,
    );
  }

  // 進行中の契約の支払いが、今の手持ちでは足りない危険
  const owed = new Map<Resource, number>();
  for (const c of w.contracts) {
    if (c.status !== "active") continue;
    if (c.from === playerId) owed.set(c.give, (owed.get(c.give) ?? 0) + c.giveAmount);
    if (c.to === playerId) owed.set(c.take, (owed.get(c.take) ?? 0) + c.takeAmount);
  }
  const shortfalls = [...owed.entries()].filter(([r, amt]) => p.stock[r] < amt);
  if (shortfalls.length > 0) {
    const parts = shortfalls.map(
      ([r, amt]) => `${RESOURCE_JA[r]}があと${amt - p.stock[r]}足りません`,
    );
    lines.push(
      `進行中の契約の支払いが、今の手持ちでは足りません: ${parts.join("、")}。次のターンで払えないと不履行になり、信用が下がります（-12）。`,
    );
  }

  // 信用が下がっていて、あと少しで新規取引ができなくなる危険
  const blockGap = CONFIG.tradeBlockedBelow - p.trust;
  if (blockGap >= 0) {
    // すでに取引不可の場合は pointless 側で案内済みなのでここでは触れない
  } else if (blockGap > -15) {
    lines.push(
      `信用が${p.trust}まで下がっています。あと少し（不履行1回など）で信用${CONFIG.tradeBlockedBelow}を下回り、新しい取引ができなくなります。`,
    );
  }

  // 信用が低く、隣人から土地を奪われる危険
  if (p.trust < CONFIG.seizeBelowTrust) {
    lines.push(
      `信用が${p.trust}まで下がっていて、隣接している人から土地を同意なく奪われる対象になっています。`,
    );
  } else if (p.trust < CONFIG.seizeBelowTrust + 15) {
    lines.push(
      `信用が${p.trust}まで下がっています。あと少しでさらに悪化すると、隣接している人から土地を奪われる対象（信用${CONFIG.seizeBelowTrust}未満）になります。`,
    );
  }

  return lines;
}

/**
 * 今回のターンで、資源がどれだけ動いたかを一覧にする。
 * 「生産」は土地・都市からの収入（produce()と同じ式で、ターン開始前の状態から計算）、
 * 「その他」は建設・開拓・取引・維持費などをまとめた残り、「合計」は差し引き後の増減。
 */
export function resourceLedger(before: World, after: World, playerId: string): string[] {
  const bp = before.players[playerId];
  const ap = after.players[playerId];
  if (!bp || !ap) return [];

  const mult = bp.trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustYieldPenalty : 1;
  const totalLevel = bp.cities.reduce((s, c) => s + c.level, 0);

  const production: Record<Resource, number> = { food: 0, material: 0, knowledge: 0 };
  for (const t of before.tiles) {
    if (t.owner === playerId && t.kind !== "waste" && t.kind !== "river") {
      production[t.kind as Resource] += CONFIG.yieldPerTile * mult;
    }
  }
  production.food += CONFIG.cityFoodPerLevel * totalLevel * mult;

  const lines: string[] = [];
  for (const r of RESOURCES) {
    const net = ap.stock[r] - bp.stock[r];
    const prod = Math.round(production[r]);
    const other = net - prod;
    if (prod === 0 && net === 0) continue; // 何も動いていない資源は表示しない
    const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    lines.push(
      `${RESOURCE_JA[r]}: 生産${fmt(prod)} ・ その他${fmt(other)} ・ 合計${fmt(net)}（今 ${ap.stock[r]}）`,
    );
  }
  return lines;
}

/**
 * 自分宛てに来ている、まだ返事をしていない提案・土地提案を一覧にする。
 * 承諾するためのコマンドをそのままコピペできる形で添えるので、
 * 提案されたことに気づきさえすれば、迷わず承諾できる。
 */
export function pendingOffersHint(w: World, playerId: string): string[] {
  const lines: string[] = [];

  for (const c of w.contracts) {
    if (c.status !== "proposed" || c.to !== playerId) continue;
    const left = CONFIG.offerExpiryTurns - (w.turn - c.proposedAt);
    lines.push(
      `${c.from} からの提案（あと${left}ターンで失効）: 承諾すると ${RESOURCE_JA[c.give]}${c.giveAmount}をもらい、` +
        `${RESOURCE_JA[c.take]}${c.takeAmount}を渡す（毎ターン・${c.turnsLeft}ターン間）ことになります。` +
        `承諾するには次のコメントをそのままコピペ: \`承諾 ${c.id}\``,
    );
  }

  for (const lo of w.landOffers) {
    if (lo.status !== "proposed" || lo.to !== playerId) continue;
    const left = CONFIG.offerExpiryTurns - (w.turn - lo.proposedAt);
    lines.push(
      `${lo.from} からの土地提案（あと${left}ターンで失効）: 承諾すると (${lo.x},${lo.y}) がもらえる代わりに、` +
        `${RESOURCE_JA[lo.wantResource]}${lo.wantAmount}を渡すことになります。` +
        `承諾するには次のコメントをそのままコピペ: \`土地承諾 ${lo.id}\``,
    );
  }

  return lines;
}

/**
 * これまでに獲得した称号（実績）の数を、返信の「今の状況」に添えるための1行。
 * 新規獲得そのものは resolveTurn の中でログ（【称号】〜）として出るので、
 * ここでは「今何個持っているか」の要約だけを返す。
 */
export function achievementSummaryLine(w: World, playerId: string): string | null {
  const p = w.players[playerId];
  if (!p || !p.achievements || p.achievements.length === 0) return null;
  return `称号 ${p.achievements.length}/${ACHIEVEMENTS.length}個 獲得済み。`;
}

/**
 * 発生中の「世界の脅威」の状況（進捗・締切）を1行にする。
 * 発生していなければ null。
 */
export function threatHint(w: World): string | null {
  if (!w.threat) return null;
  const t = w.threat;
  const left = t.deadlineTurn - w.turn;
  const deadlineLabel = left > 0 ? `あと${left}ターンで期限` : "期限切れ・被害が毎ターン拡大中";
  return (
    `「${t.name}」進行中: 貢献 ${t.contributed}/${t.requirement}（${deadlineLabel}）。` +
    `\`貢献 資源名 数\` で協力できます。`
  );
}

/**
 * 進行中の「共同事業」の状況を1行にする。自分がその隣接地を持っていて
 * 着工できる状態なら、その旨も添える。発生していなければ null。
 */
export function projectHint(w: World, playerId: string): string | null {
  if (!w.project) return null;
  const pr = w.project;
  if (!pr.ready) {
    return (
      `「${pr.name}」建設地 (${pr.x},${pr.y}): 拠出 ${pr.pooled}/${pr.requirement}。` +
      `\`輸出 資源名 数\` で協力できます。`
    );
  }
  const canCommence = neighbors(pr.x, pr.y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === playerId;
  });
  return (
    `「${pr.name}」建設地 (${pr.x},${pr.y}): 資材が集まりました。` +
    (canCommence
      ? "あなたはこの隣接地を持っています。`着工` で完成させられます。"
      : "隣接地を持つ人が `着工` すれば完成します。")
  );
}

/**
 * 世界目標（世界全体の都市レベル合計）の、次の到達ラインまでの進捗を1行にする。
 * 罰の無いプラスの目標なので、専用コマンドは無く常に進行中。
 */
export function worldGoalHint(w: World): string {
  const totalWorldLevel = Object.values(w.players).reduce((s, p) => s + totalCityLevel(p), 0);
  const threshold = w.worldGoalNextThreshold ?? CONFIG.worldGoalStep;
  return (
    `世界全体の都市レベル合計 ${totalWorldLevel}/${threshold} に到達すると、全員に資源が贈られます` +
    `（誰かが建設すれば自然に進みます。専用の操作は不要です）。`
  );
}

/**
 * 今起きている世界規模のイベント（世界の脅威・共同事業・世界目標）を、
 * まとめて一覧にする。返信の「現在のイベント」欄に使う。
 */
export function worldEventsHint(w: World, playerId: string): string[] {
  const lines: string[] = [];
  const threat = threatHint(w);
  if (threat) lines.push(`【世界の脅威】${threat}`);
  const project = projectHint(w, playerId);
  if (project) lines.push(`【共同事業】${project}`);
  lines.push(`【世界目標】${worldGoalHint(w)}`);
  return lines;
}

/**
 * 他プレイヤーとの距離を、近い順に一覧にする。交渉できるかどうかも添える。
 */
export function distanceHint(w: World, playerId: string): string[] {
  const ids = Object.keys(w.players).filter((id) => id !== playerId);
  const rows = ids
    .map((id) => {
      const d = territoryDistance(w, playerId, id);
      const kind = dominantResourceOf(w, id);
      return { id, d, kind };
    })
    .filter((r): r is { id: string; d: number; kind: Resource | null } => r.d !== null)
    .sort((a, b) => a.d - b.d);

  return rows.map((r) => {
    const kindLabel = r.kind ? RESOURCE_JA[r.kind] : "不明";
    const inRange = r.d <= effectiveTradeRange(w, playerId, r.id);
    return `${r.id}（${kindLabel}）: ${r.d}マス ・ ${inRange ? "交渉可能" : "範囲外"}`;
  });
}
