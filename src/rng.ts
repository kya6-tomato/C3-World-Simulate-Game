/**
 * 自前の乱数生成器。
 *
 * なぜ Math.random() を使わないのか:
 * Math.random() は毎回ちがう結果になるので、「昨日と同じ計算をやり直す」ができない。
 * ゲームの検証もリプレイも不可能になる。
 * ここでは「種（seed）」を与えると必ず同じ数列が出る乱数を使う。
 * 同じ種 → 同じ世界。これを「決定論的」という。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 0以上1未満の小数。 */
  next(): number {
    // mulberry32 という有名で短い実装
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** min以上max以下の整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 配列からランダムに1つ。 */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** 配列をシャッフルした新しい配列を返す。 */
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/**
 * ターン番号から乱数の種をつくる。
 * こうしておくと「42ターン目の処理」はいつ何度やり直しても同じ結果になる。
 */
export function turnSeed(baseSeed: number, turn: number): number {
  return (baseSeed * 7919 + turn * 104729) >>> 0;
}
