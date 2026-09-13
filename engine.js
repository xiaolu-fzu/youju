/* 浏览器端 BM25 —— 与 Python 版保持一致的字符二元组分词
 *
 * 为什么必须一致：两端分词不同 -> 检索结果不同 -> 调优时的结论在线上不成立。
 * Python 版 bm25.tokenize 的做法：切出所有相邻两字组合（含英文数字块）。
 */
export function tokenize(text){
  const s = String(text);
  const out = [];
  // 英文/数字：整词小写
  for (const m of s.matchAll(/[0-9A-Za-z]+/g)) out.push(m[0].toLowerCase());
  // 中文：把所有中文字符抽出来【再两两组合】—— 注意是跨标点、跨数字组合，
  // 不是只在"纯中文片段"内组合。
  // 曾经的写法用 /^[\u4e00-\u9fff]+$/ 判断纯中文片段，导致含数字的句子
  //（如"华润微2021年面临的风险"）整句变成一个词，任何带年份的问题都检索不到。
  const cjk = s.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1]);
  return out;
}

export class BM25 {
  constructor(docs, {k1 = 1.5, b = 0.75} = {}){
    this.k1 = k1; this.b = b;
    this.n = docs.length;
    this.df = new Map();          // 词 -> 文档频率
    this.tf = [];                 // 每篇的词频
    this.len = new Int32Array(this.n);
    let total = 0;
    for (let i = 0; i < this.n; i++){
      const toks = tokenize(docs[i]);
      this.len[i] = toks.length; total += toks.length;
      const m = new Map();
      for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
      this.tf.push(m);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgdl = this.n ? total / this.n : 1;
  }
  search(query, k = 8){
    const qt = tokenize(query);
    const scores = new Float64Array(this.n);
    for (const t of new Set(qt)){
      const df = this.df.get(t);
      if (!df) continue;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.n; i++){
        const f = this.tf[i].get(t);
        if (!f) continue;
        scores[i] += idf * (f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avgdl));
      }
    }
    // 取前 k 大（简单选择，n 在万级时足够用）
    const idx = Array.from({length: this.n}, (_, i) => i);
    idx.sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, k).map(i => [i, scores[i]]).filter(x => x[1] > 0);
  }
}

/* 术语同义词扩展 —— 与 Python 版一致
 * 实测：利润表写「营业总收入」，用户问「营业收入」，二元组匹配不上，
 *       相关块会掉到 20 名开外。扩展后回到榜首。 */
export const SYNONYMS = {
  "营业收入": "营业总收入 主营业务收入 营收",
  "营收": "营业收入 营业总收入",
  "净利润": "归属于母公司所有者的净利润 归母净利润 净利润",
  "研发投入": "研发费用 研发投入 研究开发支出",
  "研发费用": "研发投入 研发费用",
  "总资产": "资产总计 总资产",
  "现金流": "经营活动产生的现金流量净额 现金流量",
  "审批权限": "审批权限 审批 决策权限 权限",
  "对外投资": "对外投资 投资",
  "关联交易": "关联交易 关联人 关联方",
  "信息披露": "信息披露 披露",
};
export function expand(q){
  const extra = Object.entries(SYNONYMS).filter(([k]) => q.includes(k)).map(([, v]) => v);
  return extra.length ? q + " " + extra.join(" ") : q;
}

/* 跨年 / 跨公司 的分组检索 —— 与 Python 版一致
 * 跨年：问"2019到2022年营收"时，各年数据散在不同块里，纯 BM25 会被"分季度数据"
 *       这类高词频块挤掉，必须按年分组保底。
 * 跨公司：问"这几家公司"时，纯 BM25 只会召回相关词密度最高的那一家。 */
export function retrieve(bm, chunks, query, k = 8, opts = {}){
  const pool = bm.search(expand(query), Math.min(300, chunks.length));
  const picked = pool.map(([i]) => chunks[i]);
  const years = [...new Set((query.match(/20\d\d/g) || []).map(Number))].sort();
  if (opts.perYear && years.length >= 2){
    const per = Math.max(4, Math.floor(k / years.length));
    const buckets = years.map(y => picked.filter(c => c.y === y));
    const out = [];
    for (let i = 0; i < per; i++) for (const b of buckets) if (b[i]) out.push(b[i]);
    for (const c of picked){ if (out.length >= Math.max(k, per * years.length)) break; if (!out.includes(c)) out.push(c); }
    return out.slice(0, Math.max(k, per * years.length));
  }
  if (opts.perCompany){
    const per = new Map();
    for (const c of picked){ const key = c.c || ""; if (!per.has(key)) per.set(key, []); per.get(key).push(c); }
    const lists = [...per.values()];
    const out = [];
    for (let i = 0; out.length < k; i++){
      let added = false;
      for (const L of lists){ if (i < L.length && out.length < k){ out.push(L[i]); added = true; } }
      if (!added) break;
    }
    return out;
  }
  return picked.slice(0, k);
}

export function buildContext(profile, picked, maxLen = 1400){
  return picked.map(c => {
    let head;
    if (profile === "c") head = "— 《" + String(c.src || "").replace("688396_", "") + "》 " + (c.s || "").slice(0, 46);
    else if (profile === "b") head = "— " + (c.c || "") + " " + (c.y || "") + "年 " + (c.s || "").slice(0, 34);
    else head = "— " + (c.y || "") + "年 " + (c.s || "").slice(0, 34);
    return head + "\n" + String(c.t).slice(0, maxLen);
  }).join("\n\n");
}

export function sources(profile, picked){
  const out = [];
  for (const c of picked){
    const s = profile === "c" ? String(c.src || "").replace("688396_", "") : profile === "b" ? (c.c || "") : (c.y + "年");
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
