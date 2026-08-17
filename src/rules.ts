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
  upkeep(w);
  executeContracts(w);
  applyCommands(w, commands, rng);
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
    p.stock[tile.kind] += CONFIG.yieldPerTile * mult(p);
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
  for (const p of Object.values(w.players)) {
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
      for (const t of targets) t.owner = null;
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
const ECONOMIC = new Set(["expand", "build", "seize", "pass", "harvest", "bridge"]);

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
  const cost = expandCostTotal(owned, totalCityLevel(p));

  // 自分の領土に隣接している、誰のものでもないマスを集める
  // （自動選択の候補集めにも、指定マスの隣接チェックにも使う）。
  // 荒地は資源こそ採れないが、保管上限や災害対策になるので開拓の対象にできる。
  // 川だけは橋を架けない限り越えられない。
  const candidates: Tile[] = [];
  for (const t of w.tiles) {
    if (t.owner !== p.id) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "river")
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
    if (!candidates.includes(t)) {
      w.log.push(`${p.id} は (${manualTarget.x},${manualTarget.y}) が自分の土地に隣接していないので開拓できなかった。`);
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
  const kindLabel = target.kind === "waste" ? "荒地" : RESOURCE_JA[target.kind as Resource];
  w.log.push(
    `${p.id} が (${target.x},${target.y}) を開拓した [${kindLabel}]。`,
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
  const cost = buildCostFor(city.level + 1, p.trust);
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
  const offer: LandOffer = {
    id,
    from: p.id,
    to: cmd.to,
    x: cmd.x,
    y: cmd.y,
    wantResource: cmd.wantResource,
    wantAmount: cmd.wantAmount,
    proposedAt: w.turn,
    status: "proposed",
  };
  w.landOffers.push(offer);
  w.log.push(
    `${p.id} が ${cmd.to} に土地 (${cmd.x},${cmd.y}) を提案 [\`${id}\`]: 代わりに ${RESOURCE_JA[cmd.wantResource]}${cmd.wantAmount}。`,
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
  if (p.stock[lo.wantResource] < lo.wantAmount) {
    lo.status = "invalid";
    w.log.push(`${p.id} は ${RESOURCE_JA[lo.wantResource]}が足りず、土地の取引を成立させられなかった。`);
    return;
  }

  p.stock[lo.wantResource] -= lo.wantAmount;
  proposer.stock[lo.wantResource] += lo.wantAmount;
  tile.owner = p.id;
  lo.status = "accepted";
  p.stats!.landOffersAccepted += 1;
  proposer.stats!.landOffersGiven += 1;
  w.log.push(
    `${p.id} が ${lo.from} から土地 (${lo.x},${lo.y}) を受け取った（${RESOURCE_JA[lo.wantResource]}${lo.wantAmount}を支払い）。`,
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
  const adjacent = neighbors(cmd.x, cmd.y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === p.id;
  });
  if (!adjacent) {
    w.log.push(`${p.id} は自分の領土に隣接していない土地は奪えない。`);
    return;
  }

  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = seizeCostFor(owned, totalCityLevel(p), totalCityLevel(victim));
  if (totalStock(p.stock) < cost) {
    w.log.push(`${p.id} は資源が足りず土地を奪えなかった（要 合計${cost}）。`);
    return;
  }

  payAny(p.stock, cost, cmd.preferResource);
  target.owner = p.id;
  p.stats!.seizesDone += 1;
  victim.stats!.seizedByOthers += 1;
  w.log.push(
    `【奪取】${p.id} が信用の低い ${victim.id}（信用${victim.trust}）から (${cmd.x},${cmd.y}) を奪った。`,
  );
}

/**
 * 所有マスから、指定した資源をまとめて回収する。
 * 毎ターン自動で入る yieldPerTile とは別枠のボーナスで、コストは掛からない
 * （その資源のマスを1つも持っていないと使えない）。
 */
function doHarvest(w: World, p: Player, resource: Resource) {
  const tiles = w.tiles.filter((t) => t.owner === p.id && t.kind === resource).length;
  if (tiles === 0) {
    w.log.push(`${p.id} は ${RESOURCE_JA[resource]}の土地を持っていないので回収できなかった。`);
    return;
  }
  const levelBonus = totalCityLevel(p) * CONFIG.cityLevelHarvestBonus;
  const achBonus = p.achievementBonus?.harvestBonus ?? 0;
  const amount = tiles * CONFIG.resourceHarvestPerTile + levelBonus + achBonus;
  p.stock[resource] += amount;
  p.stats!.harvestsDone += 1;
  w.log.push(
    `${p.id} が土地から ${RESOURCE_JA[resource]} を${amount}回収した` +
      `（${tiles}マス分${levelBonus > 0 ? ` + 都市レベル分${levelBonus}` : ""}${achBonus > 0 ? ` + 称号ボーナス${achBonus}` : ""}）。`,
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
  const adjacent = neighbors(x, y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === p.id;
  });
  if (!adjacent) {
    w.log.push(`${p.id} は自分の領土に隣接していない川には橋を架けられなかった。`);
    return;
  }

  const path = findRiverCrossing(w, start);
  if (!path) {
    w.log.push(`${p.id} は (${x},${y}) から対岸へ抜ける道が見つからず、橋を架けられなかった（誰かの土地に阻まれているか、陸地に届きません）。`);
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
  }
  p.hasBridged = true;
  p.stats!.bridgesBuilt += 1;
  const dest = path[path.length - 1];
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
  w.log.push(
    `${p.id} が ${cmd.to} に ${RESOURCE_JA[cmd.resource]}を${cmd.amount}援助した` +
      `（${p.id}の信用+${trustGain}）。`,
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
    rewardDesc: "資源を各+5",
    condition: (_w, p) => totalStock(p.stock) >= 100,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 5; },
  },
  {
    id: "stock_300",
    title: "大富豪",
    desc: "資源の合計保有量が300に到達する",
    rewardDesc: "保管上限+10（永続）",
    condition: (_w, p) => totalStock(p.stock) >= 300,
    reward: (p) => { p.achievementBonus!.storage += 10; },
  },
  {
    id: "trade_first",
    title: "商いの一歩",
    desc: "取引を初めて成立させる",
    rewardDesc: "信用+5",
    condition: (_w, p) => p.stats!.tradeExecutions >= 1,
    reward: (p) => { p.trust += 5; },
  },
  {
    id: "trade_10",
    title: "名うての商人",
    desc: "取引を10回成立させる",
    rewardDesc: "取引可能距離+2（永続）",
    condition: (_w, p) => p.stats!.tradeExecutions >= 10,
    reward: (p) => { p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "trade_50",
    title: "伝説の商人",
    desc: "取引を50回成立させる",
    rewardDesc: "取引可能距離+3（永続）",
    condition: (_w, p) => p.stats!.tradeExecutions >= 50,
    reward: (p) => { p.achievementBonus!.tradeRange += 3; },
  },
  {
    id: "land_20",
    title: "開拓者",
    desc: "領土が20マスに到達する",
    rewardDesc: "資源を各+10",
    condition: (w, p) => ownedTileCount(w, p.id) >= 20,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "land_40",
    title: "大領主",
    desc: "領土が40マスに到達する",
    rewardDesc: "保管上限+15（永続）",
    condition: (w, p) => ownedTileCount(w, p.id) >= 40,
    reward: (p) => { p.achievementBonus!.storage += 15; },
  },
  {
    id: "city_level_5",
    title: "若き指導者",
    desc: "都市レベルの合計が5に到達する",
    rewardDesc: "信用+5",
    condition: (_w, p) => totalCityLevel(p) >= 5,
    reward: (p) => { p.trust += 5; },
  },
  {
    id: "city_level_15",
    title: "大都市の主",
    desc: "都市レベルの合計が15に到達する",
    rewardDesc: "保管上限+20（永続）",
    condition: (_w, p) => totalCityLevel(p) >= 15,
    reward: (p) => { p.achievementBonus!.storage += 20; },
  },
  {
    id: "bridge_first",
    title: "架け橋の民",
    desc: "橋を架けて対岸へ進出する",
    rewardDesc: "資源を各+10",
    condition: (_w, p) => p.stats!.bridgesBuilt >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "waste_5",
    title: "荒野の開拓者",
    desc: "荒地を5マス所有する",
    rewardDesc: "災害の被害軽減+3%（永続）",
    condition: (w, p) => ownedTileCount(w, p.id, "waste") >= 5,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.03; },
  },
  {
    id: "disaster_survive",
    title: "不屈の精神",
    desc: "災害を1回生き延びる",
    rewardDesc: "災害の被害軽減+3%（永続）",
    condition: (_w, p) => p.stats!.disastersSurvived >= 1,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.03; },
  },
  {
    id: "aid_first",
    title: "情け深い者",
    desc: "誰かに援助を初めて送る",
    rewardDesc: "信用+3",
    condition: (_w, p) => p.stats!.aidsSent >= 1,
    reward: (p) => { p.trust += 3; },
  },
  {
    id: "aid_10",
    title: "聖人",
    desc: "援助を10回送る",
    rewardDesc: "信用+10、資源を各+10",
    condition: (_w, p) => p.stats!.aidsSent >= 10,
    reward: (p) => { p.trust += 10; for (const r of RESOURCES) p.stock[r] += 10; },
  },
  {
    id: "seize_3",
    title: "海賊",
    desc: "土地を3回、力ずくで奪う",
    rewardDesc: "回収量+2（永続）",
    condition: (_w, p) => p.stats!.seizesDone >= 3,
    reward: (p) => { p.achievementBonus!.harvestBonus += 2; },
  },
  {
    id: "tri_resource",
    title: "三拍子そろい踏み",
    desc: "食料・資材・知識を、それぞれ5マス以上所有する",
    rewardDesc: "取引可能距離+2（永続）",
    condition: (w, p) =>
      RESOURCES.every((r) => ownedTileCount(w, p.id, r) >= 5),
    reward: (p) => { p.achievementBonus!.tradeRange += 2; },
  },
  {
    id: "specialist",
    title: "資源の匠",
    desc: "領土10マス以上のうち、8割以上を単一の資源で占める",
    rewardDesc: "回収量+2（永続）",
    condition: (w, p) => {
      const land = ownedTileCount(w, p.id);
      if (land < 10) return false;
      const best = Math.max(...RESOURCES.map((r) => ownedTileCount(w, p.id, r)));
      return best / land >= 0.8;
    },
    reward: (p) => { p.achievementBonus!.harvestBonus += 2; },
  },
  {
    id: "pass_10",
    title: "待機の達人",
    desc: "「待機」を10回選ぶ",
    rewardDesc: "信用+2",
    condition: (_w, p) => p.stats!.passCount >= 10,
    reward: (p) => { p.trust += 2; },
  },
  {
    id: "score_100",
    title: "覇者",
    desc: "得点（都市Lv×10＋領土）が100に到達する",
    rewardDesc: "信用+15",
    condition: (w, p) => totalCityLevel(p) * 10 + ownedTileCount(w, p.id) >= 100,
    reward: (p) => { p.trust += 15; },
  },
  {
    id: "land_gift_received",
    title: "土地の絆",
    desc: "誰かから土地の提案を初めて受け取る（土地承諾）",
    rewardDesc: "資源を各+5",
    condition: (_w, p) => p.stats!.landOffersAccepted >= 1,
    reward: (p) => { for (const r of RESOURCES) p.stock[r] += 5; },
  },
  {
    id: "land_gift_given",
    title: "気前の良い隣人",
    desc: "誰かに土地を初めて譲る（土地提案が承諾される）",
    rewardDesc: "信用+3",
    condition: (_w, p) => p.stats!.landOffersGiven >= 1,
    reward: (p) => { p.trust += 3; },
  },
  {
    id: "network_3",
    title: "交易網",
    desc: "同時に3件以上の契約を進行させる",
    rewardDesc: "取引可能距離+1（永続）",
    condition: (w, p) => activeContractCount(w, p.id) >= 3,
    reward: (p) => { p.achievementBonus!.tradeRange += 1; },
  },
  {
    id: "clean_record_30",
    title: "誠実な統治者",
    desc: "一度も契約を自分から破棄せずに30ターンを迎える",
    rewardDesc: "信用+8",
    condition: (w, p) => w.turn >= 30 && p.stats!.breaksDone === 0,
    reward: (p) => { p.trust += 8; },
  },
  {
    id: "comeback",
    title: "第二の人生",
    desc: "信用が55未満まで落ち込んだあと、90まで立て直す",
    rewardDesc: "信用+5",
    condition: (_w, p) => p.stats!.minTrustEver < CONFIG.seizeBelowTrust && p.trust >= 90,
    reward: (p) => { p.trust += 5; },
  },
  {
    id: "full_set",
    title: "コンプリート主義者",
    desc: "食料・資材・知識・荒地のすべてを1マス以上所有する",
    rewardDesc: "保管上限+5（永続）",
    condition: (w, p) =>
      ownedTileCount(w, p.id, "food") >= 1 &&
      ownedTileCount(w, p.id, "material") >= 1 &&
      ownedTileCount(w, p.id, "knowledge") >= 1 &&
      ownedTileCount(w, p.id, "waste") >= 1,
    reward: (p) => { p.achievementBonus!.storage += 5; },
  },
  {
    id: "survive_season",
    title: "季節を生き抜いた者",
    desc: "1シーズン（112ターン）を、領土を保ったまま乗り切る",
    rewardDesc: "信用+10、保管上限+10（永続）",
    condition: (w, p) => w.turn >= 112 && ownedTileCount(w, p.id) > 0,
    reward: (p) => { p.trust += 10; p.achievementBonus!.storage += 10; },
  },
  {
    id: "seized_survivor",
    title: "不撓不屈",
    desc: "土地を奪われた経験がありながら、それでも10マス以上の領土を保っている",
    rewardDesc: "災害の被害軽減+2%（永続）",
    condition: (w, p) => p.stats!.seizedByOthers >= 1 && ownedTileCount(w, p.id) >= 10,
    reward: (p) => { p.achievementBonus!.disasterMitigation += 0.02; },
  },
  {
    id: "harvest_lover",
    title: "採取の達人",
    desc: "資源の回収を10回行う",
    rewardDesc: "回収量+1（永続）",
    condition: (_w, p) => p.stats!.harvestsDone >= 10,
    reward: (p) => { p.achievementBonus!.harvestBonus += 1; },
  },
];

function checkAchievements(w: World) {
  for (const p of Object.values(w.players)) {
    p.stats!.minTrustEver = Math.min(p.stats!.minTrustEver, p.trust);
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
export function buildCostFor(targetLevel: number, trust = 100): Stock {
  const penalty =
    trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustBuildCostRate : 1;
  const n = Math.round(CONFIG.buildCostBase * targetLevel * penalty);
  return { food: n, material: n, knowledge: n };
}

/** 領土が広いほど開拓は高くつく。無限拡張を防ぐ。 */
export function expandCostTotal(ownedTiles: number, cityLevel = 0): number {
  const base = CONFIG.expandCostBase + CONFIG.expandCostPerTile * ownedTiles;
  const discount =
    Math.floor(cityLevel / CONFIG.cityLevelExpandDiscountEvery) *
    CONFIG.cityLevelExpandDiscountAmount;
  return Math.max(1, base - discount);
}

/** 強制的に奪う（seize）ときのコスト。開拓コストの割増し版。 */
export function seizeCostFor(
  ownedTiles: number,
  attackerCityLevel = 0,
  victimCityLevel = 0,
): number {
  const base = expandCostTotal(ownedTiles, attackerCityLevel) * CONFIG.seizeCostMultiplier;
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
