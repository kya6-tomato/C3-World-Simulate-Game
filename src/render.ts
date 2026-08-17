import type { World, Tile, TileKind } from "./types.ts";
import { totalScore } from "./rules.ts";

/**
 * 世界をSVG画像（文字列）にする。
 * 出来上がったファイルをREADMEに貼れば、リポジトリのトップに地図が出る。
 */

const TILE = 18;
const PAD = 20;

const FILL: Record<TileKind, string> = {
  food: "#C0DD97",
  material: "#FAC775",
  knowledge: "#CECBF6",
  waste: "#E2E0D8",
  river: "#8FB8D9",
};

// 各資源を少し濃くした色。境界線・アイコン・地形の濃淡の下端に使う。
const DEEP: Record<TileKind, string> = {
  food: "#93B96A",
  material: "#D9A24E",
  knowledge: "#A79FDB",
  waste: "#C7C3B8",
  river: "#5E90BE",
};

/** (x, y) から 0〜1 の疑似乱数を作る。毎回同じ入力なら必ず同じ値になる（世界を再描画しても地図がちらつかない）。 */
function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2654435761) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

/** 格子点のハッシュ値をなめらかに補間する。地形の起伏のような、自然な濃淡の帯を作る。 */
function smoothField(x: number, y: number, scale: number, salt: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const h00 = hash(x0, y0, salt);
  const h10 = hash(x0 + 1, y0, salt);
  const h01 = hash(x0, y0 + 1, salt);
  const h11 = hash(x0 + 1, y0 + 1, salt);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(mix(ar, br))}${toHex(mix(ag, bg))}${toHex(mix(ab, bb))}`;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * 参加者の数に関係なく、1人に1色が必ず割り当たるようにする
 * （一覧の途中に人が増減しても、他の人の色は変わらない）。
 *
 * 色相を均等にずらすだけだと、人数が増えたときに隣り合う色相同士が
 * 近くなって見分けづらくなる（例: 赤とオレンジがほぼ同じ色に見える）。
 * そこで、まず知覚的に離れた20色の固定パレットを使い切り、
 * それでも足りない場合だけ黄金角（約137.5度）で色相をずらして補う。
 */
const PLAYER_PALETTE = [
  "#b12f2f", "#3ecc3e", "#3e3ecc", "#3eafcc", "#b1972f",
  "#cc3ea1", "#328653", "#324b86", "#863253", "#865c32",
  "#90bd4c", "#6d3286", "#3eccaf", "#af3ecc", "#3ecc76",
  "#326d86", "#cc763e", "#cc3e68", "#3e68cc", "#279127",
];
const GOLDEN_ANGLE = 137.508;
function colorForIndex(index: number): string {
  if (index < PLAYER_PALETTE.length) return PLAYER_PALETTE[index];
  const hue = (index * GOLDEN_ANGLE) % 360;
  return hslToHex(hue, 62, 42);
}

export function renderMapSvg(w: World): string {
  const mapW = w.width * TILE;
  const mapH = w.height * TILE;
  const legendW = 230;
  // 開拓・土地提案・奪うは座標指定が必要なので、マスから座標を数えやすいように
  // 上と左に余白を取って目盛りを置く。
  const axisGutterX = 22;
  const axisGutterY = 16;
  const mapLeft = PAD + axisGutterX;
  const mapTop = PAD + 30 + axisGutterY;
  const svgW = mapLeft + mapW + legendW + PAD;
  const svgH = mapTop + mapH + PAD;

  const ids = Object.keys(w.players);
  const colorOf = (id: string) => colorForIndex(ids.indexOf(id));

  const grid: (Tile | undefined)[][] = Array.from({ length: w.height }, () => []);
  for (const t of w.tiles) grid[t.y][t.x] = t;
  const kindAt = (x: number, y: number): TileKind | null => {
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return null;
    return grid[y][x]?.kind ?? null;
  };
  const cityTileAt = new Set<string>();
  for (const p of Object.values(w.players)) {
    for (const c of p.cities) cityTileAt.add(`${c.x},${c.y}`);
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="Hiragino Sans, Noto Sans JP, Yu Gothic, Meiryo, sans-serif">`,
  );

  // ------------------------------------------------------- 定義（背景・影・紙の粒状感）
  parts.push("<defs>");
  parts.push(
    `<radialGradient id="bg" cx="50%" cy="40%" r="75%">` +
      `<stop offset="0%" stop-color="#FFFFFF"/>` +
      `<stop offset="100%" stop-color="#EAE6D9"/>` +
      `</radialGradient>`,
  );
  parts.push(
    `<filter id="cityShadow" x="-60%" y="-60%" width="220%" height="220%">` +
      `<feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="#000000" flood-opacity="0.35"/>` +
      `</filter>`,
  );
  // 紙のような粒状のノイズ。ベタ塗りの上にごく薄く重ねて、印刷された地図っぽくする。
  parts.push(
    `<filter id="grain" x="0%" y="0%" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch" result="n"/>` +
      `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0.24  0 0 0 0 0.22  0 0 0 0 0.18  0 0 0 0.05 0"/>` +
      `</filter>`,
  );
  parts.push("</defs>");

  parts.push(`<rect width="${svgW}" height="${svgH}" fill="url(#bg)"/>`);
  parts.push(
    `<text x="${PAD}" y="${PAD + 14}" font-size="15" font-weight="500" fill="#3D3D3A">Turn ${w.turn}</text>`,
  );

  // ------------------------------------------------------------- マス目
  for (const t of w.tiles) {
    const x = mapLeft + t.x * TILE;
    const y = mapTop + t.y * TILE;

    // 地形の起伏のような、なめらかな濃淡。ベタ塗りではなく、
    // 隣接するマスとゆるやかにつながる明暗にすることで自然に見せる。
    // 荒地だけは起伏を弱くして、他より生気のない土地に見せる。
    const relief = smoothField(t.x, t.y, 4.5, 3);
    const reliefRange = t.kind === "waste" ? 0.25 : 0.55;
    const fillColor = lerpColor(FILL[t.kind], DEEP[t.kind], 0.15 + relief * reliefRange);

    parts.push(
      `<rect x="${x - 0.4}" y="${y - 0.4}" width="${TILE + 0.8}" height="${TILE + 0.8}" ` +
        `rx="1.5" fill="${fillColor}"/>`,
    );

    // 資源ごとに絵のようなアイコンを置いて、ファンタジー地図らしくする
    // （都市が建つマスは避ける）。
    if (!cityTileAt.has(`${t.x},${t.y}`)) {
      const cx = x + TILE / 2;
      const cy = y + TILE / 2;
      const r = hash(t.x, t.y, 7);
      const jx = cx + (hash(t.x, t.y, 9) - 0.5) * 6;
      const jy = cy + (hash(t.x, t.y, 10) - 0.5) * 6;

      if (t.kind === "river" && r < 0.75) {
        const dx = (hash(t.x, t.y, 8) - 0.5) * 6;
        parts.push(
          `<path d="M ${cx - 5 + dx} ${cy} Q ${cx + dx} ${cy - 3} ${cx + 5 + dx} ${cy}" ` +
            `stroke="#FFFFFF" stroke-width="1.2" fill="none" opacity="0.7" stroke-linecap="round"/>`,
        );
      } else if (t.kind === "food" && r < 0.55) {
        // 木（葉の丸みと幹）
        parts.push(
          `<circle cx="${jx}" cy="${jy - 1.6}" r="2.9" fill="${DEEP.food}" stroke="#5B7A3F" stroke-width="0.4" opacity="0.92"/>`,
          `<rect x="${jx - 0.6}" y="${jy}" width="1.2" height="2.4" fill="#6B4B2E" opacity="0.85"/>`,
        );
      } else if (t.kind === "material" && r < 0.55) {
        // 山（雪をかぶった二つの峰）
        parts.push(
          `<path d="M ${jx - 6} ${jy + 3.5} L ${jx - 1.8} ${jy - 5} L ${jx + 0.6} ${jy - 1.2} ` +
            `L ${jx + 3} ${jy - 4.3} L ${jx + 6} ${jy + 3.5} Z" fill="${DEEP.material}" ` +
            `stroke="#8A6423" stroke-width="0.4" opacity="0.92"/>`,
          `<path d="M ${jx - 2.9} ${jy - 3} L ${jx - 1.8} ${jy - 5} L ${jx - 0.7} ${jy - 2.9} Z" ` +
            `fill="#FFFFFF" opacity="0.75"/>`,
        );
      } else if (t.kind === "knowledge" && r < 0.55) {
        // 塔（尖った屋根の小さな塔）
        parts.push(
          `<rect x="${jx - 1.7}" y="${jy - 1.2}" width="3.4" height="5.2" fill="${DEEP.knowledge}" ` +
            `stroke="#6F5FA0" stroke-width="0.4" opacity="0.92"/>`,
          `<path d="M ${jx - 2.4} ${jy - 1.2} L ${jx} ${jy - 6} L ${jx + 2.4} ${jy - 1.2} Z" ` +
            `fill="${DEEP.knowledge}" stroke="#6F5FA0" stroke-width="0.4" opacity="0.92"/>`,
        );
      } else if (t.kind === "waste" && r < 0.6) {
        // 転がる岩・枯れ木の茂み
        parts.push(
          `<ellipse cx="${jx - 1.6}" cy="${jy + 1.3}" rx="1.9" ry="1.2" fill="${DEEP.waste}" opacity="0.8"/>`,
          `<ellipse cx="${jx + 1.6}" cy="${jy + 0.4}" rx="1.3" ry="0.9" fill="${DEEP.waste}" opacity="0.65"/>`,
        );
      }
    }

    // 自然な境界線: 右隣・下隣が違う資源のときだけ、少し揺らした線を引く。
    const rightKind = kindAt(t.x + 1, t.y);
    if (rightKind !== null && rightKind !== t.kind) {
      const ex = x + TILE;
      const jitter = (hash(t.x, t.y, 1) - 0.5) * 6;
      parts.push(
        `<path d="M ${ex} ${y} Q ${ex + jitter} ${y + TILE / 2} ${ex} ${y + TILE}" ` +
          `stroke="#3D3D3A" stroke-width="0.6" fill="none" opacity="0.2"/>`,
      );
    }
    const downKind = kindAt(t.x, t.y + 1);
    if (downKind !== null && downKind !== t.kind) {
      const ey = y + TILE;
      const jitter = (hash(t.x, t.y, 2) - 0.5) * 6;
      parts.push(
        `<path d="M ${x} ${ey} Q ${x + TILE / 2} ${ey + jitter} ${x + TILE} ${ey}" ` +
          `stroke="#3D3D3A" stroke-width="0.6" fill="none" opacity="0.2"/>`,
      );
    }

    if (t.owner) {
      // 所有者の色で細い枠を描く
      parts.push(
        `<rect x="${x + 1.5}" y="${y + 1.5}" width="${TILE - 3}" height="${TILE - 3}" rx="1" ` +
          `fill="none" stroke="${colorOf(t.owner)}" stroke-width="1.5" opacity="0.85"/>`,
      );
    }
  }

  // ------------------------------------------------------- 座標の目盛り
  // 開拓・土地提案・奪うのコマンドには座標（x, y）が要る。数えやすいように
  // 5マスごとに数字とうっすらした格子線を入れる。
  const AXIS_STEP = 5;
  parts.push(`<g font-size="8.5" fill="#74716A">`);
  for (let gx = 0; gx < w.width; gx += AXIS_STEP) {
    const lineX = mapLeft + gx * TILE;
    parts.push(
      `<text x="${lineX + 2}" y="${mapTop - 5}" text-anchor="start">${gx}</text>`,
      `<line x1="${lineX}" y1="${mapTop}" x2="${lineX}" y2="${mapTop + mapH}" ` +
        `stroke="#3D3D3A" stroke-width="0.5" opacity="0.12"/>`,
    );
  }
  for (let gy = 0; gy < w.height; gy += AXIS_STEP) {
    const lineY = mapTop + gy * TILE;
    parts.push(
      `<text x="${mapLeft - 5}" y="${lineY + 9}" text-anchor="end">${gy}</text>`,
      `<line x1="${mapLeft}" y1="${lineY}" x2="${mapLeft + mapW}" y2="${lineY}" ` +
        `stroke="#3D3D3A" stroke-width="0.5" opacity="0.12"/>`,
    );
  }
  parts.push(`</g>`);

  // 紙の粒状感を地図の上に薄く重ねる
  parts.push(
    `<rect x="${mapLeft}" y="${mapTop}" width="${mapW}" height="${mapH}" filter="url(#grain)"/>`,
  );

  // 地図のふち（二重線の縁取りで、古い地図らしい額装にする）
  parts.push(
    `<rect x="${mapLeft}" y="${mapTop}" width="${mapW}" height="${mapH}" fill="none" ` +
      `stroke="#3D3D3A" stroke-width="1.4" opacity="0.35" rx="2"/>`,
    `<rect x="${mapLeft + 3}" y="${mapTop + 3}" width="${mapW - 6}" height="${mapH - 6}" fill="none" ` +
      `stroke="#3D3D3A" stroke-width="0.6" opacity="0.2" rx="1"/>`,
  );

  // 方位磁針（右上のあき地に）
  const compassX = mapLeft + mapW - 26;
  const compassY = mapTop + 26;
  parts.push(
    `<g opacity="0.55">`,
    `<circle cx="${compassX}" cy="${compassY}" r="15" fill="#FBFAF7" stroke="#3D3D3A" stroke-width="0.8"/>`,
    `<path d="M ${compassX} ${compassY - 11} L ${compassX + 3} ${compassY} L ${compassX} ${compassY + 11} L ${compassX - 3} ${compassY} Z" fill="#3D3D3A"/>`,
    `<path d="M ${compassX - 11} ${compassY} L ${compassX} ${compassY - 3} L ${compassX + 11} ${compassY} L ${compassX} ${compassY + 3} Z" fill="#3D3D3A" opacity="0.4"/>`,
    `<text x="${compassX}" y="${compassY - 18}" font-size="8" font-weight="700" fill="#3D3D3A" text-anchor="middle">N</text>`,
    `</g>`,
  );

  // ------------------------------------------------ 契約の線（都市どうしを結ぶ）
  const cityPos = (id: string) => {
    const p = w.players[id];
    if (!p || p.cities.length === 0) return null;
    const c = p.cities[0];
    return { x: mapLeft + c.x * TILE + TILE / 2, y: mapTop + c.y * TILE + TILE / 2 };
  };

  for (const c of w.contracts) {
    if (c.status !== "active" && c.status !== "broken") continue;
    const a = cityPos(c.from);
    const b = cityPos(c.to);
    if (!a || !b) continue;
    const style =
      c.status === "active"
        ? `stroke="#1D9E75" stroke-width="1.8"`
        : `stroke="#E24B4A" stroke-width="1.4" stroke-dasharray="4 3"`;
    parts.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${style} stroke-linecap="round" opacity="0.9"/>`,
    );
  }

  // -------------------------------------------------------------- 都市
  // ピン（旗）のような形にして、地図上の目印らしくする。色だけでは
  // 人数分の見分けがつかないので、IDも小さく添える。
  for (const p of Object.values(w.players)) {
    for (const c of p.cities) {
      const cx = mapLeft + c.x * TILE + TILE / 2;
      const cy = mapTop + c.y * TILE + TILE / 2;
      const headY = cy - 6;
      const color = colorOf(p.id);
      parts.push(`<g filter="url(#cityShadow)">`);
      parts.push(
        `<path d="M ${cx - 5} ${headY} L ${cx + 5} ${headY} L ${cx} ${cy} Z" fill="${color}"/>`,
        `<circle cx="${cx}" cy="${headY}" r="7" fill="${color}" stroke="#FBFAF7" stroke-width="1.6"/>`,
        `<path d="M ${cx - 5.5} ${headY - 5.5} L ${cx} ${headY - 11} L ${cx + 5.5} ${headY - 5.5} Z" ` +
          `fill="${color}"/>`,
      );
      parts.push(`</g>`);
      parts.push(
        `<text x="${cx}" y="${headY + 3}" font-size="9" font-weight="500" fill="#FFFFFF" text-anchor="middle">${c.level}</text>`,
        `<rect x="${cx - 12}" y="${cy + 2}" width="24" height="10" fill="#FBFAF7" opacity="0.9" rx="2"/>`,
        `<text x="${cx}" y="${cy + 10}" font-size="7.5" font-weight="700" fill="${color}" text-anchor="middle">${p.id}</text>`,
      );
    }
  }

  // ------------------------------------------------------------ 凡例
  const lx = mapLeft + mapW + 24;
  let ly = mapTop + 14;
  const legend: [TileKind, string][] = [
    ["food", "食料"],
    ["material", "資材"],
    ["knowledge", "知識"],
    ["waste", "荒地"],
    ["river", "川"],
  ];
  for (const [kind, label] of legend) {
    parts.push(
      `<rect x="${lx}" y="${ly - 11}" width="14" height="14" fill="${FILL[kind]}" rx="3"/>`,
      `<text x="${lx + 22}" y="${ly}" font-size="13" fill="#3D3D3A">${label}</text>`,
    );
    ly += 24;
  }
  ly += 12;

  // 人数が多いので上位のみ表示する
  const ranked = ids
    .map((id) => ({
      id,
      land: w.tiles.filter((t) => t.owner === id).length,
      lv: w.players[id].cities.reduce((s, c) => s + c.level, 0),
      trust: w.players[id].trust,
      score: totalScore(w, id),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  parts.push(
    `<text x="${lx}" y="${ly}" font-size="13" font-weight="500" fill="#3D3D3A">上位プレイヤー</text>`,
  );
  ly += 22;
  for (const r of ranked) {
    parts.push(
      `<circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${colorOf(r.id)}"/>`,
      `<text x="${lx + 20}" y="${ly}" font-size="12" fill="#3D3D3A">${r.id} · Lv${r.lv} · 領土${r.land} · 信用${r.trust}</text>`,
    );
    ly += 20;
  }

  // ------------------------------------------------- クリック/タップの当たり判定
  // 見た目には出さない透明な四角を、全マスぶん一番上に重ねる。
  // ビューア（index.html）側がこれのクリック/タップを拾って、マスの座標や中身を表示する。
  parts.push(`<g>`);
  for (const t of w.tiles) {
    const x = mapLeft + t.x * TILE;
    const y = mapTop + t.y * TILE;
    parts.push(
      `<rect class="tile-hit" data-x="${t.x}" data-y="${t.y}" x="${x}" y="${y}" ` +
        `width="${TILE}" height="${TILE}" fill="transparent" style="cursor:pointer"/>`,
    );
  }
  parts.push(`</g>`);

  parts.push("</svg>");
  return parts.join("\n");
}
