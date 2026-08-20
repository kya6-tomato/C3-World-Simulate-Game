import type {
  World,
  Command,
  Player,
  PlayerStats,
  Contract,
  LandOffer,
  Resource,
  Stock,
  Tile,
  WorldProject,
} from "./types.ts";
import { RESOURCE_JA, RESOURCES } from "./types.ts";
import { Rng, turnSeed } from "./rng.ts";
import { CONFIG } from "./config.ts";
import { tileAt, neighbors } from "./worldgen.ts";

/**
 * ゲームの心臓部。1ターン分を処理する。
 *
 * 大事な性質:
 *  - 同じ world と同じ commands を渡せば、何度やっても必ず同じ結果になる。
 *  - GitHubのことを一切知らない。ただのデータ変換。
 *    だから手元で1秒に何十ターンも回して検証できる。
 *
 * 処理の順番（この順番自体がルール）:
 *   1. 生産    2. 維持費   3. 契約の自動執行   4. 命令の解決   5. 信用の回復
 */
export function resolveTurn(world: World, commands: Command[]): World {
  const w = structuredClone(world); // 元のデータは壊さない
  w.log = [];
  const rng = new Rng(turnSeed(CONFIG.simSeed, w.turn));

  ensurePlayerDefaults(w);
  produce(w);
  triggerDisasters(w, rng);
  provideRelief(w, rng);
  provideUnderdogBonus(w, rng);
  resolveWorldThreat(w, rng);
  resolveWorldProject(w, rng);
  resolveFactionBattle(w, rng);
  upkeep(w);
  executeContracts(w);
  applyCommands(w, commands, rng);
  resolveWorldGoal(w, rng);
  checkAchievements(w);
  recoverTrust(w);
  clampAllStocks(w);

  w.turn += 1;
  return w;
}

/**
 * 称号（実績）まわりのフィールドは後から追加したので、それより前に
 * 作られたセーブデータには無いことがある。無ければここで初期化する。
 */
function ensurePlayerDefaults(w: World) {
  if (w.threat === undefined) w.threat = null;
  if (!Array.isArray(w.projects)) {
    // 古いセーブデータは単数形の project フィールドだった（同時に1つしか
    // 進行できなかった頃の名残）。配列に移行し、進行中のものがあれば引き継ぐ。
    const legacy = (w as unknown as { project?: WorldProject | null }).project;
    w.projects = legacy ? [legacy] : [];
  }
  if (w.faction === undefined) w.faction = null;
  // 世界目標の初期化は resolveWorldGoal 側で行う（種類ごとに現在値を見て決めるため）。
  for (const p of Object.values(w.players)) {
    if (!p.stats) p.stats = {} as PlayerStats;
    const s = p.stats!;
    s.tradeExecutions ??= 0;
    s.aidsSent ??= 0;
    s.disastersSurvived ??= 0;
    s.bridgesBuilt ??= 0;
    s.seizesDone ??= 0;
    s.seizedByOthers ??= 0;
    s.passCount ??= 0;
    s.breaksDone ??= 0;
    s.landOffersAccepted ??= 0;
    s.landOffersGiven ??= 0;
    s.harvestsDone ??= 0;
    s.minTrustEver ??= p.trust;
    s.totalAidGiven ??= 0;
    s.worstScoreRatioEver ??= 1;
    s.totalThreatContribution ??= 0;
    s.threatsRepelled ??= 0;
    s.totalExported ??= 0;
    s.projectsBuilt ??= 0;
    s.totalFactionWagered ??= 0;
    s.totalFactionWon ??= 0;
    s.factionBattlesWon ??= 0;
    s.postsCount ??= 0;
    p.raidsUsed ??= 0;

    if (!p.achievements) p.achievements = [];
    if (!p.achievementBonus) {
      p.achievementBonus = { storage: 0, tradeRange: 0, disasterMitigation: 0, harvestBonus: 0 };
    }
  }
}

// ---------------------------------------------------------------- 1. 生産

function produce(w: World) {
  // 信用を失うと人が離れ、生産そのものが落ちる。
  // 「取引できない」だけだと、一度裏切って建ててしまえば逃げ切れる。
  // 生産に効かせることで、裏切りの代償が毎ターン続くようにする。
  const mult = (p: Player) =>
    p.trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustYieldPenalty : 1;

  for (const tile of w.tiles) {
    if (!tile.owner || tile.kind === "waste") continue;
    const p = w.players[tile.owner];
    if (!p) continue;
    const richMult = tile.rich ? CONFIG.richTileYieldMultiplier : 1;
    p.stock[tile.kind] += CONFIG.yieldPerTile * mult(p) * richMult;
  }
  // 都市は食料のみ自給する。資材と知識は土地か交易でしか手に入らない。
  for (const p of Object.values(w.players)) {
    const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);
    p.stock.food += CONFIG.cityFoodPerLevel * totalLevel * mult(p);
  }
}

/** 都市レベルの合計。都市レベルに紐づく各種報酬の計算に使う。 */
export function totalCityLevel(p: Player): number {
  return p.cities.reduce((s, c) => s + c.level, 0);
}

/**
 * 援助で送った資源の合計量から、得点への貢献分を計算する。
 * 「得点に関係ない相手を助ける理由がない」問題への対応で、
 * 見返りのない援助にも最終的な得点上のメリットを持たせている。
 */
export function aidContributionScore(p: Player): number {
  const given = p.stats?.totalAidGiven ?? 0;
  return Math.min(CONFIG.aidScoreCap, Math.floor(given / CONFIG.aidScoreDivisor));
}

/** 「世界の脅威」への貢献量から、得点への貢献分を計算する（考え方は援助と同じ）。 */
export function threatContributionScore(p: Player): number {
  const given = p.stats?.totalThreatContribution ?? 0;
  return Math.min(CONFIG.threatScoreCap, Math.floor(given / CONFIG.threatScoreDivisor));
}

/** 「共同事業」への拠出量から、得点への貢献分を計算する（考え方は援助・脅威と同じ）。 */
export function projectContributionScore(p: Player): number {
  const given = p.stats?.totalExported ?? 0;
  return Math.min(CONFIG.projectScoreCap, Math.floor(given / CONFIG.projectScoreDivisor));
}

/**
 * 「陣営戦」で勝った陣営に投入していた量から、得点への貢献分を計算する
 * （考え方は援助・脅威・事業と同じ）。負けた陣営への投入分はここに乗らない
 * （掛け捨てで終わる）。報酬が得点型でなかった陣営戦の投入分も乗らない。
 */
export function factionContributionScore(p: Player): number {
  const won = p.stats?.totalFactionWon ?? 0;
  return Math.min(CONFIG.factionScoreCap, Math.floor(won / CONFIG.factionScoreDivisor));
}

/**
 * 都市レベルと領土だけで見た、基礎の経済力。援助・脅威・事業への貢献分は含めない。
 * 劣勢かどうかの判定は、常にこちらを使う（totalScoreではない）。
 * もしtotalScore（貢献点込み）で判定すると、経済的には弱いプレイヤーが無理して
 * 援助や脅威に貢献した結果、劣勢の優遇から外れてしまう逆効果が起きるため。
 */
export function baseScore(w: World, playerId: string): number {
  const p = w.players[playerId];
  if (!p) return 0;
  const land = w.tiles.filter((t) => t.owner === playerId).length;
  return totalCityLevel(p) * 10 + land;
}

/** 得点。基礎の経済力に加えて、援助・世界の脅威・共同事業・陣営戦への貢献分も加算する。最終順位に使う。 */
export function totalScore(w: World, playerId: string): number {
  const p = w.players[playerId];
  if (!p) return 0;
  return (
    baseScore(w, playerId) +
    aidContributionScore(p) + threatContributionScore(p) + projectContributionScore(p) +
    factionContributionScore(p)
  );
}

/** 全プレイヤーの基礎経済力の平均。劣勢かどうかの判定基準に使う。 */
export function averageBaseScore(w: World): number {
  const ids = Object.keys(w.players);
  if (ids.length === 0) return 0;
  const sum = ids.reduce((s, id) => s + baseScore(w, id), 0);
  return sum / ids.length;
}

/** 全プレイヤーの得点の平均。称号「覇者」など、最終得点そのものを基準にしたい場面で使う。 */
export function averageScore(w: World): number {
  const ids = Object.keys(w.players);
  if (ids.length === 0) return 0;
  const sum = ids.reduce((s, id) => s + totalScore(w, id), 0);
  return sum / ids.length;
}

/**
 * 全員の平均基礎経済力に対して、自分の基礎経済力が一定割合を下回っているかどうか。
 * 開拓・建設コストの割引、災害の被害軽減、格差ボーナスの対象判定に使う。
 */
/** 0=通常、1=劣勢、2=危機的（劣勢よりさらに深刻）。数字が大きいほど優遇も強くなる。 */
export function underdogTier(w: World, playerId: string): 0 | 1 | 2 {
  const avg = averageBaseScore(w);
  if (avg <= 0) return 0;
  const score = baseScore(w, playerId);
  if (score < avg * CONFIG.criticalScoreRatio) return 2;
  if (score < avg * CONFIG.underdogScoreRatio) return 1;
  return 0;
}

export function isUnderdog(w: World, playerId: string): boolean {
  return underdogTier(w, playerId) >= 1;
}

/** 劣勢・危機的なプレイヤーに適用する、開拓・建設・奪うコストの割引率（通常なら0）。 */
export function underdogCostDiscount(w: World, playerId: string): number {
  const tier = underdogTier(w, playerId);
  if (tier === 2) return CONFIG.criticalCostDiscountRate;
  if (tier === 1) return CONFIG.underdogCostDiscountRate;
  return 0;
}

/**
 * 平均基礎経済力に対して、どれだけ劣勢かを0〜1の連続値で表す
 * （平均以上なら0、基礎点0なら1）。「豊かな土地」の確率など、
 * 段階（劣勢/危機的）ではなく度合いで滑らかに変えたいときに使う。
 */
export function underdogDeficitRatio(w: World, playerId: string): number {
  const avg = averageBaseScore(w);
  if (avg <= 0) return 0;
  const score = baseScore(w, playerId);
  return Math.max(0, Math.min(1, 1 - score / avg));
}

/**
 * 平均基礎点に対して、これだけ抜きん出ている（＝独走している）かどうか。
 * 「妨害」「強襲」で狙える相手かどうかの判定に使う。
 */
export function isDominant(w: World, playerId: string): boolean {
  const avg = averageBaseScore(w);
  if (avg <= 0) return false;
  return baseScore(w, playerId) >= avg * CONFIG.dominantScoreRatio;
}

/** そのプレイヤーが一番多く持っている資源（土地の種類ベース）。誰の土地も無ければ null。 */
export function dominantResourceOf(w: World, playerId: string): Resource | null {
  const counts: Record<Resource, number> = { food: 0, material: 0, knowledge: 0 };
  for (const t of w.tiles) {
    if (t.owner === playerId && t.kind !== "waste" && t.kind !== "river") {
      counts[t.kind as Resource]++;
    }
  }
  const sorted = RESOURCES.slice().sort((a, b) => counts[b] - counts[a]);
  return counts[sorted[0]] > 0 ? sorted[0] : null;
}

/**
 * 救援物資。自分では持っていない資源について、交渉範囲内にその資源を
 * 専門にしている相手が誰もいなければ、実質的に取引で手に入らないので、
 * 数ターンに1回、少しだけ自動で補給する。
 */
/**
 * 災害。低確率で誰かに発生し、資源か土地の一部を失う。
 * 都市レベルと荒地の所有数で被害を軽減できる（詰みを防ぐ最低ラインはある）。
 * 発生したことは、当事者だけでなく全員に共有する
 * （github-turn.ts 側で【災害】ログを特別扱いして全員に配信している）。
 */
function triggerDisasters(w: World, rng: Rng) {
  // ゲーム開始からしばらくは、劣勢判定に関係なく全員が災害の対象外
  // （序盤の事故は、そもそも起こさない）。
  if (w.turn < CONFIG.disasterGraceTurns) return;

  for (const p of Object.values(w.players)) {
    // 劣勢・危機的なプレイヤーは、災害そのものが起きない（追い上げの一環）。
    if (isUnderdog(w, p.id)) continue;
    if (rng.next() >= CONFIG.disasterChancePerTurn) continue;

    const wasteTiles = w.tiles.filter((t) => t.owner === p.id && t.kind === "waste").length;
    const mitigation =
      totalCityLevel(p) * CONFIG.cityLevelDisasterMitigation +
      wasteTiles * CONFIG.wasteDisasterMitigationPerTile +
      (p.achievementBonus?.disasterMitigation ?? 0);
    const severity = Math.max(CONFIG.minDisasterSeverity, CONFIG.disasterSeverity - mitigation);
    p.stats!.disastersSurvived += 1;

    if (rng.next() < 0.5) {
      // 資源の被害：一番多く持っている資源を失う
      const hitResource = RESOURCES.slice().sort((a, b) => p.stock[b] - p.stock[a])[0];
      const lost = Math.round(p.stock[hitResource] * severity);
      p.stock[hitResource] -= lost;
      w.log.push(
        `【災害】${p.id} の土地で災害が発生し、${RESOURCE_JA[hitResource]}を${lost}失った` +
          `（被害${Math.round(severity * 100)}%）。援助 ${p.id} 資源名 数 で誰でも助けられます。`,
      );
    } else {
      // 土地の被害：都市のあるマスを除いて、一部を失う
      const owned = w.tiles.filter((t) => t.owner === p.id && !hasCityAt(w, t.x, t.y));
      if (owned.length === 0) continue;
      const lossCount = Math.max(1, Math.round(owned.length * severity));
      const targets = rng.shuffle(owned).slice(0, Math.min(lossCount, owned.length));
      for (const t of targets) { t.owner = null; t.acquiredViaTrade = false; t.rich = false; }
      w.log.push(
        `【災害】${p.id} の土地で災害が発生し、${targets.length}マスを失った` +
          `（被害${Math.round(severity * 100)}%）。援助 ${p.id} 資源名 数 で誰でも助けられます。`,
      );
    }
  }
}

function provideRelief(w: World, rng: Rng) {
  const ids = Object.keys(w.players);
  const dominant = new Map(ids.map((id) => [id, dominantResourceOf(w, id)]));

  for (const id of ids) {
    const p = w.players[id];
    const mine = dominant.get(id);
    for (const r of RESOURCES) {
      if (r === mine) continue;
      // 固定周期ではなく確率で抽選する（平均すると数ターンに1回程度になる）。
      if (rng.next() >= CONFIG.reliefChancePerTurn) continue;
      const reachable = ids.some((o) => {
        if (o === id) return false;
        const d = territoryDistance(w, id, o);
        return d !== null && d <= effectiveTradeRange(w, id, o) && dominant.get(o) === r;
      });
      if (!reachable) {
        p.stock[r] += CONFIG.reliefAmount;
        w.log.push(
          `【救援物資】${id} は ${RESOURCE_JA[r]} を専門にする相手が交渉範囲内にいないため、` +
            `${RESOURCE_JA[r]}を${CONFIG.reliefAmount}受け取った。`,
        );
      }
    }
  }
}

/**
 * 平均得点より劣勢なプレイヤーに、確率で資源ボーナスを与える。
 * 発展するほど有利になる仕組み（都市Lvの恩恵・称号など）だけだと差が固定されやすいので、
 * 劣勢側にもいくつか追い上げの手段を用意している（コスト割引・災害軽減とあわせた一つ）。
 */
function provideUnderdogBonus(w: World, rng: Rng) {
  for (const p of Object.values(w.players)) {
    const tier = underdogTier(w, p.id);
    if (tier === 0) continue;
    const chance = tier === 2 ? CONFIG.criticalBonusChancePerTurn : CONFIG.underdogBonusChancePerTurn;
    const amount = tier === 2 ? CONFIG.criticalBonusAmount : CONFIG.underdogBonusAmount;
    if (rng.next() >= chance) continue;
    const r = rng.pick(RESOURCES);
    p.stock[r] += amount;
    const label = tier === 2 ? "危機的ボーナス" : "格差ボーナス";
    const desc = tier === 2 ? "特に厳しい状況が続いている" : "平均より苦戦している";
    w.log.push(`【${label}】${p.id} は${desc}ため、${RESOURCE_JA[r]}を${amount}受け取った。`);
  }
}

const WORLD_THREAT_NAMES = [
  "大寒波", "疫病", "蝗害", "干ばつ", "大嵐", "地鳴り", "飢饉", "大洪水", "深い霧", "謎の病",
];

/**
 * 世界全体を襲う「共通の敵」。個人を狙う災害とは違い、プレイヤー同士を敵味方に
 * 分けず、全員で資源を出し合って撃退する（`貢献`コマンド）だけの脅威。
 * 発生・期限切れの判定をここで行う。撃退そのものの判定は doContribute で、
 * 必要量に達した瞬間に即座に行う。
 */
/**
 * 世界の脅威の被害を1人分適用する。資源・土地・信用のどれかをランダムに選ぶ
 * （災害と同じく、いつも同じ被害だと単調になるため）。持っている土地が
 * 都市マス以外に無ければ、土地被害は資源被害に振り替える。
 */
function applyThreatDamage(w: World, p: Player, severity: number, rng: Rng): string {
  const roll = rng.next();
  const doResourceDamage = () => {
    const hitResource = RESOURCES.slice().sort((a, b) => p.stock[b] - p.stock[a])[0];
    const lost = Math.round(p.stock[hitResource] * severity);
    p.stock[hitResource] -= lost;
    return `${RESOURCE_JA[hitResource]}を${lost}失った`;
  };

  if (roll < 1 / 3) {
    return doResourceDamage();
  } else if (roll < 2 / 3) {
    const owned = w.tiles.filter((t) => t.owner === p.id && !hasCityAt(w, t.x, t.y));
    if (owned.length === 0) return doResourceDamage();
    const lossCount = Math.max(1, Math.round(owned.length * severity));
    const targets = rng.shuffle(owned).slice(0, Math.min(lossCount, owned.length));
    for (const t of targets) { t.owner = null; t.acquiredViaTrade = false; t.rich = false; }
    return `${targets.length}マスを失った`;
  } else {
    const lost = Math.round(severity * 40);
    p.trust = Math.max(CONFIG.trustMin, p.trust - lost);
    return `信用を${lost}失った`;
  }
}

function resolveWorldThreat(w: World, rng: Rng) {
  if (w.threat) {
    const threat = w.threat;
    const overdueTurns = w.turn - threat.deadlineTurn;
    if (overdueTurns >= 0) {
      // 猶予切れ。撃退できるまで、毎ターン被害が出る。経過するほど重くなる
      // （ただし上限あり）。劣勢・危機的なプレイヤーは被害が軽いが、0にはしない
      // （貢献する動機を残すため）。
      const severity = Math.min(
        CONFIG.worldThreatMaxSeverity,
        CONFIG.worldThreatBaseSeverity + overdueTurns * CONFIG.worldThreatEscalationPerTurn,
      );
      const results: string[] = [];
      for (const p of Object.values(w.players)) {
        const tier = underdogTier(w, p.id);
        const rate =
          tier === 2 ? CONFIG.worldThreatCriticalSeverityRate :
          tier === 1 ? CONFIG.worldThreatUnderdogSeverityRate : 1;
        const desc = applyThreatDamage(w, p, severity * rate, rng);
        results.push(`${p.id}が${desc}`);
      }
      w.log.push(
        `【脅威】「${threat.name}」の被害が広がっている（貢献 ${threat.contributed}/${threat.requirement}・` +
          `被害${Math.round(severity * 100)}%）: ${results.join("、")}。` +
          `\`貢献 資源名 数\` で撃退に協力できます。`,
      );
    }
    return;
  }

  if (rng.next() >= CONFIG.worldThreatChancePerTurn) return;

  const playerCount = Object.keys(w.players).length;
  const requirement = playerCount * CONFIG.worldThreatRequirementPerPlayer;
  const name = rng.pick(WORLD_THREAT_NAMES);
  w.threat = {
    id: `T${w.turn}`,
    name,
    spawnedAt: w.turn,
    deadlineTurn: w.turn + CONFIG.worldThreatDeadlineTurns,
    requirement,
    contributed: 0,
    contributions: {},
  };
  w.log.push(
    `【脅威】世界に「${name}」が現れた！ ${CONFIG.worldThreatDeadlineTurns}ターン以内に、みんなで合計${requirement}の` +
      `資源を集めて撃退しないと被害が出始める（撃退できるまで、被害は毎ターン少しずつ重くなる）。` +
      `\`貢献 資源名 数\` で誰でも協力できる。`,
  );
}

/**
 * 世界目標（プラス版の共通目標）の種類。脅威と違って罰は無く、みんなが
 * 普通にプレイしているだけで自然と進む、いろいろな世界全体の合計値を見ている。
 * 1つ達成すると、また別の種類がランダムで選ばれる（序盤から狙えるものもある）。
 */
const WORLD_GOAL_TYPES: {
  key: string;
  label: string;
  step: number;
  metric: (w: World) => number;
}[] = [
  {
    key: "cityLevel",
    label: "世界全体の都市レベル合計",
    step: 40,
    metric: (w) => Object.values(w.players).reduce((s, p) => s + totalCityLevel(p), 0),
  },
  {
    key: "land",
    label: "世界全体の領土合計",
    step: 60,
    metric: (w) => w.tiles.filter((t) => t.owner !== null).length,
  },
  {
    key: "trades",
    label: "世界全体の取引成立回数の合計",
    step: 15,
    metric: (w) => Object.values(w.players).reduce((s, p) => s + (p.stats?.tradeExecutions ?? 0), 0),
  },
  {
    key: "harvests",
    label: "世界全体の資源回収の合計回数",
    step: 15,
    metric: (w) => Object.values(w.players).reduce((s, p) => s + (p.stats?.harvestsDone ?? 0), 0),
  },
];

function currentWorldGoalType(w: World) {
  return WORLD_GOAL_TYPES.find((t) => t.key === w.worldGoalType) ?? WORLD_GOAL_TYPES[0];
}

/**
 * その種類の「到達幅」の、値のすぐ上にある倍数を返す（例: 到達幅40で値が15なら40、
 * 値が40ちょうどなら80）。ルールブックに書いてある到達幅の数字が、そのまま
 * 到達ラインとして表示されるようにするための固定の節目。「今の値＋到達幅」の
 * ような、切り替わったタイミング次第で変わる半端な数字にはしない。
 */
function nextGoalMultiple(value: number, step: number): number {
  return (Math.floor(value / step) + 1) * step;
}

/**
 * 現在の世界目標の状態（表示用）: ラベル・現在値・次の到達ライン。
 * 世界目標は種類が複数あって達成のたびに切り替わるので、表示側で
 * 種類を知らなくてもこの1関数を呼べば正しい内容が取れるようにしてある。
 */
export function worldGoalProgress(w: World): { label: string; current: number; threshold: number } {
  const type = currentWorldGoalType(w);
  const current = type.metric(w);
  return {
    label: type.label,
    current,
    threshold: w.worldGoalNextThreshold ?? nextGoalMultiple(current, type.step),
  };
}

/**
 * 世界目標（プラス版の共通目標）。脅威と違って罰は無く、みんなが普通に
 * プレイしていく中で、いろいろな世界全体の合計値が育っていくだけで、
 * 時々全員に資源が贈られる。専用のコマンドは無い、完全に受け身の仕組み。
 */
function resolveWorldGoal(w: World, rng: Rng) {
  if (!w.worldGoalType) w.worldGoalType = WORLD_GOAL_TYPES[0].key;
  let type = currentWorldGoalType(w);
  if (w.worldGoalNextThreshold === undefined) {
    w.worldGoalNextThreshold = nextGoalMultiple(type.metric(w), type.step);
  }

  while (type.metric(w) >= (w.worldGoalNextThreshold ?? type.step)) {
    const threshold = w.worldGoalNextThreshold!;
    for (const p of Object.values(w.players)) {
      for (const r of RESOURCES) p.stock[r] += CONFIG.worldGoalRewardAmount;
    }
    w.log.push(
      `【世界目標】「${type.label}」が${threshold}に到達した！ 全員に資源が各+${CONFIG.worldGoalRewardAmount}贈られた。`,
    );
    // 次の世界目標は、種類ごとランダムに選び直す（同じ種類が続くこともある）。
    type = rng.pick(WORLD_GOAL_TYPES);
    w.worldGoalType = type.key;
    w.worldGoalNextThreshold = nextGoalMultiple(type.metric(w), type.step);
  }
}

/**
 * 共同事業の種類。完成すると全員にどんな恩恵が入るかが種類によって変わる。
 * 名前は、複数の共同事業が同時進行しているときに「輸出」でどれに送るかを
 * 指定する識別子としても使う（コメントパーサー側でも参照するため export する）。
 */
export const WORLD_PROJECT_TYPES: {
  name: string;
  rewardKind: "tradeRange" | "storage" | "disasterMitigation" | "harvestBonus";
  rewardAmount: number;
  rewardDesc: string;
}[] = [
  { name: "灯台", rewardKind: "tradeRange", rewardAmount: 1, rewardDesc: "取引可能距離+1" },
  { name: "見張り塔", rewardKind: "disasterMitigation", rewardAmount: 0.03, rewardDesc: "災害の被害軽減+3%" },
  { name: "大穀倉", rewardKind: "storage", rewardAmount: 10, rewardDesc: "保管上限+10" },
  { name: "共同工房", rewardKind: "harvestBonus", rewardAmount: 1, rewardDesc: "回収量+1" },
];

/**
 * 共同事業。世界のどこかの空き地に、みんなで資源を出し合う建設プロジェクトが
 * 時々現れる。脅威と違って罰は無い（現れなくても何も起きない）。資源は
 * `輸出` で誰でも送れるが、実際に着工できるのは現地（隣接地）を持つ人だけ。
 */
function resolveWorldProject(w: World, rng: Rng) {
  // 世界の脅威・陣営戦と違い、共同事業は同時に複数進行できる。
  // ただし際限なく積み上がらないよう、同時進行数に上限を設ける。
  if (w.projects!.length >= CONFIG.projectMaxConcurrent) return;

  if (rng.next() >= CONFIG.projectChancePerTurn) return;

  // 既に他の共同事業の建設地になっているマスは、候補から除く。
  const usedSites = new Set(w.projects!.map((pr) => `${pr.x},${pr.y}`));
  const isFree = (t: Tile) => t.owner === null && !usedSites.has(`${t.x},${t.y}`);
  const wasteCandidates = w.tiles.filter((t) => t.kind === "waste" && isFree(t));
  const pool = wasteCandidates.length > 0 ? wasteCandidates : w.tiles.filter(isFree);
  if (pool.length === 0) return; // 空き地が無ければ発生させない

  const site = rng.pick(pool);
  const playerCount = Object.keys(w.players).length;
  const requirement = playerCount * CONFIG.projectRequirementPerPlayer;
  // 複数の共同事業が同時進行しているときは名前で見分けるので、既に進行中の
  // 種類と名前が被らないものだけから選ぶ（種類数 > 同時上限なので必ず選べる）。
  const activeNames = new Set(w.projects!.map((pr) => pr.name));
  const availableTypes = WORLD_PROJECT_TYPES.filter((t) => !activeNames.has(t.name));
  const type = rng.pick(availableTypes.length > 0 ? availableTypes : WORLD_PROJECT_TYPES);
  const project: WorldProject = {
    id: `P${w.turn}`,
    name: type.name,
    rewardKind: type.rewardKind,
    rewardAmount: type.rewardAmount,
    rewardDesc: type.rewardDesc,
    x: site.x,
    y: site.y,
    spawnedAt: w.turn,
    requirement,
    pooled: 0,
    contributions: {},
    ready: false,
  };
  w.projects!.push(project);
  w.log.push(
    `【事業】(${site.x},${site.y}) で「${type.name}」の建設地が見つかった！（完成すると全員に${type.rewardDesc}） ` +
      `合計${requirement}の資源が集まれば、現地（隣接地）を持つ人が着工できる。\`輸出 資源名 数\` で誰でも資源を送って協力できる。`,
  );
}

const FACTION_BATTLE_NAMES = [
  "覇権争い", "資源争奪戦", "威信をかけた競り合い", "陣取り合戦", "意地の張り合い", "国境紛争",
];

/** 陣営戦の勝利報酬の種類。発生のたびにランダムに決まる。 */
const FACTION_REWARD_TYPES: { key: "score" | "resource" | "trust"; label: string }[] = [
  { key: "score", label: "得点への貢献" },
  { key: "resource", label: "資源" },
  { key: "trust", label: "信用" },
];

/**
 * 全員を陣営A・Bに振り分ける。実力（基礎点）が偏らないように、
 * 基礎点が高い順に並べてからスネークドラフト（A→B→B→A→A→B…）で割り振る。
 * 同点の場合の並びが常に同じにならないよう、ソート前にシャッフルしておく。
 */
function assignFactions(w: World, rng: Rng): Record<string, "A" | "B"> {
  const shuffled = rng.shuffle(Object.keys(w.players));
  const sorted = shuffled
    .slice()
    .sort((a, b) => baseScore(w, b) - baseScore(w, a));

  const members: Record<string, "A" | "B"> = {};
  for (let i = 0; i < sorted.length; i++) {
    const roundEven = Math.floor(i / 2) % 2 === 0;
    const firstOfPair = i % 2 === 0;
    const label: "A" | "B" = roundEven === firstOfPair ? "A" : "B";
    members[sorted[i]] = label;
  }
  return members;
}

/**
 * 陣営戦。世界の脅威・共同事業とは別の、プレイヤー同士が2陣営に分かれて
 * 競い合うイベント。参加は任意で、投入しなければ何も損しない（降りる＝
 * ノーリスク・ノーリターン）。投入した資源は勝敗に関わらずその場で消費
 * される（掛け捨て）。勝った陣営で実際に投入した人だけが、投入量に応じた
 * 報酬を受け取る。
 */
function resolveFactionBattle(w: World, rng: Rng) {
  if (w.faction) {
    const battle = w.faction;
    if (w.turn < battle.deadlineTurn) return; // まだ決着ターンではない

    if (battle.pooled.A === battle.pooled.B) {
      w.log.push(
        `【陣営戦】「${battle.name}」は陣営A・Bともに投入量${battle.pooled.A}で引き分けに終わった。投入した資源は戻らない。`,
      );
      w.faction = null;
      return;
    }

    const winnerLabel: "A" | "B" = battle.pooled.A > battle.pooled.B ? "A" : "B";
    const winnerIds = Object.entries(battle.members)
      .filter(([, label]) => label === winnerLabel)
      .map(([pid]) => pid)
      .filter((pid) => (battle.contributions[pid] ?? 0) > 0);

    const results: string[] = [];
    for (const pid of winnerIds) {
      const player = w.players[pid];
      if (!player) continue;
      const amount = battle.contributions[pid] ?? 0;
      player.stats!.factionBattlesWon += 1;

      if (battle.rewardKind === "score") {
        player.stats!.totalFactionWon += amount;
        results.push(`${pid}(投入${amount}が得点に)`);
      } else if (battle.rewardKind === "resource") {
        const gained = Math.round(amount * CONFIG.factionResourceRate);
        const each = Math.max(0, Math.round(gained / RESOURCES.length));
        for (const r of RESOURCES) player.stock[r] += each;
        results.push(`${pid}(資源各+${each})`);
      } else {
        const gained = Math.min(CONFIG.factionTrustCap, Math.round(amount * CONFIG.factionTrustRate));
        player.trust = Math.min(CONFIG.trustMax, player.trust + gained);
        results.push(`${pid}(信用+${gained})`);
      }
    }

    w.log.push(
      `【陣営戦】「${battle.name}」は陣営${winnerLabel}の勝利（${battle.pooled.A} 対 ${battle.pooled.B}）！ ` +
        `勝った陣営で投入していた人には${battle.rewardDesc}が贈られた: ` +
        `${results.length > 0 ? results.join("、") : "（投入していた人がいなかった）"}。`,
    );
    w.faction = null;
    return;
  }

  if (rng.next() >= CONFIG.factionChancePerTurn) return;

  const ids = Object.keys(w.players);
  if (ids.length < 2) return; // 2人未満では陣営が組めない

  const members = assignFactions(w, rng);
  const name = rng.pick(FACTION_BATTLE_NAMES);
  const type = rng.pick(FACTION_REWARD_TYPES);

  w.faction = {
    id: `F${w.turn}`,
    name,
    spawnedAt: w.turn,
    deadlineTurn: w.turn + CONFIG.factionDeadlineTurns,
    rewardKind: type.key,
    rewardDesc: type.label,
    members,
    pooled: { A: 0, B: 0 },
    contributions: {},
  };

  const teamA = Object.entries(members).filter(([, l]) => l === "A").map(([pid]) => pid);
  const teamB = Object.entries(members).filter(([, l]) => l === "B").map(([pid]) => pid);

  w.log.push(
    `【陣営戦】世界が陣営A・Bに分かれて競い合う「${name}」が始まった！ ` +
      `陣営A: ${teamA.join("、")} / 陣営B: ${teamB.join("、")}。` +
      `${CONFIG.factionDeadlineTurns}ターン以内に、より多く資源を投入した陣営の勝ち。` +
      `\`賭ける 資源名 数\` で投入できる（勝っても負けても投入した資源は戻らない。投入しなければノーリスク）。` +
      `勝った陣営で投入していた人には、投入量に応じて${type.label}が贈られる。`,
  );
}

// ------------------------------------------------------------- 2. 維持費

function upkeep(w: World) {
  for (const p of Object.values(w.players)) {
    const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);
    const cost =
      CONFIG.upkeepPerCityLevel * totalLevel +
      CONFIG.upkeepGrowthPerLevel * totalLevel * totalLevel;
    p.stock.food -= cost;
    if (p.stock.food < 0) {
      // 食料が尽きたら都市が縮む（飢餓）
      p.stock.food = 0;
      const biggest = p.cities.slice().sort((a, b) => b.level - a.level)[0];
      if (biggest && biggest.level > 1) {
        biggest.level -= 1;
        w.log.push(`【飢餓】${p.id} は食料が尽き、都市が縮小した。`);
      }
    }
  }
}

// --------------------------------------------------- 3. 契約の自動執行

/**
 * 進行中の契約1件ぶんの資源交換を実行する。払えなければ不履行にする。
 * 毎ターンの一括処理（executeContracts）と、承諾したその場での1回目の
 * 取引（doAccept）の両方から呼ぶ共通処理。
 */
function settleContract(w: World, c: Contract) {
  const from = w.players[c.from];
  const to = w.players[c.to];
  if (!from || !to) return;

  const fromCanPay = from.stock[c.give] >= c.giveAmount;
  const toCanPay = to.stock[c.take] >= c.takeAmount;

  if (!fromCanPay || !toCanPay) {
    // 払えなかった側が不履行。信用が下がる。
    const guilty = !fromCanPay ? from : to;
    c.status = "defaulted";
    guilty.trust += CONFIG.trustOnDefault;
    w.log.push(
      `【不履行】${guilty.id} は契約 ${c.id} の支払いができず、契約が失効した。`,
    );
    return;
  }

  from.stock[c.give] -= c.giveAmount;
  to.stock[c.give] += c.giveAmount;
  to.stock[c.take] -= c.takeAmount;
  from.stock[c.take] += c.takeAmount;

  // 約束通り払えた回は、両者に少しだけ信用を返す。裏切りだけが罰され、
  // 守り続けても何も報われないのは不公平なため。
  from.trust += CONFIG.trustOnFulfill;
  to.trust += CONFIG.trustOnFulfill;
  from.stats!.tradeExecutions += 1;
  to.stats!.tradeExecutions += 1;

  c.turnsLeft -= 1;
  if (c.turnsLeft <= 0) {
    c.status = "expired";
    w.log.push(`【満了】${c.from} と ${c.to} の契約 ${c.id} が正常に完了した。`);
  }
}

function executeContracts(w: World) {
  // 返事のない提案を失効させる。これがないと交渉が詰まる。
  for (const c of w.contracts) {
    if (c.status !== "proposed") continue;
    if (w.turn - c.proposedAt >= CONFIG.offerExpiryTurns) {
      c.status = "expired";
    }
  }
  for (const lo of w.landOffers) {
    if (lo.status !== "proposed") continue;
    if (w.turn - lo.proposedAt >= CONFIG.offerExpiryTurns) {
      lo.status = "expired";
    }
  }

  for (const c of w.contracts) {
    if (c.status !== "active") continue;
    settleContract(w, c);
  }
}

// ------------------------------------------------------- 4. 命令の解決

/** 手番を消費する命令（経済行動）。1ターンに1つだけ。 */
const ECONOMIC = new Set(["expand", "build", "seize", "pass", "harvest", "bridge", "commence", "block", "raid"]);

function applyCommands(w: World, commands: Command[], rng: Rng) {
  // 外交（提案・承諾・破棄）は手番を消費しない。何度でも行える。
  //
  // ここは重要な設計判断。交渉に手番を使わせると、
  // 「交渉するほど開発が遅れる」ことになり、
  // 交易型が孤立型に負ける。実測でそうなった。
  // 外交を無料にすることで、初めて「話し合う人が強い」ゲームになる。
  const diplomacy = commands.filter((c) => !ECONOMIC.has(c.type));

  // 経済行動はプレイヤーごとに最初の1つだけ採用する。
  const economic: Command[] = [];
  const used = new Set<string>();
  for (const c of commands) {
    if (!ECONOMIC.has(c.type)) continue;
    if (used.has(c.player)) continue;
    used.add(c.player);
    economic.push(c);

    // 自分で選んだ経済行動は「いつもの行動」として覚える。次に何も
    // 書かなかったときは、これが自動で続く（奪うは一回きりの行動なので対象外）。
    const p = w.players[c.player];
    if (p && (c.type === "build" || c.type === "expand" || c.type === "pass")) {
      p.standing = c.type;
      // 開拓の資源優先指定も一緒に覚える。指定がなければ（undefined）、
      // 前回までの指定は消えて「一番多い資源から」に戻る。
      p.standingResource = c.type === "expand" ? c.preferResource : undefined;
    }
  }
  // 経済行動を出さなかった人は、常設命令で自動的に補う。
  const autoFilled = new Set<string>();
  for (const p of Object.values(w.players)) {
    if (used.has(p.id)) continue;
    autoFilled.add(p.id);
    const auto: Command =
      p.standing === "expand"
        ? { type: "expand", player: p.id, preferResource: p.standingResource }
        : ({ type: p.standing, player: p.id } as Command);
    economic.push(auto);
  }

  // 外交を先に解決してから経済行動。順番の有利不利はシャッフルで消す。
  for (const cmd of [...rng.shuffle(diplomacy), ...rng.shuffle(economic)]) {
    const p = w.players[cmd.player];
    if (!p) continue;
    const isAuto = autoFilled.has(cmd.player);

    switch (cmd.type) {
      case "expand": {
        const ok = doExpand(w, p, rng, cmd.preferResource, cmd.target, cmd.payment);
        // 何も書かなかった人がたまたま開拓できないときは、建設できないか代わりに試す。
        // 「せっかくの自動継続が毎回空振りになる」のを避けるため。
        if (!ok && isAuto) doBuild(w, p);
        break;
      }
      case "build": {
        const ok = doBuild(w, p);
        if (!ok && isAuto) doExpand(w, p, rng);
        break;
      }
      case "offer": doOffer(w, p, cmd); break;
      case "accept": doAccept(w, p, cmd.contractId); break;
      case "break": doBreak(w, p, cmd.contractId); break;
      case "reject": doReject(w, p, cmd.contractId); break;
      case "offerLand": doOfferLand(w, p, cmd); break;
      case "acceptLand": doAcceptLand(w, p, cmd.landOfferId); break;
      case "rejectLand": doRejectLand(w, p, cmd.landOfferId); break;
      case "seize": doSeize(w, p, cmd); break;
      case "harvest": doHarvest(w, p, cmd.resource); break;
      case "bridge": doBridge(w, p, cmd.x, cmd.y, rng); break;
      case "aid": doAid(w, p, cmd); break;
      case "contribute": doContribute(w, p, cmd); break;
      case "export": doExport(w, p, cmd); break;
      case "commence": doCommence(w, p); break;
      case "post": doPost(w, p, cmd); break;
      case "wager": doWager(w, p, cmd); break;
      case "block": doBlock(w, p, cmd); break;
      case "raid": doRaid(w, p, cmd); break;
      case "pass": p.stats!.passCount += 1; break;
    }
  }
}

function canAfford(stock: Stock, cost: Partial<Stock>): boolean {
  return RESOURCES.every((r) => stock[r] >= (cost[r] ?? 0));
}

function pay(stock: Stock, cost: Partial<Stock>) {
  for (const r of RESOURCES) stock[r] -= cost[r] ?? 0;
}

/** 実行できたら true を返す（何も書かなかった人の自動フォールバックの判定に使う）。 */
function doExpand(
  w: World,
  p: Player,
  rng: Rng,
  preferResource?: Resource,
  manualTarget?: { x: number; y: number },
  manualPayment?: Partial<Record<Resource, number>>,
): boolean {
  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = expandCostTotal(owned, totalCityLevel(p), underdogCostDiscount(w, p.id));

  // 自分の領土に隣接している、誰のものでもないマスを集める
  // （自動選択の候補集めにも、指定マスの隣接チェックにも使う）。
  // 荒地は資源こそ採れないが、保管上限や災害対策になるので開拓の対象にできる。
  // 川だけは橋を架けない限り越えられない。
  // 取引（土地提案の承諾）で手に入れたマスは、開拓の起点として使えない
  // （自分で開拓・橋・着工などで育てた領土からしか広げられない）。
  // 「妨害」で一時的にブロックされているマスは、誰も（妨害した本人も）取得できない。
  const isBlocked = (t: Tile) => (t.blockedUntilTurn ?? 0) > w.turn;

  const candidates: Tile[] = [];
  for (const t of w.tiles) {
    if (t.owner !== p.id || t.acquiredViaTrade) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "river" && !isBlocked(nt))
        candidates.push(nt);
    }
  }

  let target: Tile;
  if (manualTarget) {
    const t = tileAt(w.tiles, w.width, manualTarget.x, manualTarget.y);
    if (!t) {
      w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) が盤面の外なので開拓できなかった。`);
      return false;
    }
    if (t.owner !== null) {
      w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) が既に${t.owner}の土地なので開拓できなかった。`);
      return false;
    }
    if (t.kind === "river") {
      w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) は川なので開拓できなかった（橋が必要）。`);
      return false;
    }
    if (isBlocked(t)) {
      w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) が「妨害」で一時的に取得できないため、開拓できなかった。`);
      return false;
    }
    if (!candidates.includes(t)) {
      const adjacentToTradedOnly = neighbors(t.x, t.y, w.width, w.height).some((n) => {
        const nt = tileAt(w.tiles, w.width, n.x, n.y);
        return nt && nt.owner === p.id && nt.acquiredViaTrade;
      });
      if (adjacentToTradedOnly) {
        w.log.push(
          `${p.id} は (${manualTarget.x},${manualTarget.y}) の隣は取引で手に入れた土地だけなので開拓できなかった` +
            `（開拓は、自分で開拓・橋・着工などで広げた土地からしかできません）。`,
        );
      } else {
        w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) が自分の土地に隣接していないので開拓できなかった。`);
      }
      return false;
    }
    target = t;
  } else {
    if (candidates.length === 0) {
      w.log.push(`${p.id} は開拓できる土地がなかった。`);
      return false;
    }
    // 一番足りていない資源のマスを優先して取る
    const scarcest = scarcestResource(p.stock);
    const preferred = candidates.filter((t) => t.kind === scarcest);
    target = rng.pick(preferred.length > 0 ? preferred : candidates);
  }

  if (manualPayment) {
    const total = RESOURCES.reduce((s, r) => s + (manualPayment[r] ?? 0), 0);
    if (total !== cost) {
      w.log.push(
        `${p.id} は指定した支払いの合計が${total}で、必要な${cost}と合わないので開拓できなかった。`,
      );
      return false;
    }
    if (!canAfford(p.stock, manualPayment)) {
      w.log.push(`${p.id} は指定した資源が足りず開拓できなかった。`);
      return false;
    }
    pay(p.stock, manualPayment);
  } else {
    if (totalStock(p.stock) < cost) {
      w.log.push(`${p.id} は資源が足りず開拓できなかった（要 合計${cost}）。`);
      return false;
    }
    payAny(p.stock, cost, preferResource);
  }

  target.owner = p.id;
  target.acquiredViaTrade = false;
  // 前の持ち主が災害等で失った土地の「豊かな土地」フラグが、抽選もせず
  // そのまま次の開拓者に引き継がれてしまわないよう、いったんリセットする。
  target.rich = false;
  const kindLabel = target.kind === "waste" ? "荒地" : RESOURCE_JA[target.kind as Resource];

  // 劣勢なプレイヤーほど、開拓したマスが「豊かな土地」になる確率が上がる
  // （平均以上なら確率0）。荒地は産出が無いので対象外。
  let richNote = "";
  if (target.kind !== "waste") {
    const chance = underdogDeficitRatio(w, p.id) * CONFIG.richTileChanceMax;
    if (chance > 0 && rng.next() < chance) {
      target.rich = true;
      richNote = `！掘り当てたのは資源量${CONFIG.richTileYieldMultiplier}倍の「豊かな土地」だった`;
    }
  }

  w.log.push(
    `${p.id} が (${target.x},${target.y}) を開拓した [${kindLabel}]${richNote}。`,
  );
  return true;
}

/** 実行できたら true を返す（何も書かなかった人の自動フォールバックの判定に使う）。 */
function doBuild(w: World, p: Player): boolean {
  const city = p.cities
    .slice()
    .sort((a, b) => a.level - b.level)
    .find((c) => c.level < CONFIG.maxCityLevel);
  if (!city) {
    w.log.push(`${p.id} の都市はすべて最大レベル。`);
    return false;
  }
  const cost = buildCostFor(city.level + 1, p.trust, underdogCostDiscount(w, p.id));
  if (!canAfford(p.stock, cost)) {
    // 資源が足りず建設できなかっただけなら記録しない。
    // 常設命令が「建設」の人は資源が貯まるまで毎ターンここに来るので、
    // 逐一記録すると失敗の羅列で埋め尽くされてしまう。
    return false;
  }
  pay(p.stock, cost);
  city.level += 1;
  w.log.push(`${p.id} が都市を Lv${city.level} に発展させた。`);
  return true;
}

function doOffer(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "offer" }>,
) {
  if (!w.players[cmd.to] || cmd.to === p.id) return;

  // 信用を失った者は交渉のテーブルにつけない
  if (p.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用が低すぎて（${p.trust}）誰とも契約できない。`);
    return;
  }

  // 遠すぎる相手とは契約できない。人間関係を近所に閉じ込めるための制限。
  const d = territoryDistance(w, p.id, cmd.to);
  const range = effectiveTradeRange(w, p.id, cmd.to);
  if (d === null || d > range) {
    w.log.push(`${p.id} は ${cmd.to} まで遠すぎて交渉できない（距離${d}、範囲${range}）。`);
    return;
  }
  // 継続期間に下限・上限を設ける。下限が無いと、ごく少量・1ターンだけの
  // 契約を大量の相手と結んで「取引相手の数」系の称号をノーリスクで
  // 稼げてしまう。上限が無いと、1つ結ぶだけで以後は何もしなくても
  // 毎ターン自動で「取引成立」の回数だけが積み上がってしまう。
  // （金額そのものには下限を設けない。細かい金額の駆け引きを妨げないため）
  if (cmd.turns < CONFIG.offerMinTurns || cmd.turns > CONFIG.offerMaxTurns) {
    w.log.push(
      `${p.id} は提案する期間が範囲外（${CONFIG.offerMinTurns}〜${CONFIG.offerMaxTurns}ターン）のため、提案できなかった。`,
    );
    return;
  }
  const id = `C${w.turn}-${p.id}-${w.contracts.length}`;
  const contract: Contract = {
    id,
    from: p.id,
    to: cmd.to,
    give: cmd.give,
    giveAmount: cmd.giveAmount,
    take: cmd.take,
    takeAmount: cmd.takeAmount,
    turnsLeft: cmd.turns,
    proposedAt: w.turn,
    status: "proposed",
  };
  w.contracts.push(contract);
  w.log.push(
    `${p.id} が ${cmd.to} に提案 [\`${id}\`]: ` +
      `${RESOURCE_JA[cmd.give]}${cmd.giveAmount}を渡す代わりに、` +
      `${RESOURCE_JA[cmd.take]}${cmd.takeAmount}をもらう（毎ターン・${cmd.turns}ターン間）`,
  );
}

function doAccept(w: World, p: Player, contractId: string) {
  const c = w.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== "proposed") return;
  if (c.to !== p.id) return; // 自分宛て以外は承諾できない
  const proposer = w.players[c.from];
  if (p.trust < CONFIG.tradeBlockedBelow) return;
  if (proposer && proposer.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用のない ${c.from} との契約を拒否した。`);
    c.status = "broken";
    return;
  }
  c.status = "active";
  w.log.push(
    `${p.id} が ${c.from} の契約 [\`${c.id}\`] を承諾した。取引が始まる: ` +
      `${p.id}は${RESOURCE_JA[c.give]}${c.giveAmount}をもらい、` +
      `${RESOURCE_JA[c.take]}${c.takeAmount}を渡す（毎ターン・${c.turnsLeft}ターン間）。`,
  );
  settleContract(w, c); // 承諾したその場で1回目の取引を行う
}

/** 自分宛ての提案を、期限切れを待たずにその場で断る。手番は消費しない。 */
function doReject(w: World, p: Player, contractId: string) {
  const c = w.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== "proposed") return;
  if (c.to !== p.id) return; // 自分宛て以外は拒否できない
  c.status = "declined";
  w.log.push(`${p.id} が ${c.from} からの提案 [\`${c.id}\`] を断った。`);
}

function doBreak(w: World, p: Player, contractId: string) {
  const c = w.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== "active") return;
  if (c.from !== p.id && c.to !== p.id) return;
  c.status = "broken";
  p.trust += CONFIG.trustOnBreak;
  p.stats!.breaksDone += 1;
  const otherId = c.from === p.id ? c.to : c.from;
  const other = w.players[otherId];

  // 違約金。破った側が、約束していた分を残り期間ぶん相手に払う。
  // 信用の低下は「将来の損」だが、これは「今すぐの損」。
  // 破棄が短期的にも割に合わないようにするための仕組み。
  if (other) {
    const turns = Math.min(c.turnsLeft, CONFIG.breachPenaltyMaxTurns);
    const owed = c.from === p.id ? c.give : c.take;
    const amount = Math.round(
      (c.from === p.id ? c.giveAmount : c.takeAmount) *
        turns *
        CONFIG.breachPenaltyRate,
    );
    const paid = Math.min(amount, p.stock[owed]);
    p.stock[owed] -= paid;
    other.stock[owed] += paid;
    w.log.push(
      `【破棄】${p.id} が ${otherId} との契約を一方的に破棄。違約金 ${RESOURCE_JA[owed]}${paid} を支払った。`,
    );
  }
}

/** そのマスに、誰かの都市が建っているか。 */
function hasCityAt(w: World, x: number, y: number): boolean {
  return Object.values(w.players).some((pl) =>
    pl.cities.some((c) => c.x === x && c.y === y),
  );
}

function doOfferLand(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "offerLand" }>,
) {
  if (!w.players[cmd.to] || cmd.to === p.id) return;

  const tile = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!tile || tile.owner !== p.id) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) を持っていないので提案できない。`);
    return;
  }
  if (hasCityAt(w, cmd.x, cmd.y)) {
    w.log.push(`${p.id} は自分の都市があるマスは譲れない。`);
    return;
  }
  // 信用を失った者は交渉のテーブルにつけない（資源の取引と同じ扱い）
  if (p.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用が低すぎて（${p.trust}）誰とも取引できない。`);
    return;
  }
  const d = territoryDistance(w, p.id, cmd.to);
  const range = effectiveTradeRange(w, p.id, cmd.to);
  if (d === null || d > range) {
    w.log.push(`${p.id} は ${cmd.to} まで遠すぎて土地の話ができない（距離${d}、範囲${range}）。`);
    return;
  }

  const id = `L${w.turn}-${p.id}-${w.landOffers.length}`;
  let offer: LandOffer;
  let wantDesc: string;

  if (cmd.wantX !== undefined && cmd.wantY !== undefined) {
    // 土地と土地の交換。相手が今その土地を持っているかを提案時点でも確認しておく
    // （承諾できない提案を出させないため。最終確認は承諾時にもう一度行う）。
    const wantTile = tileAt(w.tiles, w.width, cmd.wantX, cmd.wantY);
    if (!wantTile || wantTile.owner !== cmd.to) {
      w.log.push(`${p.id} は ${cmd.to} が (${cmd.wantX},${cmd.wantY}) を持っていないので提案できない。`);
      return;
    }
    if (hasCityAt(w, cmd.wantX, cmd.wantY)) {
      w.log.push(`${p.id} は ${cmd.to} の都市があるマスは要求できない。`);
      return;
    }
    offer = {
      id, from: p.id, to: cmd.to, x: cmd.x, y: cmd.y,
      wantX: cmd.wantX, wantY: cmd.wantY,
      proposedAt: w.turn, status: "proposed",
    };
    wantDesc = `土地 (${cmd.wantX},${cmd.wantY})`;
  } else if (cmd.wantResource !== undefined && cmd.wantAmount !== undefined) {
    offer = {
      id, from: p.id, to: cmd.to, x: cmd.x, y: cmd.y,
      wantResource: cmd.wantResource, wantAmount: cmd.wantAmount,
      proposedAt: w.turn, status: "proposed",
    };
    wantDesc = `${RESOURCE_JA[cmd.wantResource]}${cmd.wantAmount}`;
  } else {
    return;
  }

  w.landOffers.push(offer);
  w.log.push(
    `${p.id} が ${cmd.to} に土地 (${cmd.x},${cmd.y}) を提案 [\`${id}\`]: 代わりに ${wantDesc}。`,
  );
}

function doAcceptLand(w: World, p: Player, landOfferId: string) {
  const lo = w.landOffers.find((x) => x.id === landOfferId);
  if (!lo || lo.status !== "proposed") return;
  if (lo.to !== p.id) return; // 自分宛て以外は承諾できない

  const proposer = w.players[lo.from];
  const tile = tileAt(w.tiles, w.width, lo.x, lo.y);

  // 提案してから状況が変わっている（もう持っていない等）かもしれないので、承諾時に再確認する。
  if (!proposer || !tile || tile.owner !== lo.from) {
    lo.status = "invalid";
    w.log.push(
      `${p.id} が承諾しようとしたが、${lo.from} はもう (${lo.x},${lo.y}) を持っていなかった。`,
    );
    return;
  }

  if (lo.wantX !== undefined && lo.wantY !== undefined) {
    // 土地と土地の交換
    const wantTile = tileAt(w.tiles, w.width, lo.wantX, lo.wantY);
    if (!wantTile || wantTile.owner !== p.id) {
      lo.status = "invalid";
      w.log.push(`${p.id} はもう (${lo.wantX},${lo.wantY}) を持っておらず、土地の交換を成立させられなかった。`);
      return;
    }
    if (hasCityAt(w, lo.wantX, lo.wantY)) {
      lo.status = "invalid";
      w.log.push(`${p.id} の都市があるマスは渡せず、土地の交換を成立させられなかった。`);
      return;
    }
    tile.owner = p.id;
    tile.acquiredViaTrade = true;
    wantTile.owner = proposer.id;
    wantTile.acquiredViaTrade = true;
    lo.status = "accepted";
    p.stats!.landOffersAccepted += 1;
    proposer.stats!.landOffersGiven += 1;
    w.log.push(
      `${p.id} が ${lo.from} と土地を交換した：(${lo.x},${lo.y}) を受け取り、代わりに (${lo.wantX},${lo.wantY}) を渡した。`,
    );
    return;
  }

  // 資源との交換
  const wantResource = lo.wantResource!;
  const wantAmount = lo.wantAmount!;
  if (p.stock[wantResource] < wantAmount) {
    lo.status = "invalid";
    w.log.push(`${p.id} は ${RESOURCE_JA[wantResource]}が足りず、土地の取引を成立させられなかった。`);
    return;
  }

  p.stock[wantResource] -= wantAmount;
  proposer.stock[wantResource] += wantAmount;
  tile.owner = p.id;
  tile.acquiredViaTrade = true;
  lo.status = "accepted";
  p.stats!.landOffersAccepted += 1;
  proposer.stats!.landOffersGiven += 1;
  w.log.push(
    `${p.id} が ${lo.from} から土地 (${lo.x},${lo.y}) を受け取った（${RESOURCE_JA[wantResource]}${wantAmount}を支払い）。`,
  );
}

/** 自分宛ての土地提案を、期限切れを待たずにその場で断る。手番は消費しない。 */
function doRejectLand(w: World, p: Player, landOfferId: string) {
  const lo = w.landOffers.find((x) => x.id === landOfferId);
  if (!lo || lo.status !== "proposed") return;
  if (lo.to !== p.id) return; // 自分宛て以外は拒否できない
  lo.status = "declined";
  w.log.push(`${p.id} が ${lo.from} からの土地提案 [\`${lo.id}\`] を断った。`);
}

function doSeize(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "seize" }>,
) {
  const target = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!target || !target.owner || target.owner === p.id) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) を奪えなかった（相手の土地ではない）。`);
    return;
  }
  const victim = w.players[target.owner];
  if (!victim || victim.trust >= CONFIG.seizeBelowTrust) {
    w.log.push(`${p.id} は ${target.owner} の信用がまだ高く、土地を奪えなかった。`);
    return;
  }
  if (hasCityAt(w, cmd.x, cmd.y)) {
    w.log.push(`${p.id} は都市のあるマスは奪えない。`);
    return;
  }
  // 開拓と同じく、取引で手に入れた土地は奪う対象を選ぶ起点にはできない
  // （そうしないと、取引で得た土地を足がかりに奪う→そこから開拓、という
  // 抜け道ができてしまうため）。
  const adjacent = neighbors(cmd.x, cmd.y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === p.id && !nt.acquiredViaTrade;
  });
  if (!adjacent) {
    w.log.push(`${p.id} は自分の領土（取引で手に入れた土地を除く）に隣接していない土地は奪えない。`);
    return;
  }

  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = seizeCostFor(owned, totalCityLevel(p), totalCityLevel(victim), underdogCostDiscount(w, p.id));
  if (totalStock(p.stock) < cost) {
    w.log.push(`${p.id} は資源が足りず土地を奪えなかった（要 合計${cost}）。`);
    return;
  }

  payAny(p.stock, cost, cmd.preferResource);
  target.owner = p.id;
  target.acquiredViaTrade = false;
  p.stats!.seizesDone += 1;
  victim.stats!.seizedByOthers += 1;
  w.log.push(
    `【奪取】${p.id} が信用の低い ${victim.id}（信用${victim.trust}）から (${cmd.x},${cmd.y}) を奪った。`,
  );
}

/**
 * 妨害。独走しているプレイヤーの領土に隣接する空き地を、一定ターンの間
 * 誰も取得できなくする（自分も含む）。土地を奪う道具ではなく、追い上げ中の
 * プレイヤーが独走相手の拡大だけを狙って止めるための道具。
 * 劣勢・危機的なプレイヤーだけが使える。手番を消費する。
 */
function doBlock(w: World, p: Player, cmd: Extract<Command, { type: "block" }>) {
  if (!isUnderdog(w, p.id)) {
    w.log.push(`${p.id} は劣勢・危機的でないため、妨害できなかった。`);
    return;
  }
  const target = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!target || target.owner !== null || target.kind === "river") {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) が誰の物でもない土地ではないため、妨害できなかった。`);
    return;
  }
  const adjacentDominant = neighbors(cmd.x, cmd.y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner !== null && isDominant(w, nt.owner);
  });
  if (!adjacentDominant) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) が独走しているプレイヤーの領土に隣接していないため、妨害できなかった。`);
    return;
  }
  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = Math.round(
    expandCostTotal(owned, totalCityLevel(p), underdogCostDiscount(w, p.id)) * CONFIG.blockCostRate,
  );
  if (totalStock(p.stock) < cost) {
    w.log.push(`${p.id} は資源が足りず妨害できなかった（要 合計${cost}）。`);
    return;
  }
  payAny(p.stock, cost);
  target.blockedUntilTurn = w.turn + CONFIG.blockDurationTurns;
  w.log.push(
    `【妨害】${p.id} が独走しているプレイヤーの隣、(${cmd.x},${cmd.y}) を${CONFIG.blockDurationTurns}ターンの間、誰も取得できないようにした。`,
  );
}

/**
 * 強襲。独走しているプレイヤーが持つマスを、隣接していなくても遠隔で
 * 無所属に戻す（自分の物にはならない）。劣勢・危機的なプレイヤーだけが、
 * 1ゲームにつきごく限られた回数だけ使える。手番を消費する。
 */
function doRaid(w: World, p: Player, cmd: Extract<Command, { type: "raid" }>) {
  if (!isUnderdog(w, p.id)) {
    w.log.push(`${p.id} は劣勢・危機的でないため、強襲できなかった。`);
    return;
  }
  if ((p.raidsUsed ?? 0) >= CONFIG.raidUsesMax) {
    w.log.push(`${p.id} は強襲の使用回数（最大${CONFIG.raidUsesMax}回）を使い切っているため、強襲できなかった。`);
    return;
  }
  const target = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!target || !target.owner) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) が誰かの土地ではないため、強襲できなかった。`);
    return;
  }
  if (target.owner === p.id) {
    w.log.push(`${p.id} は自分の土地は強襲できない。`);
    return;
  }
  if (!isDominant(w, target.owner)) {
    w.log.push(`${p.id} は ${target.owner} が独走していないため、強襲できなかった。`);
    return;
  }
  if (hasCityAt(w, cmd.x, cmd.y)) {
    w.log.push(`${p.id} は都市のあるマスは強襲できない。`);
    return;
  }
  if (totalStock(p.stock) < CONFIG.raidCostTotal) {
    w.log.push(`${p.id} は資源が足りず強襲できなかった（要 合計${CONFIG.raidCostTotal}）。`);
    return;
  }
  payAny(p.stock, CONFIG.raidCostTotal);
  const victimId = target.owner;
  target.owner = null;
  target.acquiredViaTrade = false;
  target.rich = false;
  p.raidsUsed = (p.raidsUsed ?? 0) + 1;
  w.log.push(
    `【強襲】${p.id} が独走している ${victimId} の (${cmd.x},${cmd.y}) を強襲し、無所属に戻した` +
      `（残り使用回数 ${CONFIG.raidUsesMax - p.raidsUsed}回）。`,
  );
}

/**
 * 所有マスから、指定した資源をまとめて回収する。
 * 毎ターン自動で入る yieldPerTile とは別枠のボーナスで、コストは掛からない
 * （その資源のマスを1つも持っていないと使えない）。
 */
function doHarvest(w: World, p: Player, resource: Resource) {
  const matchingTiles = w.tiles.filter((t) => t.owner === p.id && t.kind === resource);
  if (matchingTiles.length === 0) {
    w.log.push(`${p.id} は ${RESOURCE_JA[resource]}の土地を持っていないので回収できなかった。`);
    return;
  }
  const richCount = matchingTiles.filter((t) => t.rich).length;
  const baseAmount = matchingTiles.length * CONFIG.resourceHarvestPerTile;
  const richBonus = richCount * CONFIG.resourceHarvestPerTile * (CONFIG.richTileYieldMultiplier - 1);
  const levelBonus = totalCityLevel(p) * CONFIG.cityLevelHarvestBonus;
  const achBonus = p.achievementBonus?.harvestBonus ?? 0;
  const amount = baseAmount + richBonus + levelBonus + achBonus;
  p.stock[resource] += amount;
  p.stats!.harvestsDone += 1;
  w.log.push(
    `${p.id} が土地から ${RESOURCE_JA[resource]} を${amount}回収した` +
      `（${matchingTiles.length}マス分${richCount > 0 ? `・うち豊かな土地${richCount}マス` : ""}` +
      `${levelBonus > 0 ? ` + 都市レベル分${levelBonus}` : ""}${achBonus > 0 ? ` + 称号ボーナス${achBonus}` : ""}）。`,
  );
}

/**
 * 指定した川マスから、川沿いに（誰の土地でもないマスだけを通って）一番近い
 * 陸地（川ではないマス）までの経路をBFSで探す。見つかれば、川マス→…→陸地マスの
 * 順に並んだ配列を返す（先頭は指定した川マス自身、末尾が陸地マス）。
 * 誰かの土地は通り抜けられないので、そこで行き止まりなら null を返す。
 */
function findRiverCrossing(w: World, start: Tile): Tile[] | null {
  const key = (t: Tile) => `${t.x},${t.y}`;
  const visited = new Set<string>([key(start)]);
  const prev = new Map<string, Tile>();
  const queue: Tile[] = [start];

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const n of neighbors(cur.x, cur.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (!nt || nt.owner !== null) continue; // 誰かの土地は通れない
      const k = key(nt);
      if (visited.has(k)) continue;
      visited.add(k);
      prev.set(k, cur);

      if (nt.kind !== "river") {
        // 陸地に到達。ここまでの経路を復元する。
        const path = [nt];
        let c = cur;
        while (c !== start) {
          path.push(c);
          c = prev.get(key(c))!;
        }
        path.push(start);
        return path.reverse();
      }
      queue.push(nt);
    }
  }
  return null;
}

/**
 * 隣接する川のマスを起点に、そこから一番近い陸地まで橋を架けて、対岸への
 * 足がかりを得る。川が何マス分あっても、1回の行動で陸地まで届く。
 * 渡った川マスはすべて自分の土地になり、資源がランダムに割り当たる
 * （最後の陸地マスは、元々の資源のまま自分の土地になる）。1シーズンに1回だけ。
 */
function doBridge(w: World, p: Player, x: number, y: number, rng: Rng) {
  if (p.hasBridged) {
    w.log.push(`${p.id} はこのシーズン、もう橋を架けている。`);
    return;
  }
  const start = tileAt(w.tiles, w.width, x, y);
  if (!start || start.kind !== "river") {
    w.log.push(`${p.id} は (${x},${y}) が川ではないので橋を架けられなかった。`);
    return;
  }
  // 開拓・奪うと同じく、取引で手に入れた土地は起点にできない。
  const adjacent = neighbors(x, y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === p.id && !nt.acquiredViaTrade;
  });
  if (!adjacent) {
    w.log.push(`${p.id} は自分の領土（取引で手に入れた土地を除く）に隣接していない川には橋を架けられなかった。`);
    return;
  }

  const path = findRiverCrossing(w, start);
  if (!path) {
    w.log.push(`${p.id} は (${x},${y}) から対岸へ抜ける道が見つからず、橋を架けられなかった（誰かの土地に阻まれているか、陸地に届きません）。`);
    return;
  }
  const dest = path[path.length - 1];
  if ((dest.blockedUntilTurn ?? 0) > w.turn) {
    w.log.push(`${p.id} は対岸の (${dest.x},${dest.y}) が「妨害」で一時的に取得できないため、橋を架けられなかった。`);
    return;
  }

  const riverCount = path.length - 1; // 末尾の陸地マスを除いた、渡る川マスの数
  const cost = CONFIG.bridgeCostTotal * riverCount;
  if (totalStock(p.stock) < cost) {
    w.log.push(
      `${p.id} は資源が足りず橋を架けられなかった（川${riverCount}マス分で合計${cost}必要）。`,
    );
    return;
  }

  payAny(p.stock, cost);
  for (const t of path) {
    if (t.kind === "river") t.kind = rng.pick(RESOURCES);
    t.owner = p.id;
    t.acquiredViaTrade = false;
    // 橋では「豊かな土地」の抽選をしない。対岸の陸地マスが、前の持ち主が
    // 災害等で失った際の rich フラグを残したままだと、抽選なしでタダで
    // 引き継がれてしまうため、明示的にリセットする。
    t.rich = false;
  }
  p.hasBridged = true;
  p.stats!.bridgesBuilt += 1;
  w.log.push(
    `【橋】${p.id} が (${x},${y}) から対岸の (${dest.x},${dest.y}) まで橋を架けた` +
      `（川${riverCount}マス分、合計${cost}払った）。このシーズン中はもう橋を架けられない。`,
  );
}

/**
 * 誰かに資源を無償で送る。距離・信用に関係なく、何度でもできる（提案と同じ枠）。
 * 送った側は少し信用が上がる（バラマキで稼げないよう、量に応じた上限つき）。
 */
function doAid(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "aid" }>,
) {
  const recipient = w.players[cmd.to];
  if (!recipient || cmd.to === p.id) {
    w.log.push(`${p.id} は ${cmd.to} に援助しようとしたが、相手が見つからなかった。`);
    return;
  }
  if (cmd.amount % CONFIG.aidMinUnit !== 0) {
    w.log.push(`${p.id} は援助する数が${CONFIG.aidMinUnit}の倍数でないため、援助できなかった。`);
    return;
  }
  if (p.stock[cmd.resource] < cmd.amount) {
    w.log.push(`${p.id} は資源が足りず ${cmd.to} を援助できなかった。`);
    return;
  }
  p.stock[cmd.resource] -= cmd.amount;
  recipient.stock[cmd.resource] += cmd.amount;
  const trustGain = Math.round(
    Math.min(CONFIG.aidTrustBonusCap, cmd.amount * CONFIG.aidTrustBonusRate),
  );
  p.trust += trustGain;
  p.stats!.aidsSent += 1;
  p.stats!.totalAidGiven += cmd.amount;
  w.log.push(
    `${p.id} が ${cmd.to} に ${RESOURCE_JA[cmd.resource]}を${cmd.amount}援助した` +
      `（${p.id}の信用+${trustGain}、援助の累計貢献点${aidContributionScore(p)}/${CONFIG.aidScoreCap}）。`,
  );
}

/**
 * 「世界の脅威」の撃退に資源を出す。脅威が発生している間、誰でも何度でもできる
 * （援助と同じ枠、手番は消費しない）。必要量に達した瞬間に即座に撃退が成立する。
 */
function doContribute(w: World, p: Player, cmd: Extract<Command, { type: "contribute" }>) {
  if (!w.threat) {
    w.log.push(`${p.id} は貢献しようとしたが、今は世界の脅威が発生していない。`);
    return;
  }
  if (cmd.amount % CONFIG.minTransferUnit !== 0) {
    w.log.push(`${p.id} は貢献する数が${CONFIG.minTransferUnit}の倍数でないため、貢献できなかった。`);
    return;
  }
  if (p.stock[cmd.resource] < cmd.amount) {
    w.log.push(`${p.id} は資源が足りず貢献できなかった。`);
    return;
  }
  p.stock[cmd.resource] -= cmd.amount;
  const threat = w.threat;
  threat.contributed += cmd.amount;
  threat.contributions[p.id] = (threat.contributions[p.id] ?? 0) + cmd.amount;
  p.stats!.totalThreatContribution += cmd.amount;
  w.log.push(
    `【脅威】${p.id} が「${threat.name}」の撃退に ${RESOURCE_JA[cmd.resource]}を${cmd.amount}貢献した` +
      `（進捗 ${threat.contributed}/${threat.requirement}）。`,
  );

  if (threat.contributed >= threat.requirement) {
    const contributorIds = Object.keys(threat.contributions);
    for (const pid of contributorIds) {
      const contributor = w.players[pid];
      if (!contributor) continue;
      contributor.trust += 5;
      contributor.stats!.threatsRepelled += 1;
    }
    w.log.push(
      `【脅威】「${threat.name}」を撃退した！ 貢献した${contributorIds.length}人（各自 信用+5）: ` +
        `${contributorIds.map((pid) => `${pid}(${threat.contributions[pid]})`).join("、")}。`,
    );
    w.threat = null;
  }
}

/**
 * 「共同事業」に資源を出す。どこにいても送れる。手番は消費しない
 * （援助・貢献と同じ枠）。必要量に達すると「着工できる」状態になる
 * （実際の着工は doCommence 側、現地の人だけができる）。
 *
 * 共同事業は同時に複数進行しうるので、2つ以上が同時に進行中のときは
 * 名前（cmd.projectName、例: 「灯台」）でどれに出すか指定してもらう。
 * 同時進行中の共同事業どうしで名前が被ることは無いので、名前だけで
 * 一意に決まる。1つしか進行していなければ、指定しなくてもそれに
 * 送られる（従来通り）。
 */
function doExport(w: World, p: Player, cmd: Extract<Command, { type: "export" }>) {
  const active = w.projects ?? [];
  if (active.length === 0) {
    w.log.push(`${p.id} は輸出しようとしたが、今は共同事業が進行していない。`);
    return;
  }

  let project: WorldProject;
  if (cmd.projectName !== undefined) {
    const found = active.find((pr) => pr.name === cmd.projectName);
    if (!found) {
      w.log.push(`${p.id} は「${cmd.projectName}」という共同事業が見つからず、輸出できなかった。`);
      return;
    }
    project = found;
  } else if (active.length === 1) {
    project = active[0];
  } else {
    const names = active.map((pr) => `「${pr.name}」(${pr.x},${pr.y})`).join("、");
    w.log.push(
      `${p.id} は共同事業が複数進行中のため、どれに輸出するか名前で指定する必要がある` +
        `（\`輸出 名前 資源名 数\`）。進行中: ${names}`,
    );
    return;
  }

  if (cmd.amount % CONFIG.minTransferUnit !== 0) {
    w.log.push(`${p.id} は輸出する数が${CONFIG.minTransferUnit}の倍数でないため、輸出できなかった。`);
    return;
  }

  // 必要量を超えた分は受け取らない。「あと必要な量」までに切り詰める。
  // project.pooled はここで毎回、その時点の最新値を読むので、同じターンに
  // 複数人が輸出しても（内部では1件ずつ順番に処理されるため）、後から
  // 処理された人ほど「あと必要な量」が正しく減っており、必要量に達した後の
  // 人は自動的に0（＝もう足りている）になる。事業の役には立たないのに、
  // 輸出した分だけ個人の貢献点（得点）だけが際限なく積み上がる、という
  // 抜け道を防ぐための処置。
  const remaining = project.requirement - project.pooled;
  if (remaining <= 0) {
    w.log.push(`${p.id} は輸出しようとしたが、「${project.name}」はすでに資材が集まっている（着工待ち）。`);
    return;
  }
  const amount = Math.min(cmd.amount, remaining);

  if (p.stock[cmd.resource] < amount) {
    w.log.push(`${p.id} は資源が足りず輸出できなかった。`);
    return;
  }
  p.stock[cmd.resource] -= amount;
  project.pooled += amount;
  project.contributions[p.id] = (project.contributions[p.id] ?? 0) + amount;
  p.stats!.totalExported += amount;
  const clippedNote = amount < cmd.amount ? `（あと${amount}で足りたため、${amount}だけ受け取った）` : "";
  w.log.push(
    `【事業】${p.id} が「${project.name}」の建設に ${RESOURCE_JA[cmd.resource]}を${amount}輸出した${clippedNote}` +
      `（進捗 ${project.pooled}/${project.requirement}）。`,
  );

  if (!project.ready && project.pooled >= project.requirement) {
    project.ready = true;
    w.log.push(
      `【事業】「${project.name}」の資材が集まった！ (${project.x},${project.y}) に隣接する土地を持つ人は` +
        ` \`着工\` で完成させられる。`,
    );
  }
}

/**
 * 資材が集まった「共同事業」を、現地（隣接地）で着工して完成させる。
 * 本番の行動を1つ消費する（建設・開拓と同じ枠）。完成すると、拠出した
 * 人・していない人にかかわらず全員に恒久的な恩恵が入る。
 *
 * 共同事業は同時に複数進行しうるが、着工は隣接地を持つ現地の人にしか
 * できないので、自分が隣接していて準備が整っているものを自動で選ぶ
 * （複数の候補に同時に隣接することは通常ほぼ無い）。
 */
function doCommence(w: World, p: Player): boolean {
  const active = w.projects ?? [];
  const isAdjacent = (pr: WorldProject) =>
    neighbors(pr.x, pr.y, w.width, w.height).some((n) => {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      return nt && nt.owner === p.id;
    });

  const project = active.find((pr) => pr.ready && isAdjacent(pr));
  if (!project) {
    const readyElsewhere = active.some((pr) => pr.ready && !isAdjacent(pr));
    if (readyElsewhere) {
      w.log.push(`${p.id} は着工しようとしたが、準備が整った共同事業に隣接する土地を持っていない。`);
    } else {
      w.log.push(`${p.id} は着工しようとしたが、まだ準備が整った共同事業がない。`);
    }
    return false;
  }

  const site = tileAt(w.tiles, w.width, project.x, project.y);
  if (site) {
    site.owner = p.id;
    site.acquiredViaTrade = false;
  }
  p.stats!.projectsBuilt += 1;

  for (const other of Object.values(w.players)) {
    other.achievementBonus![project.rewardKind] += project.rewardAmount;
  }
  // 着工は本番の行動を1つ使う行為なので、実行した本人にはその見返りとして
  // 資源を追加で贈る（全員がもらう永続効果とは別枠）。
  for (const r of RESOURCES) p.stock[r] += CONFIG.projectCommenceBonus;

  const contributorIds = Object.keys(project.contributions);
  w.log.push(
    `【事業】${p.id} が「${project.name}」を着工し、完成させた！（着工した本人には資源が各+${CONFIG.projectCommenceBonus}贈られた） ` +
      `全員に永続的に${project.rewardDesc}された。` +
      `資源を出して手伝った人: ${contributorIds.length > 0 ? contributorIds.join("、") : "（いなかった）"}。`,
  );
  w.projects = active.filter((pr) => pr !== project);
  return true;
}

/** 掲示板に短いメッセージを投稿する。全員に共有される。手番は消費しない。 */
function doPost(w: World, p: Player, cmd: Extract<Command, { type: "post" }>) {
  p.stats!.postsCount += 1;
  w.log.push(`【掲示板】${p.id}: ${cmd.message}`);
}

/**
 * 「陣営戦」に資源を投入する（賭ける）。陣営戦が発生している間、自分の
 * 所属する陣営に何度でも投入できる（手番は消費しない）。投入した資源は
 * 勝敗に関わらずその場で消費される（掛け捨て）。投入しなければ何も
 * 損しない（降りる＝ノーリスク・ノーリターン）。
 */
function doWager(w: World, p: Player, cmd: Extract<Command, { type: "wager" }>) {
  const battle = w.faction;
  if (!battle) {
    w.log.push(`${p.id} は陣営戦に賭けようとしたが、今は陣営戦が発生していない。`);
    return;
  }
  const label = battle.members[p.id];
  if (!label) {
    w.log.push(`${p.id} は陣営戦に賭けようとしたが、どちらの陣営にも属していない。`);
    return;
  }
  if (cmd.amount % CONFIG.minTransferUnit !== 0) {
    w.log.push(`${p.id} は投入する数が${CONFIG.minTransferUnit}の倍数でないため、投入できなかった。`);
    return;
  }
  if (p.stock[cmd.resource] < cmd.amount) {
    w.log.push(`${p.id} は資源が足りず陣営戦に賭けられなかった。`);
    return;
  }
  p.stock[cmd.resource] -= cmd.amount;
  battle.pooled[label] += cmd.amount;
  battle.contributions[p.id] = (battle.contributions[p.id] ?? 0) + cmd.amount;
  p.stats!.totalFactionWagered += cmd.amount;
  w.log.push(
    `【陣営戦】${p.id}（陣営${label}）が「${battle.name}」に ${RESOURCE_JA[cmd.resource]}を${cmd.amount}投入した` +
      `（陣営A ${battle.pooled.A} 対 陣営B ${battle.pooled.B}）。`,
  );
}

// --------------------------------------------------------------- 称号

/** 称号（実績）1つ分の定義。 */
export interface Achievement {
  id: string;
  title: string;
  /** 達成条件の説明（ドキュメント・獲得時のログに使う）。 */
  desc: string;
  /** 報酬の説明（ドキュメント・獲得時のログに使う）。 */
  rewardDesc: string;
  condition: (w: World, p: Player) => boolean;
  reward: (p: Player) => void;
}

function ownedTileCount(w: World, playerId: string, kind?: Resource): number {
  return w.tiles.filter(
    (t) => t.owner === playerId && (kind === undefined || t.kind === kind),
  ).length;
}

/** 今この瞬間、進行中の契約がいくつあるか（提案中は含まない）。 */
function activeContractCount(w: World, playerId: string): number {
  return w.contracts.filter(
    (c) => c.status === "active" && (c.from === playerId || c.to === playerId),
  ).length;
}

/**
 * 称号の一覧。今の状態やこれまでの累積行動が条件を満たすと、
 * その場で一度だけ達成扱いになり、報酬が入る。一度取った称号は失われない。
 */
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: "stock_100",
    title: "蓄財家",
    desc: "資源の合計保有量が100に到達する",
    rewardDesc: "資源を各+10",
    condition: (_w, p) => totalStock(p.stock) >= 100,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "stock_300",
    title: "大富豪",
    desc: "資源の合計保有量が300に到達する",
    rewardDesc: "保管上限+20（永続）",
    condition: (_w, p) => totalStock(p.stock) >= 300,
    reward: (p) => { p.achievementBonus!.storage += 20; },
  },
  {
    id: "trade_first",
    title: "商いの一歩",
    desc: "取引を初めて成立させる",
    rewardDesc: "信用+5、資源を各+8",
    condition: (_w, p) => p.stats!.tradeExecutions >= 1,
    reward: (p) => { p.trust += 5; for (const r of RESOURCES) p.stock[r] += 8; },
  },
  {
    id: "trade_10",
    title: "名うての商人",
    desc: "取引を10回成立させる",
    rewardDesc: "取引可能距離+3（永続）",
    condition: (_w, p) => p.stats!.tradeExecutions >= 10,
    reward: (p) => { p.achievementBonus!.tradeRange += 3; },
  },
  {
    id: "trade_50",
    title: "伝説の商人",
    desc: "取引を50回成立させる",
    rewardDesc: "取引可能距離+4（永続）",
    condition: (_w, p) => p.stats!.tradeExecutions >= 50,
    reward: (p) => { p.achievementBonus!.tradeRange += 4; },
  },
  {
    id: "land_20",
    title: "開拓者",
    desc: "領土が20マスに到達する",
    rewardDesc: "資源を各+18",
    condition: (w, p) => ownedTileCount(w, p.id) >= 20,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 18; },
  },
  {
    id: "land_40",
    title: "大領主",
    desc: "領土が40マスに到達する",
    rewardDesc: "保管上限+28（永続）",
    condition: (w, p) => ownedTileCount(w, p.id) >= 40,
    reward: (p) => { p.achievementBonus!.storage += 28; },
  },
  {
    id: "city_level_5",
    title: "若き指導者",
    desc: "都市レベルの合計が5に到達する",
    rewardDesc: "信用+5、保管上限+10（永続）",
    condition: (_w, p) => totalCityLevel(p) >= 5,
    reward: (p) => { p.trust += 5; p.achievementBonus!.storage += 10; },
  },
  {
    id: "city_level_15",
    title: "大都市の主",
    desc: "都市レベルの合計が15に到達する",
    rewardDesc: "保管上限+35（永続）",
    condition: (_w, p) => totalCityLevel(p) >= 15,
    reward: (p) => { p.achievementBonus!.storage += 35; },
  },
  {
    id: "bridge_first",
    title: "架け橋の民",
    desc: "橋を架けて対岸へ進出する",
    rewardDesc: "資源を各+18",
    condition: (_w, p) => p.stats!.bridgesBuilt >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 18; },
  },
  {
    id: "waste_5",
    title: "荒野の開拓者",
    desc: "荒地を5マス所有する",
    rewardDesc: "災害の被害軽減+5%（永続）",
    condition: (w, p) => ownedTileCount(w, p.id, "waste") >= 5,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.05; },
  },
  {
    id: "disaster_survive",
    title: "不屈の精神",
    desc: "災害を1回生き延びる",
    rewardDesc: "災害の被害軽減+5%（永続）",
    condition: (_w, p) => p.stats!.disastersSurvived >= 1,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.05; },
  },
  {
    id: "aid_first",
    title: "情け深い者",
    desc: "誰かに援助を初めて送る",
    rewardDesc: "信用+3、資源を各+6",
    condition: (_w, p) => p.stats!.aidsSent >= 1,
    reward: (p) => { p.trust += 3; for (const r of RESOURCES) p.stock[r] += 6; },
  },
  {
    id: "aid_10",
    title: "聖人",
    desc: "援助の合計量が100に到達する",
    rewardDesc: "信用+15、資源を各+18",
    condition: (_w, p) => p.stats!.totalAidGiven >= 100,
    reward: (p) => { p.trust += 15; for (const r of RESOURCES) p.stock[r] += 18; },
  },
  {
    id: "seize_3",
    title: "海賊",
    desc: "土地を3回、力ずくで奪う",
    rewardDesc: "回収量+3（永続）",
    condition: (_w, p) => p.stats!.seizesDone >= 3,
    reward: (p) => { p.achievementBonus!.harvestBonus += 3; },
  },
  {
    id: "tri_resource",
    title: "三拍子そろい踏み",
    desc: "食料・資材・知識を、それぞれ5マス以上所有する",
    rewardDesc: "取引可能距離+3（永続）",
    condition: (w, p) =>
      RESOURCES.every((r) => ownedTileCount(w, p.id, r) >= 5),
    reward: (p) => { p.achievementBonus!.tradeRange += 3; },
  },
  {
    id: "specialist",
    title: "資源の匠",
    desc: "領土10マス以上のうち、8割以上を単一の資源で占める",
    rewardDesc: "回収量+3（永続）",
    condition: (w, p) => {
      const land = ownedTileCount(w, p.id);
      if (land < 10) return false;
      const best = Math.max(...RESOURCES.map((r) => ownedTileCount(w, p.id, r)));
      return best / land >= 0.8;
    },
    reward: (p) => { p.achievementBonus!.harvestBonus += 3; },
  },
  {
    id: "pass_10",
    title: "待機の達人",
    desc: "「待機」を10回選ぶ",
    rewardDesc: "資源を各+10",
    condition: (_w, p) => p.stats!.passCount >= 10,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "score_100",
    title: "覇者",
    desc: "得点が100に到達する",
    rewardDesc: "信用+10、取引可能距離+2（永続）",
    condition: (w, p) => totalScore(w, p.id) >= 100,
    reward: (p) => { p.trust += 10; p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "land_gift_received",
    title: "土地の絆",
    desc: "誰かから土地の提案を初めて受け取る（土地承諾）",
    rewardDesc: "資源を各+10",
    condition: (_w, p) => p.stats!.landOffersAccepted >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "land_gift_given",
    title: "気前の良い隣人",
    desc: "誰かに土地を初めて譲る（土地提案が承諾される）",
    rewardDesc: "信用+3、資源を各+8",
    condition: (_w, p) => p.stats!.landOffersGiven >= 1,
    reward: (p) => { p.trust += 3; for (const r of RESOURCES) p.stock[r] += 8; },
  },
  {
    id: "network_3",
    title: "交易網",
    desc: "同時に3件以上の契約を進行させる",
    rewardDesc: "取引可能距離+2（永続）",
    condition: (w, p) => activeContractCount(w, p.id) >= 3,
    reward: (p) => { p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "clean_record_30",
    title: "誠実な統治者",
    desc: "一度も契約を自分から破棄せずに30ターンを迎える",
    rewardDesc: "信用+8、資源を各+10",
    condition: (w, p) => w.turn >= 30 && p.stats!.breaksDone === 0,
    reward: (p) => { p.trust += 8; for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "comeback",
    title: "第二の人生",
    desc: "信用が55未満まで落ち込んだあと、90まで立て直す",
    rewardDesc: "信用+5、資源を各+10",
    condition: (_w, p) => p.stats!.minTrustEver < CONFIG.seizeBelowTrust && p.trust >= 90,
    reward: (p) => { p.trust += 5; for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "full_set",
    title: "コンプリート主義者",
    desc: "食料・資材・知識・荒地のすべてを1マス以上所有する",
    rewardDesc: "保管上限+10（永続）",
    condition: (w, p) =>
      ownedTileCount(w, p.id, "food") >= 1 &&
      ownedTileCount(w, p.id, "material") >= 1 &&
      ownedTileCount(w, p.id, "knowledge") >= 1 &&
      ownedTileCount(w, p.id, "waste") >= 1,
    reward: (p) => { p.achievementBonus!.storage += 10; },
  },
  {
    id: "survive_season",
    title: "季節を生き抜いた者",
    desc: "1シーズン（112ターン）を、領土を保ったまま乗り切る",
    rewardDesc: "信用+15、保管上限+20（永続）",
    condition: (w, p) => w.turn >= 112 && ownedTileCount(w, p.id) > 0,
    reward: (p) => { p.trust += 15; p.achievementBonus!.storage += 20; },
  },
  {
    id: "seized_survivor",
    title: "不撓不屈",
    desc: "土地を奪われた経験がありながら、それでも10マス以上の領土を保っている",
    rewardDesc: "災害の被害軽減+4%（永続）",
    condition: (w, p) => p.stats!.seizedByOthers >= 1 && ownedTileCount(w, p.id) >= 10,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.04; },
  },
  {
    id: "harvest_lover",
    title: "採取の達人",
    desc: "資源の回収を10回行う",
    rewardDesc: "回収量+2（永続）",
    condition: (_w, p) => p.stats!.harvestsDone >= 10,
    reward: (p) => { p.achievementBonus!.harvestBonus += 2; },
  },
  {
    id: "underdog_comeback",
    title: "下剋上",
    desc: "危機的（平均得点の40%未満）まで沈んだことがありながら、平均得点以上まで這い上がる",
    rewardDesc: "信用+15、保管上限+25（永続）",
    condition: (w, p) => p.stats!.worstScoreRatioEver <= CONFIG.criticalScoreRatio && !isUnderdog(w, p.id),
    reward: (p) => { p.trust += 15; p.achievementBonus!.storage += 25; },
  },
  {
    id: "underdog_recovery",
    title: "追い風",
    desc: "一度でも劣勢（平均得点の75%未満）になったことがありながら、劣勢でなくなる",
    rewardDesc: "資源を各+12",
    condition: (w, p) => p.stats!.worstScoreRatioEver <= CONFIG.underdogScoreRatio && !isUnderdog(w, p.id),
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 12; },
  },
  {
    id: "underdog_persistent",
    title: "健闘賞",
    desc: "劣勢の状態のまま、称号を5個以上獲得する",
    rewardDesc: "保管上限+15（永続）",
    condition: (w, p) => isUnderdog(w, p.id) && p.achievements!.length >= 5,
    reward: (p) => { p.achievementBonus!.storage += 15; },
  },
  {
    id: "threat_hero",
    title: "災厄の英雄",
    desc: "「世界の脅威」の撃退に、初めて貢献する",
    rewardDesc: "信用+5、資源を各+10",
    condition: (_w, p) => p.stats!.threatsRepelled >= 1,
    reward: (p) => { p.trust += 5; for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "threat_guardian",
    title: "守護者",
    desc: "「世界の脅威」の撃退に、3回貢献する",
    rewardDesc: "災害の被害軽減+5%（永続）",
    condition: (_w, p) => p.stats!.threatsRepelled >= 3,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.05; },
  },
  {
    id: "lighthouse_keeper",
    title: "灯台守",
    desc: "「共同事業」を、自分の隣接地で着工して完成させる",
    rewardDesc: "資源を各+15",
    condition: (_w, p) => p.stats!.projectsBuilt >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 15; },
  },
  {
    id: "faction_win_first",
    title: "陣営の立役者",
    desc: "「陣営戦」で勝った陣営の一員として、初めて報酬を受け取る",
    rewardDesc: "資源を各+12",
    condition: (_w, p) => p.stats!.factionBattlesWon >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 12; },
  },
  {
    id: "faction_win_3",
    title: "常勝の陣営",
    desc: "「陣営戦」で勝った陣営の一員に、3回なる",
    rewardDesc: "信用+8、取引可能距離+2（永続）",
    condition: (_w, p) => p.stats!.factionBattlesWon >= 3,
    reward: (p) => { p.trust += 8; p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "rich_tile_first",
    title: "幸運の掘り当て人",
    desc: "「豊かな土地」を1マス以上所有する",
    rewardDesc: "資源を各+15",
    condition: (w, p) => w.tiles.some((t) => t.owner === p.id && t.rich),
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 15; },
  },
  {
    id: "diverse_trader_5",
    title: "顔の広い商人",
    desc: "同時に5人以上の異なる相手と取引している",
    rewardDesc: "取引可能距離+2（永続）",
    condition: (w, p) => {
      const partners = new Set<string>();
      for (const c of w.contracts) {
        if (c.status !== "active") continue;
        if (c.from === p.id) partners.add(c.to);
        else if (c.to === p.id) partners.add(c.from);
      }
      return partners.size >= 5;
    },
    reward: (p) => { p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "score_200",
    title: "不動の帝王",
    desc: "得点が200に到達する",
    rewardDesc: "信用+10、保管上限+30（永続）",
    condition: (w, p) => totalScore(w, p.id) >= 200,
    reward: (p) => { p.trust += 10; p.achievementBonus!.storage += 30; },
  },
  {
    id: "post_first",
    title: "掲示板デビュー",
    desc: "掲示板に初めて投稿する",
    rewardDesc: "信用+3、資源を各+5",
    condition: (_w, p) => p.stats!.postsCount >= 1,
    reward: (p) => { p.trust += 3; for (const r of RESOURCES) p.stock[r] += 5; },
  },
  {
    id: "faction_participant",
    title: "勝負師",
    desc: "「陣営戦」に初めて参加する（資源を投入する）",
    rewardDesc: "資源を各+8",
    condition: (_w, p) => p.stats!.totalFactionWagered >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 8; },
  },
  {
    id: "collector_20",
    title: "収集家",
    desc: "称号を20個以上獲得する",
    rewardDesc: "保管上限+20（永続）、資源を各+15",
    condition: (_w, p) => p.achievements!.length >= 20,
    reward: (p) => { p.achievementBonus!.storage += 20; for (const r of RESOURCES) p.stock[r] += 15; },
  },
  {
    id: "trade_100",
    title: "豪商",
    desc: "取引を100回成立させる",
    rewardDesc: "信用+10、取引可能距離+5（永続）",
    condition: (_w, p) => p.stats!.tradeExecutions >= 100,
    reward: (p) => { p.trust += 10; p.achievementBonus!.tradeRange += 5; },
  },
  // ---- ここから「伝説級」：達成が難しい代わりに報酬も破格の称号 ----
  {
    id: "score_500",
    title: "伝説の統治者",
    desc: "得点が500に到達する",
    rewardDesc: "信用+20、保管上限+50（永続）、取引可能距離+3（永続）、資源を各+30",
    condition: (w, p) => totalScore(w, p.id) >= 500,
    reward: (p) => {
      p.trust += 20;
      p.achievementBonus!.storage += 50;
      p.achievementBonus!.tradeRange += 3;
      for (const r of RESOURCES) p.stock[r] += 30;
    },
  },
  {
    id: "diverse_trader_10",
    title: "全方位外交官",
    desc: "同時に10人以上の異なる相手と取引している",
    rewardDesc: "取引可能距離+5（永続）、資源を各+25",
    condition: (w, p) => {
      const partners = new Set<string>();
      for (const c of w.contracts) {
        if (c.status !== "active") continue;
        if (c.from === p.id) partners.add(c.to);
        else if (c.to === p.id) partners.add(c.from);
      }
      return partners.size >= 10;
    },
    reward: (p) => { p.achievementBonus!.tradeRange += 5; for (const r of RESOURCES) p.stock[r] += 25; },
  },
  {
    id: "threat_legend",
    title: "不滅の英雄",
    desc: "「世界の脅威」の撃退に、5回貢献する",
    rewardDesc: "災害の被害軽減+10%（永続）、信用+15",
    condition: (_w, p) => p.stats!.threatsRepelled >= 5,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.1; p.trust += 15; },
  },
];

function checkAchievements(w: World) {
  // 劣勢・危機的の概念と揃えるため、貢献点を含まない基礎経済力で追跡する。
  const avg = averageBaseScore(w);
  for (const p of Object.values(w.players)) {
    p.stats!.minTrustEver = Math.min(p.stats!.minTrustEver, p.trust);
    if (avg > 0) {
      const ratio = baseScore(w, p.id) / avg;
      p.stats!.worstScoreRatioEver = Math.min(p.stats!.worstScoreRatioEver, ratio);
    }
    for (const ach of ACHIEVEMENTS) {
      if (p.achievements!.includes(ach.id)) continue;
      if (!ach.condition(w, p)) continue;
      p.achievements!.push(ach.id);
      ach.reward(p);
      w.log.push(
        `【称号】${p.id} が称号「${ach.title}」を獲得した（${ach.desc}）。報酬: ${ach.rewardDesc}。`,
      );
    }
  }
}

// --------------------------------------------------------- 5. 信用の回復

function recoverTrust(w: World) {
  for (const p of Object.values(w.players)) {
    // 時間が経てば少しずつ許される。ただし回復は遅いので、
    // 一度の破棄で数十ターン取引できなくなる。これが「前科」の重み。
    // 都市が育っているほど、信頼の回復も少し早くなる。
    p.trust += CONFIG.trustRecoverPerTurn + totalCityLevel(p) * CONFIG.cityLevelTrustRecoverBonus;
    p.trust = Math.round(
      Math.max(CONFIG.trustMin, Math.min(CONFIG.trustMax, p.trust)) * 10,
    ) / 10;
  }
}

// ------------------------------------------------------------ 補助

function clampAllStocks(w: World) {
  for (const p of Object.values(w.players)) {
    const totalLevel = totalCityLevel(p);
    const wasteTiles = w.tiles.filter((t) => t.owner === p.id && t.kind === "waste").length;
    const cap =
      CONFIG.storageBase +
      CONFIG.storagePerCityLevel * totalLevel +
      CONFIG.wasteStorageBonusPerTile * wasteTiles +
      (p.achievementBonus?.storage ?? 0);
    for (const r of RESOURCES) {
      p.stock[r] = Math.max(0, Math.min(cap, Math.round(p.stock[r])));
    }
  }
}

/**
 * 都市を targetLevel にするのに必要な資源。
 * レベルが上がるほど高くなるので、自給自足ではいずれ必ず頭打ちになる。
 */
export function buildCostFor(targetLevel: number, trust = 100, underdogRate = 0): Stock {
  const penalty =
    trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustBuildCostRate : 1;
  const n = Math.round(CONFIG.buildCostBase * targetLevel * penalty * (1 - underdogRate));
  return { food: n, material: n, knowledge: n };
}

/**
 * 領土が広いほど開拓は高くつく。無限拡張を防ぐ。
 * underdogRate は平均得点より劣勢なプレイヤーへの追加割引（都市Lv割引の後に適用）。
 */
export function expandCostTotal(ownedTiles: number, cityLevel = 0, underdogRate = 0): number {
  const base = CONFIG.expandCostBase + CONFIG.expandCostPerTile * ownedTiles;
  const discount =
    Math.floor(cityLevel / CONFIG.cityLevelExpandDiscountEvery) *
    CONFIG.cityLevelExpandDiscountAmount;
  const afterFlat = Math.max(1, base - discount);
  return Math.max(1, Math.round(afterFlat * (1 - underdogRate)));
}

/** 強制的に奪う（seize）ときのコスト。開拓コストの割増し版。 */
export function seizeCostFor(
  ownedTiles: number,
  attackerCityLevel = 0,
  victimCityLevel = 0,
  underdogRate = 0,
): number {
  const base = expandCostTotal(ownedTiles, attackerCityLevel, underdogRate) * CONFIG.seizeCostMultiplier;
  const defense = 1 + victimCityLevel * CONFIG.citySeizeDefenseRate;
  return Math.round(base * defense);
}

/** 手持ち資源の合計。 */
export function totalStock(s: Stock): number {
  return s.food + s.material + s.knowledge;
}

/**
 * 合計 amount ぶんを資源から差し引く。
 * preferResource が指定されていれば、まずそこから使い、
 * 足りない分は余っている資源から順に補う。指定がなければ、
 * これまで通り一番多く持っている資源から順に使う。
 */
function payAny(stock: Stock, amount: number, preferResource?: Resource) {
  let left = amount;
  const rest = RESOURCES.filter((r) => r !== preferResource).sort(
    (a, b) => stock[b] - stock[a],
  );
  const order = preferResource ? [preferResource, ...rest] : rest;
  for (const r of order) {
    const take = Math.min(stock[r], left);
    stock[r] -= take;
    left -= take;
    if (left <= 0) break;
  }
}

/**
 * 2人の領土どうしの最短マス距離。交易できるかの判定に使う。
 * 都市の位置ではなく、持っているマス同士の一番近い組み合わせで測る
 * （都市が遠くても、領土を広げて近づけば交渉できるようにするため）。
 */
export function territoryDistance(
  w: World,
  a: string,
  b: string,
): number | null {
  const tilesA = w.tiles.filter((t) => t.owner === a);
  const tilesB = w.tiles.filter((t) => t.owner === b);
  if (tilesA.length === 0 || tilesB.length === 0) return null;

  let min = Infinity;
  for (const ta of tilesA) {
    for (const tb of tilesB) {
      const d = Math.abs(ta.x - tb.x) + Math.abs(ta.y - tb.y);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * 2人の間で有効な交渉可能距離。都市が大きいほど届く範囲が伸びるので、
 * どちらか片方の都市が育っていれば、その分だけ遠くまで交渉できる。
 */
export function effectiveTradeRange(w: World, a: string, b: string): number {
  const levelA = w.players[a] ? totalCityLevel(w.players[a]) : 0;
  const levelB = w.players[b] ? totalCityLevel(w.players[b]) : 0;
  const bonus = Math.max(levelA, levelB) * CONFIG.cityLevelTradeRangeBonus;
  const achBonusA = w.players[a]?.achievementBonus?.tradeRange ?? 0;
  const achBonusB = w.players[b]?.achievementBonus?.tradeRange ?? 0;
  return CONFIG.tradeRange + bonus + Math.max(achBonusA, achBonusB);
}

/** 一番足りていない資源を返す。ボットの判断にも使う。 */
export function scarcestResource(stock: Stock): Resource {
  return RESOURCES.slice().sort((a, b) => stock[a] - stock[b])[0];
}

/** 一番余っている資源。 */
export function surplusResource(stock: Stock): Resource {
  return RESOURCES.slice().sort((a, b) => stock[b] - stock[a])[0];
}

/** 得点。都市レベルの合計を主軸に、領土を少し足す。 */
export function score(w: World, playerId: string): number {
  const p = w.players[playerId];
  if (!p) return 0;
  const levels = p.cities.reduce((s, c) => s + c.level, 0);
  const land = w.tiles.filter((t) => t.owner === playerId).length;
  return levels * 10 + land;
}
