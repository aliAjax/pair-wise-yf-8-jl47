/*
 * rules.js — 同步确认规则（纯逻辑，不碰 DOM、不碰存储）
 * 职责：
 *  1. 按当前放映顺序计算每段累计起止时间
 *  2. 规定“可以确认同步”的条件
 *  3. 判断历史确认在顺序 / 时长 / 偏移 / 片边码 / 颜色 / 破损变化后是否仍然有效
 *
 * 失效判定原理（两套指纹，互不干扰）：
 *  - 时间链 timingHash：从片头开始逐段累加「片段身份 + 时长 + 声轨偏移」。
 *    第 k 段的顺序、时长或偏移一变，第 k 段及其后所有段的链值全部改变，
 *    正好对应“受影响的后续确认失效”；而第 k 段之前的确认不受影响。
 *  - 内容指纹 contentHash：只含「片边码 + 颜色偏移 + 破损情况」，
 *    只影响该段自己的确认，不会波及其它段。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FilmRules = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CHAIN_SEED = "film-sync-confirm-v1";
  const COLOR_OK = "正常";
  const DAMAGE_OK = "完好";

  const COLOR_OPTIONS = ["正常", "偏红", "偏青", "偏黄", "褪色"];
  const DAMAGE_OPTIONS = ["完好", "轻微划痕", "齿孔破损", "接片松动", "需跳过"];

  function makeId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /* 统一保留三位小数，避免 0.1 + 0.2 这类浮点误差被误判为“偏移变化” */
  function round3(value) {
    const n = toNumber(value, 0);
    return Math.round(n * 1000) / 1000;
  }

  /* FNV-1a 32 位哈希：足够做变更比对，且不依赖任何加密 API */
  function hash32(text) {
    let h = 0x811c9dc5;
    const str = String(text);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
  }

  function normalizeSegment(input) {
    const s = input || {};
    return {
      id: String(s.id || makeId()),
      code: String(s.code || ""),
      duration: toNumber(s.duration, 0),
      shift: String(s.shift || COLOR_OK),
      damage: String(s.damage || DAMAGE_OK),
      edgeCode: String(s.edgeCode == null ? "" : s.edgeCode).trim(),
      soundOffset: toNumber(s.soundOffset, 0),
      note: String(s.note || ""),
      thumb: String(s.thumb || "")
    };
  }

  /* 参与累计时间链的字段：身份（顺序）、时长、声轨偏移 */
  function timingFingerprint(seg) {
    return [seg.id, round3(seg.duration), round3(seg.soundOffset)].join("|");
  }

  /* 只影响本段确认的字段：片边码、颜色、破损 */
  function contentFingerprint(seg) {
    return [seg.edgeCode, seg.shift, seg.damage].join("|");
  }

  function contentHash(seg) {
    return hash32(contentFingerprint(seg));
  }

  /*
   * 按当前顺序计算每段累计起止时间，并附带时间链哈希。
   * 返回 { rows: [{ index, id, start, end, duration, timingHash }], total }
   */
  function buildTimeline(segments) {
    const list = (segments || []).map(normalizeSegment);
    let cursor = 0;
    let chain = hash32(CHAIN_SEED);
    const rows = list.map((seg, index) => {
      const duration = seg.duration > 0 ? seg.duration : 0;
      const start = cursor;
      const end = cursor + duration;
      chain = hash32(chain + "|" + timingFingerprint(seg));
      cursor = end;
      return {
        index,
        id: seg.id,
        start,
        end,
        duration: seg.duration,
        timingHash: chain
      };
    });
    return { rows, total: cursor };
  }

  /*
   * 不能确认同步的原因。返回空数组表示可以确认。
   * 规则：片边码必须登记；片段不能仍有颜色偏移或破损；时长必须为正数。
   */
  function blockers(seg) {
    const s = normalizeSegment(seg);
    const reasons = [];
    if (!s.edgeCode) reasons.push("片边码未登记");
    if (s.shift !== COLOR_OK) reasons.push("仍有颜色偏移（" + s.shift + "）");
    if (s.damage !== DAMAGE_OK) reasons.push("仍有破损（" + s.damage + "）");
    if (!(s.duration > 0)) reasons.push("时长无效");
    return reasons;
  }

  function findSegment(segments, id) {
    const idx = segments.findIndex((s) => s.id === id);
    return idx < 0 ? null : { seg: normalizeSegment(segments[idx]), index: idx };
  }

  function isNewer(record, other) {
    const a = Date.parse(record.at) || 0;
    const b = Date.parse(other.at) || 0;
    if (a !== b) return a > b;
    return String(record.id) > String(other.id);
  }

  /*
   * 评估一条历史确认。
   * 返回 { status: 'valid' | 'invalid' | 'superseded', reasons: [] }
   * - superseded（已被取代）：该片段后来又做过一次确认，旧确认永久留档但不再复活。
   * - invalid（已失效）：顺序 / 时长 / 偏移 / 片边码 / 颜色 / 破损变化，或片段已删除。
   */
  function evaluateConfirmation(record, segments, confirmations) {
    const found = findSegment(segments, record.segmentId);
    if (!found) {
      return { status: "invalid", reasons: ["片段已从清单删除"] };
    }

    const superseded = (confirmations || []).some(
      (other) =>
        other.segmentId === record.segmentId &&
        other.id !== record.id &&
        isNewer(other, record)
    );
    if (superseded) {
      return { status: "superseded", reasons: ["该片段已有更新的确认记录"] };
    }

    const { seg, index } = found;
    const timeline = buildTimeline(segments);
    const row = timeline.rows[index];
    const reasons = [];

    /* 内容指纹变化：只可能是本段自己的片边码 / 颜色 / 破损被改动 */
    if (contentHash(seg) !== record.contentHash) {
      if (seg.edgeCode !== String(record.edgeCode == null ? "" : record.edgeCode)) {
        reasons.push("片边码已改动");
      }
      if (seg.shift !== String(record.shift || COLOR_OK)) {
        reasons.push("颜色偏移情况已变化（" + record.shift + " → " + seg.shift + "）");
      }
      if (seg.damage !== String(record.damage || DAMAGE_OK)) {
        reasons.push("破损情况已变化（" + record.damage + " → " + seg.damage + "）");
      }
      if (!reasons.length) reasons.push("本段登记内容已变化");
    }

    /* 时间链变化：本段顺序 / 时长 / 偏移，或其前面任一段的顺序 / 时长 / 偏移 */
    if (row.timingHash !== record.timingHash) {
      if (index !== toNumber(record.index, -1)) {
        reasons.push("放映顺序已变化（确认时为第 " + (toNumber(record.index, -1) + 1) + " 段）");
      }
      if (round3(seg.duration) !== round3(record.duration)) {
        reasons.push("本段时长已变化（" + formatClock(record.duration) + " → " + formatClock(seg.duration) + "）");
      }
      if (round3(seg.soundOffset) !== round3(record.soundOffset)) {
        reasons.push("声轨偏移已变化（" + formatOffset(record.soundOffset) + " → " + formatOffset(seg.soundOffset) + " 秒）");
      }
      if (!reasons.some((r) => /顺序|时长|偏移/.test(r))) {
        reasons.push("前段的顺序、时长或偏移变化，累计起止时间已受影响");
      }
    }

    return { status: reasons.length ? "invalid" : "valid", reasons };
  }

  /* 批量评估；latest 给出每个片段“最新一条”确认的评估结果 */
  function evaluateAll(segments, confirmations) {
    const list = segments || [];
    const records = confirmations || [];
    const items = records.map((record) => ({
      record,
      evaluation: evaluateConfirmation(record, list, records)
    }));

    const latest = new Map();
    for (const item of items) {
      const id = item.record.segmentId;
      const old = latest.get(id);
      if (!old || isNewer(item.record, old.record)) latest.set(id, item);
    }
    return { items, latest };
  }

  /* 累计时间显示：H:MM:SS，有不足一秒的余数时附两位百分秒 */
  function formatClock(seconds) {
    let v = toNumber(seconds, 0);
    const neg = v < 0;
    v = Math.round(Math.abs(v) * 100) / 100;
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const s = v % 60;
    const cs = Math.round((s - Math.floor(s)) * 100);
    let text;
    if (h > 0) {
      text = h + ":" + String(m).padStart(2, "0") + ":" + String(Math.floor(s)).padStart(2, "0");
    } else {
      text = m + ":" + String(Math.floor(s)).padStart(2, "0");
    }
    if (cs) text += "." + String(cs).padStart(2, "0");
    return (neg ? "-" : "") + text;
  }

  /* 声轨偏移：秒，正值声音提前、负值声音滞后 */
  function formatOffset(value) {
    const v = round3(value);
    if (v > 0) return "+" + stripZero(v);
    if (v < 0) return "-" + stripZero(-v);
    return "0";
  }

  function stripZero(v) {
    return String(Math.round(v * 1000) / 1000);
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  /* 生成一条确认记录的快照（由 store 调用） */
  function snapshotConfirmation(seg, row) {
    const s = normalizeSegment(seg);
    return {
      id: makeId(),
      segmentId: s.id,
      at: new Date().toISOString(),
      index: row.index,
      start: row.start,
      end: row.end,
      code: s.code,
      edgeCode: s.edgeCode,
      soundOffset: s.soundOffset,
      duration: s.duration,
      shift: s.shift,
      damage: s.damage,
      timingHash: row.timingHash,
      contentHash: contentHash(s)
    };
  }

  return {
    COLOR_OK,
    DAMAGE_OK,
    COLOR_OPTIONS,
    DAMAGE_OPTIONS,
    makeId,
    normalizeSegment,
    buildTimeline,
    blockers,
    evaluateConfirmation,
    evaluateAll,
    snapshotConfirmation,
    formatClock,
    formatOffset,
    formatDateTime
  };
});
