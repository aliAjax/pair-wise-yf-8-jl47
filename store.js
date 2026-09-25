/*
 * store.js — 清单保存（localStorage，无后台、无依赖）
 * 职责：
 *  1. 读写整份核对清单（片段顺序、时长、片边码、声轨偏移、颜色、破损、确认历史）
 *  2. 所有改动在此提交并立即落盘，页面关掉再打开接着核对
 *  3. 不决定“确认是否有效”——判定一律走 rules.js；旧确认记录永不删除，只追加
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rules.js"));
  } else {
    root.FilmStore = factory(root.FilmRules);
  }
})(typeof self !== "undefined" ? self : this, function (Rules) {
  "use strict";

  var STORAGE_KEY = "zfl17-film-strip-desk"; // 沿用原键，已有用户的数据自动迁移
  var SCHEMA_VERSION = 2;

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      reelTitle: "春日试映A卷",
      segments: [
        {
          id: Rules.makeId(),
          code: "A-001",
          duration: 18,
          shift: "正常",
          damage: "完好",
          edgeCode: "KA 0123-0141",
          soundOffset: 0,
          note: "开场街景，节奏平稳，适合保留原顺序。",
          thumb: ""
        },
        {
          id: Rules.makeId(),
          code: "A-006",
          duration: 9,
          shift: "偏红",
          damage: "轻微划痕",
          edgeCode: "",
          soundOffset: 0,
          note: "人物近景左侧有划痕，修复后才能确认同步。",
          thumb: ""
        },
        {
          id: Rules.makeId(),
          code: "A-012",
          duration: 14,
          shift: "褪色",
          damage: "接片松动",
          edgeCode: "KA 0246-0260",
          soundOffset: -0.5,
          note: "接片位置靠近段尾，声音约滞后半秒。",
          thumb: ""
        }
      ],
      confirmations: []
    };
  }

  /* 把旧版本 / 部分字段的数据补齐成当前结构，原有纸卡记录不丢 */
  function migrate(raw) {
    var base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    return {
      version: SCHEMA_VERSION,
      reelTitle: typeof raw.reelTitle === "string" ? raw.reelTitle : base.reelTitle,
      segments: Array.isArray(raw.segments) ? raw.segments.map(Rules.normalizeSegment) : [],
      confirmations: Array.isArray(raw.confirmations) ? raw.confirmations : []
    };
  }

  function createStore(options) {
    var storage =
      (options && options.storage) ||
      (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
    var listeners = [];
    var state = load();

    function memoryStorage() {
      var map = {};
      return {
        getItem: function (k) {
          return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
        },
        setItem: function (k, v) {
          map[k] = String(v);
        },
        removeItem: function (k) {
          delete map[k];
        }
      };
    }

    function load() {
      var raw = null;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch (e) {
        raw = null;
      }
      if (!raw) return defaultState();
      try {
        return migrate(JSON.parse(raw));
      } catch (e) {
        return defaultState();
      }
    }

    function save() {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        /* 存储不可用（隐私模式等）时本会话仍可用 */
      }
    }

    function emit() {
      listeners.slice().forEach(function (fn) {
        fn(state);
      });
    }

    function commit() {
      save();
      emit();
    }

    function findIndex(id) {
      return state.segments.findIndex(function (s) {
        return s.id === id;
      });
    }

    /* 只允许写入已知字段，时长 / 偏移统一转数字，片边码去首尾空格 */
    function applyPatch(target, patch) {
      var p = patch || {};
      if (Object.prototype.hasOwnProperty.call(p, "code")) target.code = String(p.code);
      if (Object.prototype.hasOwnProperty.call(p, "duration"))
        target.duration = Number(p.duration) || 0;
      if (Object.prototype.hasOwnProperty.call(p, "shift")) target.shift = String(p.shift);
      if (Object.prototype.hasOwnProperty.call(p, "damage")) target.damage = String(p.damage);
      if (Object.prototype.hasOwnProperty.call(p, "edgeCode"))
        target.edgeCode = String(p.edgeCode == null ? "" : p.edgeCode).trim();
      if (Object.prototype.hasOwnProperty.call(p, "soundOffset"))
        target.soundOffset = Number(p.soundOffset) || 0;
      if (Object.prototype.hasOwnProperty.call(p, "note")) target.note = String(p.note);
      if (Object.prototype.hasOwnProperty.call(p, "thumb")) target.thumb = String(p.thumb);
    }

    /* ---- 对外操作 ---- */

    function setReelTitle(title) {
      state.reelTitle = String(title == null ? "" : title);
      commit();
    }

    function addSegment(patch) {
      var seg = Rules.normalizeSegment({ id: Rules.makeId() });
      applyPatch(seg, patch);
      state.segments.push(seg);
      commit();
      return seg;
    }

    function updateSegment(id, patch) {
      var idx = findIndex(id);
      if (idx < 0) return false;
      applyPatch(state.segments[idx], patch);
      commit();
      return true;
    }

    function removeSegment(id) {
      var idx = findIndex(id);
      if (idx < 0) return false;
      state.segments.splice(idx, 1);
      commit();
      return true;
    }

    function moveSegment(id, direction) {
      var idx = findIndex(id);
      var target = idx + direction;
      if (idx < 0 || target < 0 || target >= state.segments.length) return false;
      var item = state.segments.splice(idx, 1)[0];
      state.segments.splice(target, 0, item);
      commit();
      return true;
    }

    function reorderSegment(id, toIndex) {
      var from = findIndex(id);
      if (from < 0 || toIndex < 0 || toIndex >= state.segments.length) return false;
      var item = state.segments.splice(from, 1)[0];
      state.segments.splice(toIndex, 0, item);
      commit();
      return true;
    }

    /*
     * 登记一次“同步确认”。
     * 规则仍在 rules.js：此处先检查 blockers，不允许确认时返回 { ok:false, reasons }。
     * 允许确认时只追加一条新快照；该片段之前的确认保留，由规则层标记为 superseded。
     */
    function confirmSync(segmentId) {
      var idx = findIndex(segmentId);
      if (idx < 0) return { ok: false, reasons: ["片段不存在"] };
      var seg = state.segments[idx];
      var reasons = Rules.blockers(seg);
      if (reasons.length) return { ok: false, reasons: reasons };
      var row = Rules.buildTimeline(state.segments).rows[idx];
      var record = Rules.snapshotConfirmation(seg, row);
      state.confirmations.push(record);
      commit();
      return { ok: true, record: record };
    }

    function resetAll() {
      state = defaultState();
      commit();
    }

    function getState() {
      return state;
    }

    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== fn;
        });
      };
    }

    return {
      getState: getState,
      subscribe: subscribe,
      setReelTitle: setReelTitle,
      addSegment: addSegment,
      updateSegment: updateSegment,
      removeSegment: removeSegment,
      moveSegment: moveSegment,
      reorderSegment: reorderSegment,
      confirmSync: confirmSync,
      resetAll: resetAll,
      STORAGE_KEY: STORAGE_KEY
    };
  }

  return { createStore: createStore, migrate: migrate, defaultState: defaultState };
});
