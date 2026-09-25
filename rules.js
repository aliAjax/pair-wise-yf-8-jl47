/*
 * SyncRules —— 试映对片的纯业务规则（不碰 DOM、不碰存储）
 *
 * 职责：
 * 1. 按当前放映顺序计算每段累计起止时间；
 * 2. 判断一段是否可以“确认同步”（片边码未填 / 颜色偏移 / 破损 / 时长无效都不行）；
 * 3. 生成确认时的快照，以及比对快照与当前清单的差异，供失效判定使用。
 */
(function (global) {
  "use strict";

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function validDuration(segment) {
    const d = toNumber(segment && segment.duration);
    return Number.isFinite(d) && d > 0;
  }

  /*
   * 按当前顺序逐段累计：
   * start(i) = 前面所有段时长之和，end(i) = start(i) + 本段时长。
   * 时长无效的段按 0 处理，并由 blockers 报出，避免累计出现 NaN。
   */
  function timeline(segments) {
    let cursor = 0;
    return (segments || []).map((segment, index) => {
      const duration = validDuration(segment) ? toNumber(segment.duration) : 0;
      const row = {
        id: segment.id,
        index,
        start: cursor,
        end: cursor + duration,
        duration
      };
      cursor += duration;
      return row;
    });
  }

  /*
   * 不能确认同步的原因清单；返回空数组表示可以确认。
   */
  function blockers(segment) {
    const list = [];
    if (!String((segment && segment.edgeCode) || "").trim()) {
      list.push("片边码未填");
    }
    if (!validDuration(segment)) {
      list.push("时长无效");
    }
    if (segment.shift && segment.shift !== "正常") {
      list.push(`仍有颜色偏移（${segment.shift}）`);
    }
    if (segment.damage && segment.damage !== "完好") {
      list.push(`仍有破损（${segment.damage}）`);
    }
    return list;
  }

  /*
   * 确认同步时定格的快照：位置、累计起止、时长、声轨偏移、片边码。
   */
  function snapshot(segment, row) {
    return {
      code: segment.code,
      edgeCode: String(segment.edgeCode || "").trim(),
      index: row.index,
      start: row.start,
      end: row.end,
      duration: row.duration,
      soundOffset: toNumber(segment.soundOffset) || 0
    };
  }

  /*
   * 把旧确认快照与当前清单逐字段对比，返回发生变化的字段。
   * 顺序调整（重排/删除后续段）会体现为 index 或累计起止变化。
   */
  function diff(confirmation, segment, row) {
    const changed = [];
    if (!confirmation) return changed;
    if (confirmation.index !== row.index) changed.push("order");
    if (confirmation.start !== row.start || confirmation.end !== row.end) changed.push("timing");
    if (confirmation.duration !== row.duration) changed.push("duration");
    if (Number(confirmation.soundOffset || 0) !== (toNumber(segment.soundOffset) || 0)) {
      changed.push("offset");
    }
    if ((confirmation.edgeCode || "") !== String(segment.edgeCode || "").trim()) {
      changed.push("edgeCode");
    }
    return changed;
  }

  function diffReason(changed) {
    if (changed.includes("order")) return "放映顺序变化";
    if (changed.includes("duration") || changed.includes("timing")) return "时长变化";
    if (changed.includes("offset")) return "声轨偏移变化";
    if (changed.includes("edgeCode")) return "片边码变化";
    return "清单变化";
  }

  global.SyncRules = {
    toNumber,
    validDuration,
    timeline,
    blockers,
    snapshot,
    diff,
    diffReason
  };
})(typeof window !== "undefined" ? window : globalThis);
