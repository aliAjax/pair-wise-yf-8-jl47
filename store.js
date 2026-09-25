/*
 * SyncStore —— 清单保存与状态流转（只依赖 localStorage 和 SyncRules）
 *
 * 失效规则（在本文件统一执行，任何入口都一样）：
 * - 顺序调整：从受影响的最早位置起，后续确认全部失效；
 * - 某段时长变化：该段及其后确认失效（累计时间变了）；
 * - 某段声轨偏移变化：该段及其后确认失效（声轨参照位置变了）；
 * - 某段片边码变化：只失效该段确认；
 * - 某段颜色偏移/破损标记变化：只失效该段确认（且未恢复前不能重新确认）；
 * - 删除片段：该段确认记为“片段删除”，其后因顺序变化失效。
 * 旧确认不删除，统一转入 history 可随时查看。
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "zfl17-film-strip-desk";

  const defaultState = {
    reelTitle: "春日试映A卷",
    segments: [
      sampleSegment("A-001", 18, "正常", "完好", "开场街景，节奏平稳，适合保留原顺序。"),
      sampleSegment("A-006", 9, "偏红", "轻微划痕", "人物近景左侧有划痕，试映时留意是否明显。"),
      sampleSegment("A-012", 14, "褪色", "接片松动", "接片位置靠近段尾，放映前建议重新压平。")
    ],
    history: []
  };

  function sampleSegment(code, duration, shift, damage, note) {
    return {
      id: uid(),
      code,
      duration,
      shift,
      damage,
      note,
      thumb: "",
      edgeCode: "",
      soundOffset: 0
    };
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeSegment(segment) {
    return {
      id: segment.id || uid(),
      code: segment.code || "",
      duration: segment.duration === "" || segment.duration == null ? "" : Number(segment.duration),
      shift: segment.shift || "正常",
      damage: segment.damage || "完好",
      note: segment.note || "",
      thumb: segment.thumb || "",
      edgeCode: segment.edgeCode || "",
      soundOffset: segment.soundOffset === "" || segment.soundOffset == null ? 0 : Number(segment.soundOffset),
      // 已有确认必须原样保留，规范化只补齐登记字段，不能顺手抹掉确认。
      confirmed: segment.confirmed || null
    };
  }

  let state = loadState();
  // 最近一次操作导致失效的确认，供页面提示；不持久化。
  let lastRetired = [];

  function loadState() {
    let loaded = null;
    try {
      loaded = JSON.parse(global.localStorage.getItem(STORAGE_KEY));
    } catch {
      loaded = null;
    }
    const base = loaded || defaultState;
    const merged = {
      reelTitle: base.reelTitle || "",
      segments: Array.isArray(base.segments) ? base.segments.map(normalizeSegment) : [],
      history: Array.isArray(base.history) ? base.history : []
    };
    // 重新打开页面后做一次兜底对账：外部改动过的存储也能自动判定失效。
    const reconciledDirty = reconcile(merged);
    if (reconciledDirty) {
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // 存储不可用时忽略，本次会话内的状态仍然有效。
      }
    }
    return merged;
  }

  function persist() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 存储不可用时仅保留本次会话状态，不打断核对。
    }
  }

  function getState() {
    return state;
  }

  function rows() {
    return SyncRules.timeline(state.segments);
  }

  function findSegment(id) {
    return state.segments.find((segment) => segment.id === id) || null;
  }

  function setReelTitle(title) {
    state.reelTitle = title;
    persist();
  }

  function addSegment(input) {
    const segment = normalizeSegment(input);
    state.segments.push(segment);
    lastRetired = [];
    persist();
    return { retired: [] };
  }

  /*
   * 就地修改一段字段。按变化类型决定失效范围，最后只执行一次失效。
   */
  function updateSegment(id, patch) {
    const index = state.segments.findIndex((segment) => segment.id === id);
    if (index < 0) return { retired: [] };
    const before = state.segments[index];
    const next = normalizeSegment({ ...before, ...patch, id });

    const affectsCascade =
      SyncRules.toNumber(before.duration) !== SyncRules.toNumber(next.duration) ||
      (SyncRules.toNumber(before.soundOffset) || 0) !== (SyncRules.toNumber(next.soundOffset) || 0);
    const edgeChanged =
      String(before.edgeCode || "").trim() !== String(next.edgeCode || "").trim();
    const markChanged =
      before.shift !== next.shift || before.damage !== next.damage;

    state.segments[index] = next;

    let retired = [];
    if (affectsCascade) {
      const reason =
        SyncRules.toNumber(before.duration) !== SyncRules.toNumber(next.duration)
          ? "时长变化"
          : "声轨偏移变化";
      retired = retireFrom(index, reason);
    } else if (edgeChanged) {
      retired = retireOne(id, "片边码变化");
    } else if (markChanged) {
      retired = retireOne(id, "片段标记变化（颜色偏移/破损）");
    }
    lastRetired = retired;
    persist();
    return { retired };
  }

  /*
   * 相邻移动 / 拖拽重排都走这里。
   * 只要确认快照里的位置或累计时间与当前对不上，就从最早错位处起失效。
   */
  function reorderSegment(id, targetIndex) {
    const from = state.segments.findIndex((segment) => segment.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= state.segments.length || from === targetIndex) {
      lastRetired = [];
      return { retired: [] };
    }
    const [moved] = state.segments.splice(from, 1);
    state.segments.splice(targetIndex, 0, moved);

    const timelineRows = SyncRules.timeline(state.segments);
    let earliest = state.segments.length;
    state.segments.forEach((segment, index) => {
      const confirmation = segment.confirmed;
      if (!confirmation) return;
      const row = timelineRows[index];
      if (SyncRules.diff(confirmation, segment, row).length > 0) {
        earliest = Math.min(earliest, index);
      }
    });
    const retired = earliest < state.segments.length ? retireFrom(earliest, "放映顺序变化") : [];
    lastRetired = retired;
    persist();
    return { retired };
  }

  function removeSegment(id) {
    const index = state.segments.findIndex((segment) => segment.id === id);
    if (index < 0) return { retired: [] };
    const own = retireOne(id, "片段删除");
    const following = retireFrom(index, "放映顺序变化");
    state.segments.splice(index, 1);
    lastRetired = own.concat(following);
    persist();
    return { retired: own.concat(following) };
  }

  function confirmSegment(id) {
    const index = state.segments.findIndex((segment) => segment.id === id);
    if (index < 0) return { retired: [] };
    const segment = state.segments[index];
    if (SyncRules.blockers(segment).length > 0) {
      lastRetired = [];
      return { retired: [], blocked: true };
    }
    const row = SyncRules.timeline(state.segments)[index];
    state.segments[index] = {
      ...segment,
      confirmed: {
        ...SyncRules.snapshot(segment, row),
        confirmedAt: nowIso()
      }
    };
    lastRetired = [];
    persist();
    return { retired: [] };
  }

  function historyFor(id) {
    return state.history
      .filter((entry) => entry.segmentId === id)
      .sort((a, b) => (a.retiredAt < b.retiredAt ? 1 : -1));
  }

  function allHistory() {
    return state.history
      .slice()
      .sort((a, b) => (a.retiredAt < b.retiredAt ? 1 : -1));
  }

  function popLastRetired() {
    const retired = lastRetired;
    lastRetired = [];
    return retired;
  }

  /*
   * 内部：从某位置起把仍有效的确认全部转入历史。
   */
  function retireFrom(index, reason) {
    const retired = [];
    for (let i = index; i < state.segments.length; i += 1) {
      const segment = state.segments[i];
      if (segment && segment.confirmed) {
        retired.push(archive(segment, reason));
        state.segments[i] = { ...segment, confirmed: null };
      }
    }
    return retired;
  }

  function retireOne(id, reason) {
    const index = state.segments.findIndex((segment) => segment.id === id);
    if (index < 0 || !state.segments[index].confirmed) return [];
    const segment = state.segments[index];
    const archived = archive(segment, reason);
    state.segments[index] = { ...segment, confirmed: null };
    return [archived];
  }

  function archive(segment, reason) {
    const record = {
      historyId: uid(),
      segmentId: segment.id,
      code: segment.code,
      edgeCode: segment.confirmed.edgeCode,
      reason,
      confirmedAt: segment.confirmed.confirmedAt,
      retiredAt: nowIso(),
      confirmed: { ...segment.confirmed }
    };
    state.history.unshift(record);
    return record;
  }

  /*
   * 内部：加载后兜底对账——快照与现状对不上的旧确认立即失效并留痕。
   */
  function reconcile(target) {
    const timelineRows = SyncRules.timeline(target.segments);
    let dirty = false;
    target.segments.forEach((segment, index) => {
      const confirmation = segment.confirmed;
      if (!confirmation) return;
      const row = timelineRows[index];
      const changed = SyncRules.diff(confirmation, segment, row);
      const marks = SyncRules.blockers(segment).filter(
        (text) => text.includes("颜色偏移") || text.includes("破损")
      );
      if (changed.length > 0) {
        archiveInto(target, segment, SyncRules.diffReason(changed));
        target.segments[index] = { ...segment, confirmed: null };
        dirty = true;
      } else if (marks.length > 0) {
        archiveInto(target, segment, "片段标记变化（颜色偏移/破损）");
        target.segments[index] = { ...segment, confirmed: null };
        dirty = true;
      }
    });
    return dirty;
  }

  function archiveInto(target, segment, reason) {
    target.history.unshift({
      historyId: uid(),
      segmentId: segment.id,
      code: segment.code,
      edgeCode: segment.confirmed.edgeCode,
      reason,
      confirmedAt: segment.confirmed.confirmedAt,
      retiredAt: nowIso(),
      confirmed: { ...segment.confirmed }
    });
  }

  global.SyncStore = {
    uid,
    getState,
    rows,
    findSegment,
    setReelTitle,
    addSegment,
    updateSegment,
    reorderSegment,
    removeSegment,
    confirmSegment,
    historyFor,
    allHistory,
    popLastRetired,
    persist
  };
})(typeof window !== "undefined" ? window : globalThis);
