// 世界の状態をあらわす型（データの形）の定義。
// ここには「処理」は一切書かない。データがどんな形をしているかだけ。

/** 資源は3種類。食料・資材・知識。 */
export type Resource = "food" | "material" | "knowledge";

/** マス目の種類。資源3種 + 荒地（何も採れない） + 川（何も採れず、越えて開拓もできない）。 */
export type TileKind = Resource | "waste" | "river";

/** 地図の1マス。 */
export interface Tile {
  x: number;
  y: number;
  kind: TileKind;
  /** そのマスを所有しているプレイヤーID。誰のものでもなければ null。 */
  owner: string | null;
  /** 掘り当てた「豊かな土地」（産出量が通常の数倍になる）かどうか。 */
  rich?: boolean;
}

/** 手持ちの資源。 */
export interface Stock {
  food: number;
  material: number;
  knowledge: number;
}

/** 都市。levelが高いほど生産も消費も増える。 */
export interface City {
  x: number;
  y: number;
  level: number;
}

/** 称号（実績）の達成条件判定に使う、累積の行動回数。 */
export interface PlayerStats {
  tradeExecutions: number;
  aidsSent: number;
  disastersSurvived: number;
  bridgesBuilt: number;
  seizesDone: number;
  seizedByOthers: number;
  passCount: number;
  breaksDone: number;
  landOffersAccepted: number;
  landOffersGiven: number;
  harvestsDone: number;
  /** これまでの信用の最低値（信用がどん底から立ち直った、を判定するため）。 */
  minTrustEver: number;
  /** これまでに援助で送った資源の合計量。得点への貢献度の計算に使う。 */
  totalAidGiven: number;
  /** 平均得点に対する自分の得点の比率の、これまでの最低値（劣勢からの逆転を判定するため）。 */
  worstScoreRatioEver: number;
  /** これまでに「世界の脅威」へ貢献した資源の合計量。得点への貢献度の計算に使う。 */
  totalThreatContribution: number;
  /** 貢献して撃退に成功した「世界の脅威」の数。 */
  threatsRepelled: number;
  /** これまでに「共同事業」へ輸出した資源の合計量。得点への貢献度の計算に使う。 */
  totalExported: number;
  /** 自分が着工して完成させた「共同事業」の数。 */
  projectsBuilt: number;
}

/** 称号を獲得すると付く、永続的な小さいバフの合計。 */
export interface AchievementBonus {
  storage: number;
  tradeRange: number;
  disasterMitigation: number;
  harvestBonus: number;
}

export interface Player {
  id: string;
  cities: City[];
  stock: Stock;
  /** 信用度。契約を破ると下がる。0〜100。 */
  trust: number;
  /**
   * 常設命令。命令を出さなかったターンは自動的にこれが実行される。
   * 1日4ターンあるので、毎回人間が入力するのは現実的でない。
   * 「放っておいても最低限は進む」ようにするための仕組み。
   */
  standing: "expand" | "build" | "pass";
  /** 常設命令が「開拓」のとき、資源を優先して使いたい指定があれば覚えておく。 */
  standingResource?: Resource;
  /** このシーズン中に「橋」を使ったか（1シーズンに1回だけの制限に使う）。 */
  hasBridged?: boolean;
  /** 称号の達成条件判定に使う累積カウンター。古いセーブデータには無いことがある。 */
  stats?: PlayerStats;
  /** 獲得済みの称号ID一覧。 */
  achievements?: string[];
  /** 称号の報酬として積み上がった永続バフ。 */
  achievementBonus?: AchievementBonus;
}

/** 契約の状態。 */
export type ContractStatus =
  | "proposed"   // 提示したがまだ相手が承諾していない
  | "active"     // 発効中。毎ターン自動で資源が動く
  | "broken"     // 意図的に破棄された
  | "defaulted"  // 資源不足で払えなかった
  | "declined"   // 相手に明示的に断られた
  | "expired";   // 期間満了で正常終了

/**
 * 契約。「fromがgiveを渡し、見返りにtakeを受け取る」を turnsLeft ターン続ける。
 */
export interface Contract {
  id: string;
  from: string;
  to: string;
  give: Resource;
  giveAmount: number;
  take: Resource;
  takeAmount: number;
  turnsLeft: number;
  /** 提案が出されたターン。期限切れ判定に使う。 */
  proposedAt: number;
  status: ContractStatus;
}

/** 土地のやり取りの状態。 */
export type LandOfferStatus =
  | "proposed"  // 提示したがまだ相手が承諾していない
  | "accepted"  // 承諾されて、土地が実際に移動した
  | "declined"  // 相手に明示的に断られた
  | "expired"   // 返事のないまま期限切れ
  | "invalid";  // 承諾はされたが、その時点で条件が崩れていて不成立だった

/**
 * 土地のやり取り。「from が (x,y) のマスを渡し、代わりに資源をもらう」という一回きりの提案。
 * 資源の契約と違って毎ターン続くものではなく、承諾された瞬間に1回だけ処理される。
 */
export interface LandOffer {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
  wantResource: Resource;
  wantAmount: number;
  proposedAt: number;
  status: LandOfferStatus;
}

/**
 * 世界全体を襲う「共通の敵」。個人ではなく全員に関わる脅威で、
 * みんなで資源を出し合って撃退する（プレイヤー同士を敵味方に分けない、
 * 協力だけが発生する仕組み）。同時に発生するのは1つだけ。
 */
export interface WorldThreat {
  id: string;
  /** 見た目の名前（例: 「大寒波」）。ゲーム的な意味はない、雰囲気づけ。 */
  name: string;
  spawnedAt: number;
  /** このターンまでに撃退できないと被害が出る。 */
  deadlineTurn: number;
  /** 撃退に必要な貢献の合計量。 */
  requirement: number;
  /** これまでに集まった貢献の合計量。 */
  contributed: number;
  /** プレイヤーごとの貢献量。 */
  contributions: Record<string, number>;
}

/**
 * 世界のどこかに現れる「共同事業」（例: 灯台）。脅威と違って罰はなく、
 * 資源が集まって現地の誰かが着工すれば、全員に恒久的な恩恵が入る。
 * 資源は誰でも `輸出` で送れるが、実際に着工できるのは現地（隣接地）の
 * プレイヤーだけ、という役割分担がある。
 */
export interface WorldProject {
  id: string;
  /** 見た目の名前（例: 「灯台」）。種類によって完成時の恩恵が変わる。 */
  name: string;
  /** 完成時にどのボーナスが全員に付くか（AchievementBonusのキー）。 */
  rewardKind: "tradeRange" | "storage" | "disasterMitigation" | "harvestBonus";
  /** そのボーナスの量。 */
  rewardAmount: number;
  /** 報酬の説明（ログ・表示用）。 */
  rewardDesc: string;
  x: number;
  y: number;
  spawnedAt: number;
  /** 着工に必要な資源の合計量。 */
  requirement: number;
  /** これまでに集まった資源の合計量。 */
  pooled: number;
  /** プレイヤーごとの拠出量。 */
  contributions: Record<string, number>;
  /** 必要量に達して、あとは現地の誰かが着工するだけの状態か。 */
  ready: boolean;
}

/** 世界まるごと。このオブジェクトがそのまま state.json になる。 */
export interface World {
  turn: number;
  width: number;
  height: number;
  tiles: Tile[];
  players: Record<string, Player>;
  contracts: Contract[];
  landOffers: LandOffer[];
  /** 現在発生中の「世界の脅威」。無ければ null。 */
  threat?: WorldThreat | null;
  /** 現在進行中の「共同事業」。無ければ null。 */
  project?: WorldProject | null;
  /** 現在の世界目標の種類（例: "land"）。達成すると別の種類にランダムで切り替わる。 */
  worldGoalType?: string;
  /** 現在の世界目標の、次の到達ライン。 */
  worldGoalNextThreshold?: number;
  /** そのターンに起きたことの記録。 */
  log: string[];
}

/** プレイヤーが1ターンに1つだけ出せる命令。 */
export type Command =
  | {
      type: "expand";
      player: string;
      /** 優先して使いたい資源（指定しなければ一番多い資源から自動で使う）。 */
      preferResource?: Resource;
      /** 開拓したい先を自分で指定する場合の座標（指定しなければ自動で選ぶ）。 */
      target?: { x: number; y: number };
      /** 支払う資源の内訳を自分で指定する場合（指定しなければ自動で決める）。 */
      payment?: Partial<Record<Resource, number>>;
    }
  | { type: "build"; player: string }
  | {
      type: "offer";
      player: string;
      to: string;
      give: Resource;
      giveAmount: number;
      take: Resource;
      takeAmount: number;
      turns: number;
    }
  | { type: "accept"; player: string; contractId: string }
  | { type: "break"; player: string; contractId: string }
  | { type: "reject"; player: string; contractId: string }
  | {
      /** 自分が持つ (x,y) のマスを、相手に資源と引き換えに譲る提案。手番は消費しない。 */
      type: "offerLand";
      player: string;
      to: string;
      x: number;
      y: number;
      wantResource: Resource;
      wantAmount: number;
    }
  | { type: "acceptLand"; player: string; landOfferId: string }
  | { type: "rejectLand"; player: string; landOfferId: string }
  | {
      /** 信用が著しく低い隣人から、隣接するマスを1つ強制的に奪う。手番を消費する。 */
      type: "seize";
      player: string;
      x: number;
      y: number;
      preferResource?: Resource;
    }
  | { type: "pass"; player: string }
  | {
      /** 所有マスから、指定した資源をまとめて回収する。手番を消費する。 */
      type: "harvest";
      player: string;
      resource: Resource;
    }
  | {
      /** 隣接する川のマスに橋を架けて、対岸への足がかりを得る。1シーズンに1回だけ。手番を消費する。 */
      type: "bridge";
      player: string;
      x: number;
      y: number;
    }
  | {
      /** 誰かに資源を無償で送る。手番を消費しない（提案などと同じ枠）。 */
      type: "aid";
      player: string;
      to: string;
      resource: Resource;
      amount: number;
    }
  | {
      /** 「世界の脅威」の撃退に資源を出す。手番を消費しない（援助などと同じ枠）。 */
      type: "contribute";
      player: string;
      resource: Resource;
      amount: number;
    }
  | {
      /** 「共同事業」に資源を出す。どこにいても送れる。手番を消費しない。 */
      type: "export";
      player: string;
      resource: Resource;
      amount: number;
    }
  | {
      /** 資源が集まった「共同事業」を、現地（隣接地）で着工して完成させる。手番を消費する。 */
      type: "commence";
      player: string;
    }
  | {
      /** 掲示板に短いメッセージを投稿する。全員に共有される。手番を消費しない。 */
      type: "post";
      player: string;
      message: string;
    };

export const RESOURCES: Resource[] = ["food", "material", "knowledge"];

/** 資源名を日本語にする。表示用。 */
export const RESOURCE_JA: Record<Resource, string> = {
  food: "食料",
  material: "資材",
  knowledge: "知識",
};
