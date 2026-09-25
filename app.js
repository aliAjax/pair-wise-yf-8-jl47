/*
 * app —— 页面操作层：渲染、表单、行内登记、确认同步、历史查看。
 * 规则见 rules.js，保存与状态流转见 store.js，本文件不直接改 localStorage。
 */
const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

let draggedId = null;
let historyFilterId = null;

const els = {
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
  totalDuration: document.querySelector("#totalDuration"),
  damageCount: document.querySelector("#damageCount"),
  segmentCount: document.querySelector("#segmentCount"),
  syncCount: document.querySelector("#syncCount"),
  exportBtn: document.querySelector("#exportBtn"),
  historyBtn: document.querySelector("#historyBtn"),
  historyModal: document.querySelector("#historyModal"),
  historyCloseBtn: document.querySelector("#historyCloseBtn"),
  historyList: document.querySelector("#historyList"),
  historyScope: document.querySelector("#historyScope"),
  toast: document.querySelector("#toast")
};

function getState() {
  return SyncStore.getState();
}

function getFilteredSegments() {
  const state = getState();
  const color = els.colorFilter.value;
  const keyword = els.searchInput.value.trim();
  return state.segments.filter((item) => {
    const matchesColor = color === "all" || item.shift === color;
    const haystack = `${item.code}${item.note}${item.damage}${item.edgeCode}`;
    const matchesKeyword = !keyword || haystack.includes(keyword);
    return matchesColor && matchesKeyword;
  });
}

function renderStats() {
  const state = getState();
  const total = SyncRules.timeline(state.segments).reduce((sum, row) => sum + row.duration, 0);
  const damaged = state.segments.filter((item) => item.damage !== "完好").length;
  const synced = state.segments.filter((item) => Boolean(item.confirmed)).length;
  els.totalDuration.textContent = formatClock(total);
  els.damageCount.textContent = damaged;
  els.segmentCount.textContent = state.segments.length;
  els.syncCount.textContent = synced;
}

function renderList() {
  const state = getState();
  const timelineRows = SyncRules.timeline(state.segments);
  const rowById = new Map(timelineRows.map((row) => [row.id, row]));
  const segments = getFilteredSegments();

  els.segmentList.innerHTML =
    segments
      .map((item) => {
        const realIndex = state.segments.findIndex((segment) => segment.id === item.id);
        const row = rowById.get(item.id);
        return renderSegmentCard(item, row, realIndex);
      })
      .join("") || `<p class="empty">没有符合筛选的片段。</p>`;
}

function renderSegmentCard(item, row, realIndex) {
  const hasDamage = item.damage !== "完好";
  const tagClass = item.shift === "正常" ? "ok" : "damage";
  const confirmed = item.confirmed;
  const problems = SyncRules.blockers(item);
  const canConfirm = problems.length === 0;

  const syncPanel = confirmed
    ? `
      <div class="sync-box is-confirmed">
        <span class="sync-badge">✓ 已确认同步</span>
        <span class="sync-meta">确认于 ${formatDateTime(confirmed.confirmedAt)} · 声轨偏移 ${formatSigned(
          confirmed.soundOffset
        )}s</span>
        <button type="button" class="link-btn" data-history="${item.id}">该段历史</button>
      </div>`
    : `
      <div class="sync-box ${canConfirm ? "is-ready" : "is-blocked"}">
        <div class="sync-left">
          <span class="sync-badge ${canConfirm ? "ready" : "blocked"}">${
        canConfirm ? "可确认同步" : "不能确认"
      }</span>
          ${
            problems.length
              ? `<span class="blockers">${problems.map((text) => `<em>${escapeHtml(text)}</em>`).join("")}</span>`
              : `<span class="blockers"><em>核对片边码与偏移后点确认</em></span>`
          }
        </div>
        <div class="sync-actions">
          <button type="button" class="primary small" data-confirm="${item.id}" ${
        canConfirm ? "" : "disabled"
      } title="${canConfirm ? "按当前顺序与登记值确认同步" : problems.join("、")}">确认同步</button>
          <button type="button" class="link-btn" data-history="${item.id}">该段历史</button>
        </div>
      </div>`;

  return `
    <article class="segment-card" data-id="${item.id}">
      <div class="drag-handle" draggable="true" title="拖拽手柄：按住调整放映顺序">⠿</div>
      <div class="thumb">
        ${
          item.thumb
            ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
            : `<div class="film-placeholder" style="background:${
                fallbackThumbs[realIndex % fallbackThumbs.length]
              }">${escapeHtml(item.code)}</div>`
        }
      </div>
      <div class="segment-main">
        <div class="segment-title">
          <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
          <span class="time-window">
            累计 ${formatClock(row.start)} – ${formatClock(row.end)}
          </span>
        </div>
        <div class="tag-row">
          <span class="tag ${tagClass}">${escapeHtml(item.shift)}</span>
          <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
        </div>
        <div class="register-row">
          <label class="field">
            片边码
            <input
              type="text"
              value="${escapeHtml(item.edgeCode || "")}"
              placeholder="登记片边码"
              data-field="edgeCode"
              data-id="${item.id}"
            />
          </label>
          <label class="field field-narrow">
            时长(秒)
            <input
              type="number"
              step="0.1"
              min="0.1"
              value="${item.duration === "" ? "" : escapeHtml(item.duration)}"
              data-field="duration"
              data-id="${item.id}"
            />
          </label>
          <label class="field field-narrow">
            声轨偏移(秒)
            <input
              type="number"
              step="0.1"
              value="${escapeHtml(item.soundOffset || 0)}"
              data-field="soundOffset"
              data-id="${item.id}"
            />
          </label>
        </div>
        <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
        ${syncPanel}
      </div>
      <div class="segment-actions">
        <button type="button" title="上移" data-move-up="${item.id}">↑</button>
        <button type="button" title="下移" data-move-down="${item.id}">↓</button>
        <button type="button" title="删除" data-delete="${item.id}">×</button>
      </div>
    </article>
  `;
}

function renderWarnings() {
  const state = getState();
  const warnings = state.segments.filter((item) => item.damage !== "完好" || item.shift !== "正常");
  els.warningList.innerHTML =
    warnings
      .map((item) => {
        const index = state.segments.findIndex((segment) => segment.id === item.id) + 1;
        const reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""]
          .filter(Boolean)
          .join(" · ");
        return `
          <div class="warning-item">
            <strong>${index}. ${escapeHtml(item.code)}</strong>
            <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
}

function renderAll() {
  const state = getState();
  els.reelTitle.value = state.reelTitle;
  renderStats();
  renderList();
  renderWarnings();
}

function afterMutation() {
  renderAll();
  showRetiredToast(SyncStore.popLastRetired());
}

/* ---------- 时间与文本 ---------- */

function formatClock(seconds) {
  const value = Number(seconds) || 0;
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  }
  return `${m}:${ss}`;
}

function formatSigned(value) {
  const n = Number(value) || 0;
  return n > 0 ? `+${n}` : `${n}`;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ---------- 操作 ---------- */

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function addSegment(event) {
  event.preventDefault();
  const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
  SyncStore.addSegment({
    id: SyncStore.uid(),
    code: els.codeInput.value.trim(),
    duration: els.durationInput.value === "" ? "" : Number(els.durationInput.value),
    edgeCode: els.edgeCodeInput.value.trim(),
    soundOffset: els.soundOffsetInput.value === "" ? 0 : Number(els.soundOffsetInput.value),
    shift: els.shiftInput.value,
    damage: els.damageInput.value,
    note: els.noteInput.value.trim(),
    thumb
  });
  els.segmentForm.reset();
  els.durationInput.value = 12;
  els.soundOffsetInput.value = 0;
  afterMutation();
}

function moveSegment(id, direction) {
  const state = getState();
  const index = state.segments.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.segments.length) return;
  SyncStore.reorderSegment(id, target);
  afterMutation();
}

function exportList() {
  const state = getState();
  const timelineRows = SyncRules.timeline(state.segments);
  const total = timelineRows.reduce((sum, row) => sum + row.duration, 0);
  const lines = [
    `胶片卷：${state.reelTitle || "未命名胶片卷"}`,
    `总时长：${formatClock(total)}`,
    "",
    ...state.segments.map((item, index) => {
      const row = timelineRows[index];
      const status = item.confirmed ? "已确认同步" : "未确认";
      return `${index + 1}. ${item.code}｜${formatClock(row.start)}–${formatClock(
        row.end
      )}｜时长${row.duration}s｜片边码:${item.edgeCode || "未填"}｜声轨偏移:${formatSigned(
        item.soundOffset || 0
      )}s｜${item.shift}｜${item.damage}｜${status}｜${item.note || "无备注"}`;
    })
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.reelTitle || "film-reel"}-checklist.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------- 失效提示与历史 ---------- */

let toastTimer = null;
function showRetiredToast(retired) {
  if (!retired || retired.length === 0) return;
  const reasons = Array.from(new Set(retired.map((entry) => entry.reason))).join("、");
  const names = retired.slice(0, 3).map((entry) => entry.code).join("、");
  const extra = retired.length > 3 ? ` 等 ${retired.length} 段` : "";
  els.toast.textContent = `${reasons}，已使 ${names}${extra} 的同步确认失效，旧确认已存入同步历史。`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function renderHistoryEntry(entry) {
  const c = entry.confirmed;
  return `
    <div class="history-item">
      <div class="history-head">
        <strong>${escapeHtml(entry.code || "（已删除片段）")}</strong>
        ${entry.edgeCode ? `<span class="edge-code">片边码 ${escapeHtml(entry.edgeCode)}</span>` : ""}
        <span class="history-reason">${escapeHtml(entry.reason)}</span>
      </div>
      <div class="history-meta">
        <span>确认时第 ${c.index + 1} 段</span>
        <span>累计 ${formatClock(c.start)} – ${formatClock(c.end)}</span>
        <span>时长 ${c.duration}s</span>
        <span>声轨偏移 ${formatSigned(c.soundOffset)}s</span>
      </div>
      <div class="history-time">
        确认于 ${formatDateTime(entry.confirmedAt)} · 失效于 ${formatDateTime(entry.retiredAt)}
      </div>
    </div>
  `;
}

function openHistory(filterId) {
  historyFilterId = filterId || null;
  const state = getState();
  const entries = historyFilterId ? SyncStore.historyFor(historyFilterId) : SyncStore.allHistory();
  const scopeName = historyFilterId
    ? (state.segments.find((segment) => segment.id === historyFilterId) || {}).code || "该片段"
    : "全部片段";
  els.historyScope.innerHTML = `
    <span>当前查看：<strong>${escapeHtml(scopeName)}</strong>（${entries.length} 条旧确认）</span>
    ${historyFilterId ? `<button type="button" class="link-btn" id="showAllHistory">查看全部历史</button>` : ""}
  `;
  els.historyList.innerHTML =
    entries.map(renderHistoryEntry).join("") ||
    `<p class="empty">还没有失效的旧确认。确认后若顺序、时长或偏移变化，旧确认会保留在这里。</p>`;
  els.historyModal.hidden = false;
}

function closeHistory() {
  els.historyModal.hidden = true;
  historyFilterId = null;
}

/* ---------- 事件绑定 ---------- */

els.reelTitle.addEventListener("input", () => {
  SyncStore.setReelTitle(els.reelTitle.value);
});
els.colorFilter.addEventListener("change", renderList);
els.searchInput.addEventListener("input", renderList);
els.segmentForm.addEventListener("submit", addSegment);
els.exportBtn.addEventListener("click", exportList);
els.historyBtn.addEventListener("click", () => openHistory(null));
els.historyCloseBtn.addEventListener("click", closeHistory);
els.historyModal.addEventListener("click", (event) => {
  if (event.target === els.historyModal) closeHistory();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.historyModal.hidden) closeHistory();
});

els.segmentList.addEventListener("click", (event) => {
  const up = event.target.closest("[data-move-up]");
  const down = event.target.closest("[data-move-down]");
  const remove = event.target.closest("[data-delete]");
  const confirmBtn = event.target.closest("[data-confirm]");
  const history = event.target.closest("[data-history]");
  if (up) moveSegment(up.dataset.moveUp, -1);
  if (down) moveSegment(down.dataset.moveDown, 1);
  if (remove) {
    SyncStore.removeSegment(remove.dataset.delete);
    afterMutation();
  }
  if (confirmBtn) {
    SyncStore.confirmSegment(confirmBtn.dataset.confirm);
    afterMutation();
  }
  if (history) openHistory(history.dataset.history);
});

els.historyScope.addEventListener("click", (event) => {
  if (event.target.closest("#showAllHistory")) openHistory(null);
});

/* 行内登记：改完离开输入框即保存，并按规则级联失效。 */
els.segmentList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-field]");
  if (!input) return;
  const { id, field } = input.dataset;
  const segment = SyncStore.findSegment(id);
  if (!segment) return;
  let value = input.value;
  if (field === "duration" || field === "soundOffset") {
    value = value === "" ? "" : Number(value);
  }
  if (field === "edgeCode") value = value.trim();
  SyncStore.updateSegment(id, { [field]: value });
  afterMutation();
});

/* 拖拽：只有拖动手柄可发起，排序同样经过 store 的失效规则。 */
els.segmentList.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".drag-handle");
  const card = event.target.closest("[data-id]");
  if (!handle || !card) {
    event.preventDefault();
    return;
  }
  draggedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
});

els.segmentList.addEventListener("dragend", () => {
  document.querySelectorAll(".segment-card.dragging").forEach((card) => card.classList.remove("dragging"));
  draggedId = null;
});

els.segmentList.addEventListener("dragover", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card || !draggedId || card.dataset.id === draggedId) return;
  event.preventDefault();
  const state = getState();
  const fromIndex = state.segments.findIndex((item) => item.id === draggedId);
  const toIndex = state.segments.findIndex((item) => item.id === card.dataset.id);
  if (fromIndex < 0 || toIndex < 0) return;
  SyncStore.reorderSegment(draggedId, toIndex);
  afterMutation();
});

renderAll();
