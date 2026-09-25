/*
 * app.js — 页面操作（渲染与交互）
 * 规则判断只调用 FilmRules；数据读写只调用 FilmStore。
 * 本文件不保存任何业务状态：每次 store 变更后整体重渲染，刷新/重开页面数据仍在。
 */
(function () {
  "use strict";

  var Rules = window.FilmRules;
  var store = window.FilmStore.createStore();

  var fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];
  var draggedId = null;

  var els = {
    reelTitle: document.querySelector("#reelTitle"),
    colorFilter: document.querySelector("#colorFilter"),
    searchInput: document.querySelector("#searchInput"),
    segmentForm: document.querySelector("#segmentForm"),
    codeInput: document.querySelector("#codeInput"),
    durationInput: document.querySelector("#durationInput"),
    edgeCodeInput: document.querySelector("#edgeCodeInput"),
    soundOffsetInput: document.querySelector("#soundOffsetInput"),
    shiftInput: document.querySelector("#shiftInput"),
    damageInput: document.querySelector("#damageInput"),
    thumbInput: document.querySelector("#thumbInput"),
    noteInput: document.querySelector("#noteInput"),
    segmentList: document.querySelector("#segmentList"),
    warningList: document.querySelector("#warningList"),
    historyBody: document.querySelector("#historyBody"),
    totalDuration: document.querySelector("#totalDuration"),
    damageCount: document.querySelector("#damageCount"),
    segmentCount: document.querySelector("#segmentCount"),
    confirmedCount: document.querySelector("#confirmedCount"),
    exportBtn: document.querySelector("#exportBtn")
  };

  function state() {
    return store.getState();
  }

  /* 当前清单按 rules 实时复算的视图：累计时间 + 每条确认的状态 */
  function computeView() {
    var s = state();
    var timeline = Rules.buildTimeline(s.segments);
    var rowById = {};
    timeline.rows.forEach(function (row) {
      rowById[row.id] = row;
    });
    var result = Rules.evaluateAll(s.segments, s.confirmations);
    var recordsBySegment = {};
    result.items.forEach(function (item) {
      (recordsBySegment[item.record.segmentId] =
        recordsBySegment[item.record.segmentId] || []).push(item);
    });
    Object.keys(recordsBySegment).forEach(function (id) {
      recordsBySegment[id].sort(function (a, b) {
        return compareNewer(b.record, a.record); // 新确认在前
      });
    });
    return {
      rows: timeline.rows,
      total: timeline.total,
      rowById: rowById,
      latest: result.latest,
      recordsBySegment: recordsBySegment,
      allItems: result.items
    };
  }

  function compareNewer(a, b) {
    var ta = Date.parse(a.at) || 0;
    var tb = Date.parse(b.at) || 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function getFilteredSegments() {
    var color = els.colorFilter.value;
    var keyword = els.searchInput.value.trim().toLowerCase();
    return state().segments.filter(function (item) {
      var matchesColor = color === "all" || item.shift === color;
      var hay = (item.code + item.edgeCode + item.note + item.damage).toLowerCase();
      var matchesKeyword = !keyword || hay.indexOf(keyword) >= 0;
      return matchesColor && matchesKeyword;
    });
  }

  function renderStats(view) {
    var s = state();
    var confirmed = 0;
    view.latest.forEach(function (item) {
      if (item.evaluation.status === "valid") confirmed += 1;
    });
    var damaged = s.segments.filter(function (item) {
      return item.damage !== Rules.DAMAGE_OK || item.shift !== Rules.COLOR_OK;
    }).length;
    els.totalDuration.textContent = Rules.formatClock(view.total);
    els.confirmedCount.textContent = confirmed;
    els.damageCount.textContent = damaged;
    els.segmentCount.textContent = s.segments.length;
  }

  function optionTags(current, options, field, id) {
    return options
      .map(function (value) {
        var sel = value === current ? " selected" : "";
        return '<option value="' + escapeHtml(value) + '"' + sel + ">" + escapeHtml(value) + "</option>";
      })
      .join("");
  }

  function statusBadge(view, segId) {
    var item = view.latest.get(segId);
    if (!item) {
      return '<span class="badge idle">未确认</span>';
    }
    if (item.evaluation.status === "valid") {
      return '<span class="badge ok">✓ 已确认同步</span>';
    }
    if (item.evaluation.status === "superseded") {
      return '<span class="badge old">旧确认（已被取代）</span>';
    }
    return '<span class="badge bad">确认已失效</span>';
  }

  function cardHistory(view, segId) {
    var items = (view.recordsBySegment[segId] || []).slice().sort(function (a, b) {
      return compareNewer(b.record, a.record);
    });
    if (!items.length) return "";
    var rows = items
      .map(function (item) {
        var r = item.record;
        var e = item.evaluation;
        var cls = e.status === "valid" ? "ok" : e.status === "superseded" ? "old" : "bad";
        var label =
          e.status === "valid"
            ? "有效"
            : e.status === "superseded"
            ? "已被取代"
            : "已失效";
        var detail = e.reasons.length
          ? '<div class="mini-reason">' + e.reasons.map(escapeHtml).join("；") + "</div>"
          : '<div class="mini-reason">与当前清单一致</div>';
        return (
          '<div class="mini-record ' +
          cls +
          '">' +
          "<div>" +
          escapeHtml(Rules.formatDateTime(r.at)) +
          " · 第 " +
          (r.index + 1) +
          " 段 · " +
          escapeHtml(Rules.formatClock(r.start)) +
          "–" +
          escapeHtml(Rules.formatClock(r.end)) +
          " · 片边码 " +
          escapeHtml(r.edgeCode || "（空）") +
          " · 声轨 " +
          escapeHtml(Rules.formatOffset(r.soundOffset)) +
          " 秒</div>" +
          '<div><span class="mini-badge ' +
          cls +
          '">' +
          label +
          "</span></div>" +
          detail +
          "</div>"
        );
      })
      .join("");
    return (
      '<details class="card-history"><summary>本段确认历史（' +
      items.length +
      " 条）</summary>" +
      rows +
      "</details>"
    );
  }

  function renderList(view) {
    var s = state();
    var visible = getFilteredSegments();
    if (!visible.length) {
      els.segmentList.innerHTML = '<p class="empty">没有符合筛选的片段。</p>';
      return;
    }

    els.segmentList.innerHTML = visible
      .map(function (item) {
        var realIndex = s.segments.findIndex(function (seg) {
          return seg.id === item.id;
        });
        var row = view.rowById[item.id];
        var latest = view.latest.get(item.id);
        var invalidReasons =
          latest && latest.evaluation.status === "invalid" ? latest.evaluation.reasons : [];
        var blockReasons = Rules.blockers(item);
        var canConfirm = blockReasons.length === 0;
        var hasDamage = item.damage !== Rules.DAMAGE_OK;
        var thumb = item.thumb
          ? '<img src="' + item.thumb + '" alt="' + escapeHtml(item.code) + '缩略图" />'
          : '<div class="film-placeholder" style="background:' +
            fallbackThumbs[realIndex % fallbackThumbs.length] +
            '">' +
            escapeHtml(item.code) +
            "</div>";

        var reasonLine = blockReasons.length
          ? '<div class="sync-reasons block">不能确认：' + blockReasons.map(escapeHtml).join("；") + "</div>"
          : invalidReasons.length
          ? '<div class="sync-reasons invalid">' + invalidReasons.map(escapeHtml).join("；") + "</div>"
          : latest && latest.evaluation.status === "valid"
          ? '<div class="sync-reasons ok">声画同步有效：片边码、偏移、累计时间均一致。</div>'
          : "";

        return (
          '<article class="segment-card" data-id="' + item.id + '">' +
          '<div class="drag-handle" title="按住拖动调整顺序">≡</div>' +
          '<div class="thumb">' + thumb + "</div>" +
          '<div class="segment-main">' +
          '<div class="segment-title">' +
          "<strong>" +
          (realIndex + 1) +
          ". " +
          escapeHtml(item.code) +
          "</strong>" +
          '<span class="time-chip">累计 ' +
          escapeHtml(Rules.formatClock(row.start)) +
          " → " +
          escapeHtml(Rules.formatClock(row.end)) +
          "</span>" +
          '<span class="tag ' +
          (item.shift === Rules.COLOR_OK ? "ok" : "damage") +
          '">' +
          escapeHtml(item.shift) +
          "</span>" +
          '<span class="tag ' +
          (hasDamage ? "damage" : "ok") +
          '">' +
          escapeHtml(item.damage) +
          "</span>" +
          "</div>" +
          '<p class="segment-note">' +
          escapeHtml(item.note || "没有备注。") +
          "</p>" +
          '<div class="segment-actions">' +
          '<button type="button" title="上移" data-move-up="' + item.id + '">↑</button>' +
          '<button type="button" title="下移" data-move-down="' + item.id + '">↓</button>' +
          '<button type="button" class="danger" title="删除" data-delete="' +
            item.id +
            '">×</button>' +
          "</div>" +
          "</div>" +
          '<div class="sync-strip">' +
          '<label class="field">起<input readonly value="' +
          escapeHtml(Rules.formatClock(row.start)) +
          '" /></label>' +
          '<label class="field">止<input readonly value="' +
          escapeHtml(Rules.formatClock(row.end)) +
          '" /></label>' +
          '<label class="field">时长秒<input type="number" step="0.1" min="0" data-field="duration" data-id="' +
          item.id +
          '" value="' +
          escapeHtml(String(item.duration)) +
          '" /></label>' +
          '<label class="field grow">片边码<input type="text" data-field="edgeCode" data-id="' +
          item.id +
          '" value="' +
          escapeHtml(item.edgeCode) +
          '" placeholder="必填，如 KA 0123-0141" /></label>' +
          '<label class="field">声轨偏移(秒)<input type="number" step="0.05" data-field="soundOffset" data-id="' +
          item.id +
          '" value="' +
          escapeHtml(String(item.soundOffset)) +
          '" /></label>' +
          '<label class="field compact">颜色<select data-field="shift" data-id="' +
          item.id +
          '">' +
          optionTags(item.shift, Rules.COLOR_OPTIONS, "shift", item.id) +
          "</select></label>" +
          '<label class="field compact">破损<select data-field="damage" data-id="' +
          item.id +
          '">' +
          optionTags(item.damage, Rules.DAMAGE_OPTIONS, "damage", item.id) +
          "</select></label>" +
          '<div class="confirm-cell">' +
          statusBadge(view, item.id) +
          '<button type="button" class="primary small" data-confirm="' +
          item.id +
          '"' +
          (canConfirm ? "" : " disabled") +
          ">确认同步</button>" +
          "</div>" +
          reasonLine +
          cardHistory(view, item.id) +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderHistoryTable(view) {
    var s = state();
    var items = view.allItems.slice().sort(function (a, b) {
      return compareNewer(b.record, a.record);
    });
    if (!items.length) {
      els.historyBody.innerHTML =
        '<tr><td colspan="7" class="empty">还没有确认记录。登记片边码并排除偏色 / 破损后，点“确认同步”。</td></tr>';
      return;
    }
    els.historyBody.innerHTML = items
      .map(function (item) {
        var r = item.record;
        var e = item.evaluation;
        var stillExists = s.segments.some(function (seg) {
          return seg.id === r.segmentId;
        });
        var code = stillExists ? escapeHtml(r.code) : escapeHtml(r.code) + "（已删除）";
        var cls = e.status === "valid" ? "ok" : e.status === "superseded" ? "old" : "bad";
        var label =
          e.status === "valid"
            ? "有效"
            : e.status === "superseded"
            ? "已被取代"
            : "已失效";
        return (
          "<tr>" +
          "<td>" + escapeHtml(Rules.formatDateTime(r.at)) + "</td>" +
          "<td>第 " + (r.index + 1) + " 段</td>" +
          "<td>" + code + "</td>" +
          "<td>" + escapeHtml(r.edgeCode || "（空）") + "</td>" +
          "<td>" + escapeHtml(Rules.formatOffset(r.soundOffset)) + " 秒</td>" +
          "<td>" +
          escapeHtml(Rules.formatClock(r.start)) +
          "–" +
          escapeHtml(Rules.formatClock(r.end)) +
          "</td>" +
          '<td><span class="mini-badge ' + cls + '">' + label + "</span>" +
          (e.reasons.length
            ? '<div class="mini-reason">' + e.reasons.map(escapeHtml).join("；") + "</div>"
            : "") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderWarnings() {
    var s = state();
    var warnings = s.segments.filter(function (item) {
      return Rules.blockers(item).length > 0;
    });
    els.warningList.innerHTML = warnings
      .map(function (item) {
        var index =
          s.segments.findIndex(function (seg) {
            return seg.id === item.id;
          }) + 1;
        var reasons = Rules.blockers(item)
          .filter(function (r) {
            return r !== "时长无效";
          })
          .join(" · ");
        return (
          '<div class="warning-item">' +
          "<strong>" +
          index +
          ". " +
          escapeHtml(item.code) +
          "</strong>" +
          "<span>" +
          escapeHtml(reasons) +
          (item.note ? "：" + escapeHtml(item.note) : "") +
          "</span></div>"
        );
      })
      .join("");
    if (!warnings.length) {
      els.warningList.innerHTML =
        '<p class="empty">全部片段均已登记片边码，且无颜色偏移 / 破损，可以逐段确认同步。</p>';
    }
  }

  function renderAll() {
    var view = computeView();
    els.reelTitle.value = state().reelTitle;
    renderStats(view);
    renderList(view);
    renderHistoryTable(view);
    renderWarnings();
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve) {
      if (!file) {
        resolve("");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        resolve("");
      };
      reader.readAsDataURL(file);
    });
  }

  function addSegment(event) {
    event.preventDefault();
    readFileAsDataUrl(els.thumbInput.files[0]).then(function (thumb) {
      store.addSegment({
        code: els.codeInput.value.trim(),
        duration: els.durationInput.value,
        edgeCode: els.edgeCodeInput.value,
        soundOffset: els.soundOffsetInput.value,
        shift: els.shiftInput.value,
        damage: els.damageInput.value,
        note: els.noteInput.value.trim(),
        thumb: thumb
      });
      els.segmentForm.reset();
      els.durationInput.value = 12;
      els.soundOffsetInput.value = 0;
    });
  }

  function exportList() {
    var s = state();
    var view = computeView();
    var lines = [
      "胶片卷：" + (s.reelTitle || "未命名胶片卷"),
      "导出时间：" + Rules.formatDateTime(new Date().toISOString()),
      "总时长：" + Rules.formatClock(view.total),
      "",
      "序号 | 片段 | 累计起 | 累计止 | 时长(秒) | 片边码 | 声轨偏移(秒) | 颜色 | 破损 | 同步状态 | 备注"
    ];
    s.segments.forEach(function (seg, index) {
      var row = view.rowById[seg.id];
      var item = view.latest.get(seg.id);
      var statusText = "未确认";
      if (item) {
        if (item.evaluation.status === "valid") {
          statusText = "已确认同步";
        } else if (item.evaluation.status === "superseded") {
          statusText = "旧确认已被取代";
        } else {
          statusText = "确认已失效：" + item.evaluation.reasons.join("；");
        }
      }
      lines.push(
        [
          index + 1,
          seg.code,
          Rules.formatClock(row.start),
          Rules.formatClock(row.end),
          seg.duration,
          seg.edgeCode || "（未登记）",
          Rules.formatOffset(seg.soundOffset),
          seg.shift,
          seg.damage,
          statusText,
          seg.note || "无备注"
        ].join(" | ")
      );
    });
    var blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = (s.reelTitle || "film-reel") + "-sync-checklist.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /* ---- 事件绑定 ---- */

  els.reelTitle.addEventListener("change", function () {
    store.setReelTitle(els.reelTitle.value);
  });
  els.colorFilter.addEventListener("change", renderAll);
  els.searchInput.addEventListener("input", renderAll);
  els.segmentForm.addEventListener("submit", addSegment);
  els.exportBtn.addEventListener("click", exportList);

  els.segmentList.addEventListener("change", function (event) {
    var field = event.target.getAttribute("data-field");
    var id = event.target.getAttribute("data-id");
    if (!field || !id) return;
    store.updateSegment(id, (function () {
      var patch = {};
      patch[field] = field === "duration" || field === "soundOffset"
        ? Number(event.target.value)
        : event.target.value;
      return patch;
    })());
  });

  els.segmentList.addEventListener("click", function (event) {
    var confirmBtn = event.target.closest("[data-confirm]");
    var up = event.target.closest("[data-move-up]");
    var down = event.target.closest("[data-move-down]");
    var remove = event.target.closest("[data-delete]");
    if (confirmBtn) {
      var result = store.confirmSync(confirmBtn.dataset.confirm);
      if (!result.ok) {
        confirmBtn.title = result.reasons.join("；");
      }
    }
    if (up) store.moveSegment(up.dataset.moveUp, -1);
    if (down) store.moveSegment(down.dataset.moveDown, 1);
    if (remove && window.confirm("删除该片段？其同步确认记录会保留在历史中并标记失效。")) {
      store.removeSegment(remove.dataset.delete);
    }
  });

  els.segmentList.addEventListener("dragstart", function (event) {
    if (!event.target.classList || !event.target.classList.contains("drag-handle")) {
      event.preventDefault();
      return;
    }
    var card = event.target.closest("[data-id]");
    if (!card) return;
    draggedId = card.dataset.id;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedId);
  });

  els.segmentList.addEventListener("dragend", function (event) {
    var card = event.target.closest && event.target.closest("[data-id]");
    if (card) card.classList.remove("dragging");
    draggedId = null;
  });

  els.segmentList.addEventListener("dragover", function (event) {
    var card = event.target.closest && event.target.closest(".segment-card");
    if (!card || !draggedId || card.dataset.id === draggedId) return;
    event.preventDefault();
    var s = state();
    var fromIndex = s.segments.findIndex(function (item) {
      return item.id === draggedId;
    });
    var toIndex = s.segments.findIndex(function (item) {
      return item.id === card.dataset.id;
    });
    if (fromIndex < 0 || toIndex < 0) return;
    store.reorderSegment(draggedId, toIndex);
  });

  store.subscribe(renderAll);
  renderAll();
})();
