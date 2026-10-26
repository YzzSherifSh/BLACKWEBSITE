// bug-client.js — PARADOX Bug WhatsApp Client
// Depends on global: SECRET_TOKEN (dari index.html)

(function () {
    "use strict";

    // =============================================
    // STATE
    // =============================================
    let sendersCache = [];
    let pendingBugTarget = null;
    let pendingBugType = null;
    let currentPairMode = "qr"; // "qr" atau "code"
    let qrExpireTimer = null;
    let qrActive = false;
    let bugHistory = []; // daftar target yang pernah kena bug
    let senderHistory = []; // history sender { phone, method, status, time }

    // =============================================
    // UTILS
    // =============================================
    function log() {
        try { console.log.apply(console, ["[BUG]"].concat([].slice.call(arguments))); } catch (e) {}
    }

    // === TOAST ===
    let toastTimeout = null;
    function showToast(msg, duration) {
        duration = duration || 3000;
        const t = document.getElementById("toast");
        if (!t) { log("toast element missing:", msg); return; }
        document.getElementById("toastText").innerText = msg;
        t.classList.add("show");
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(hideToast, duration);
    }

    function hideToast() {
        const t = document.getElementById("toast");
        if (!t) return;
        t.classList.remove("show");
        clearTimeout(toastTimeout);
    }

    document.addEventListener("click", function (e) {
        if (!e.target.closest("#toast")
            && !e.target.closest(".btn-primary")
            && !e.target.closest(".sender-btn-select")
            && !e.target.closest(".modal-box button")
            && !e.target.closest(".pair-mode-btn")) {
            hideToast();
        }
    }, true);

    // === DEVICE INFO ===
    let deviceInfo;
    try {
        deviceInfo = {
            model: (function () {
                try {
                    const ua = navigator.userAgent;
                    const m = ua.match(/Android[^;]*;\s*(?:[a-z]{2}-[A-Z]{2};\s*)?([^;]+?)(?:\s+Build\/[^;)]+)?[;)]/i);
                    return m ? m[1].trim() : "Unknown";
                } catch (e) { return "Unknown"; }
            })(),
            deviceId: (function () {
                try {
                    let id = localStorage.getItem("device_id");
                    if (!id) {
                        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
                            id = crypto.randomUUID();
                        } else {
                            id = "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
                        }
                        localStorage.setItem("device_id", id);
                    }
                    return id;
                } catch (e) { return "Unknown"; }
            })()
        };
    } catch (e) {
        deviceInfo = { model: "Unknown", deviceId: "Unknown" };
    }

    // === BUG HISTORY PERSISTENCE ===
    function loadBugHistory() {
        try {
            const raw = localStorage.getItem("paradox_bug_history");
            if (raw) bugHistory = JSON.parse(raw) || [];
        } catch (e) { bugHistory = []; }
    }
    function saveBugHistory() {
        try {
            localStorage.setItem("paradox_bug_history", JSON.stringify(bugHistory.slice(-50)));
        } catch (e) {}
    }
    function isTargetBugged(phone) {
        const normalized = String(phone || "").replace(/\D/g, "");
        return bugHistory.some(h => h.phone === normalized && h.status === "active");
    }
    function addBugHistory(phone, type) {
        const normalized = String(phone || "").replace(/\D/g, "");
        if (!normalized) return;
        const existing = bugHistory.find(h => h.phone === normalized);
        if (existing) {
            existing.status = "active";
            existing.type = type;
            existing.time = Date.now();
        } else {
            bugHistory.push({ phone: normalized, type: type, status: "active", time: Date.now() });
        }
        saveBugHistory();
    }
    function removeBugHistory(phone) {
        const normalized = String(phone || "").replace(/\D/g, "");
        const idx = bugHistory.findIndex(h => h.phone === normalized);
        if (idx !== -1) {
            bugHistory.splice(idx, 1);
            saveBugHistory();
        }
    }

    // === SENDER HISTORY PERSISTENCE ===
    function loadSenderHistory() {
        try {
            const raw = localStorage.getItem("paradox_sender_history");
            if (raw) senderHistory = JSON.parse(raw) || [];
        } catch (e) { senderHistory = []; }
    }
    function saveSenderHistory() {
        try {
            localStorage.setItem("paradox_sender_history", JSON.stringify(senderHistory.slice(-30)));
        } catch (e) {}
    }
    function addSenderHistory(phone, method, status) {
        senderHistory.push({
            phone: String(phone || "").replace(/\D/g, ""),
            method: method,
            status: status,
            time: Date.now()
        });
        saveSenderHistory();
        renderSenderHistory();
    }
    function updateSenderHistory(phone, status) {
        const normalized = String(phone || "").replace(/\D/g, "");
        // update entry terakhir dengan nomor ini
        for (let i = senderHistory.length - 1; i >= 0; i--) {
            if (senderHistory[i].phone === normalized) {
                senderHistory[i].status = status;
                senderHistory[i].time = Date.now();
                break;
            }
        }
        saveSenderHistory();
        renderSenderHistory();
    }

    async function bugApiFetch(payload) {
        const BUG_API = "/api/bug";
        const body = Object.assign({}, payload, {
            pairMode: currentPairMode, 
            device: {
                model: deviceInfo.model,
                deviceId: deviceInfo.deviceId
            }
        });
        
        return await fetch(BUG_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Paradox-Token": typeof SECRET_TOKEN !== "undefined" ? SECRET_TOKEN : ""
            },
            body: JSON.stringify(body)
        });
    }

    // =============================================
    // SENDER LIST
    // =============================================
    async function loadSenders() {
        try {
            const res = await bugApiFetch({ action: "get_senders" });
            const data = await res.json();
            sendersCache = data.senders || [];
            renderSenderList(data.isOwner);
        } catch (e) {
            console.error(e);
            showToast("Gagal memuat sender");
        }
    }

    function renderSenderList(isOwner) {
        const list = document.getElementById("senderList");
        if (!list) return;
        list.innerHTML = "";

        const title = document.createElement("h3");
        title.innerText = isOwner ? "Monitor Sender (Owner View)" : "Monitor Sender";
        list.appendChild(title);

        if (sendersCache.length === 0) {
            const empty = document.createElement("p");
            empty.style.cssText = "color:#888;text-align:center;padding:20px;background:#151515;border-radius:10px;border:1px dashed #333;font-size:13px;";
            empty.innerText = "Belum ada sender. Tambahkan sender terlebih dahulu.";
            list.appendChild(empty);
        } else {
            sendersCache.forEach(function (s) {
                const item = document.createElement("div");
                item.className = "sender-item";
                const statusOn = s.status === "Terhubung";
                item.innerHTML = ''
                    + '<div class="info">'
                    + '  <div class="phone">'
                    + '    ' + s.phone
                    + '    ' + (s.owner ? '<span class="badge-owner">OWNER</span>' : '')
                    + '  </div>'
                    + '  <div class="meta">'
                    + '    <span><span class="status-dot ' + (statusOn ? 'on' : 'off') + '"></span>' + (s.status || 'Unknown') + '</span>'
                    + '    <span>WhatsApp: ' + (s.whatsappType || 'Biasa') + '</span>'
                    + '    <span>Total Bug: ' + (s.totalBug || 0) + '</span>'
                    + '    ' + (s.model ? '<span>' + s.model + '</span>' : '')
                    + '  </div>'
                    + '</div>'
                    + '<div class="actions">'
                    + '  <button onclick="deleteSender(\'' + s.id + '\')">Hapus</button>'
                    + '</div>';
                list.appendChild(item);
            });
        }
    }

    // =============================================
    // SENDER HISTORY (Nomor | QR/Code | Status)
    // =============================================
    function renderSenderHistory() {
        const wrap = document.getElementById("senderHistoryList");
        if (!wrap) return;
        wrap.innerHTML = "";

        const title = document.createElement("h3");
        title.innerText = "History Sender";
        wrap.appendChild(title);

        if (senderHistory.length === 0) {
            const empty = document.createElement("p");
            empty.style.cssText = "color:#888;text-align:center;padding:16px;background:#151515;border-radius:10px;border:1px dashed #333;font-size:12px;";
            empty.innerText = "Belum ada history.";
            wrap.appendChild(empty);
            return;
        }

        // header
        const header = document.createElement("div");
        header.className = "sender-item history-row header";
        header.style.background = "#0f0f0f";
        header.style.fontSize = "11px";
        header.style.letterSpacing = "0.5px";
        header.style.textTransform = "uppercase";
        header.innerHTML = ''
            + '<div style="flex:1.2;">Nomor</div>'
            + '<div style="flex:1;text-align:center;">QR/Code</div>'
            + '<div style="flex:1;text-align:right;">Status</div>';
        wrap.appendChild(header);

        senderHistory.slice().reverse().forEach(function (h) {
            const row = document.createElement("div");
            row.className = "sender-item";
            row.style.fontSize = "12px";
            const statusColor = h.status === "Berhasil" ? "#00ff88"
                              : h.status === "Expired" ? "#ff5555"
                              : h.status === "Menunggu" ? "#ffaa00"
                              : "#888";
            row.innerHTML = ''
                + '<div style="flex:1.2;text-align:left;">' + h.phone + '</div>'
                + '<div style="flex:1;text-align:center;color:#ff5555;font-weight:700;">' + h.method + '</div>'
                + '<div style="flex:1;text-align:right;color:' + statusColor + ';font-weight:600;">' + h.status + '</div>';
            wrap.appendChild(row);
        });
    }

    function setPairMode(mode) {
        currentPairMode = mode;
        const btnQR = document.getElementById("pairModeQR");
        const btnCode = document.getElementById("pairModeCode");
        const qrWrap = document.getElementById("qrWrap");
        const codeWrap = document.getElementById("codeWrap");
        const pairCode = document.getElementById("pairCode");

        if (btnQR) btnQR.classList.toggle("active", mode === "qr");
        if (btnCode) btnCode.classList.toggle("active", mode === "code");

        // Sembunyiin dua-duanya pas ganti mode biar gak ketuker
        if (qrWrap) qrWrap.style.display = "none";
        if (codeWrap) codeWrap.style.display = "none";
        
        // Bersihin kode lama kalau ada
        if (pairCode) pairCode.innerText = "-";
    }

    function resetPairUI() {
        const qrWrap = document.getElementById("qrWrap");
        const codeWrap = document.getElementById("codeWrap");
        const btn = document.getElementById("btnCreateQR");
        if (qrWrap) qrWrap.style.display = "none";
        if (codeWrap) codeWrap.style.display = "none";
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg class="icon" style="width:16px;height:16px;"><use href="#i-refresh"/></svg> Create';
        }
        qrActive = false;
        if (qrExpireTimer) {
            clearTimeout(qrExpireTimer);
            qrExpireTimer = null;
        }
    }

    async function createSenderPairing() {
        const phone = (document.getElementById("senderPhone") || {}).value || "";
        const phoneClean = phone.trim();
        if (!phoneClean) return showToast("Masukkan nomor terlebih dahulu");

        const btn = document.getElementById("btnCreateQR");
        btn.disabled = true;
        btn.innerHTML = '<svg class="icon spin" style="width:16px;height:16px;"><use href="#i-refresh"/></svg> Memproses...';

        try {
            const res = await bugApiFetch({
                action: "add_sender",
                phone: phoneClean,
                pairMode: currentPairMode
            });
            const data = await res.json();

            if (!data.success) {
                showToast("Gagal: " + (data.error || "Unknown error"));
                btn.disabled = false;
                btn.innerHTML = '<svg class="icon" style="width:16px;height:16px;"><use href="#i-refresh"/></svg> Create';
                return;
            }

            addSenderHistory(phoneClean, currentPairMode === "qr" ? "QR" : "Code", "Menunggu");

            // LANGSUNG TAMPILIN (Gak pake polling lagi)
            if (data.qr && currentPairMode === "qr") {
                const qrWrap = document.getElementById("qrWrap");
                const qrImg = document.getElementById("qrImage");
                if (qrWrap && qrImg) {
                    qrImg.src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(data.qr);
                    qrWrap.style.display = "block";
                }
            }
            if (data.code && currentPairMode === "code") {
                const codeWrap = document.getElementById("codeWrap");
                const pairCode = document.getElementById("pairCode");
                if (codeWrap && pairCode) {
                    pairCode.innerText = data.code.match(/.{1,4}/g)?.join("-") || data.code;
                    codeWrap.style.display = "block";
                }
            }

            btn.disabled = false;
            btn.innerHTML = '<svg class="icon" style="width:16px;height:16px;"><use href="#i-refresh"/></svg> Create';

            // Pantau terus apakah udah konek (tiap 3 detik)
            let pollCount = 0;
            const poll = setInterval(async () => {
                pollCount++;
                await loadSenders();
                const found = sendersCache.find(s => s.phone === phoneClean.replace(/\D/g, ""));
                
                if (found) {
                    clearInterval(poll);
                    resetPairUI();
                    document.getElementById("senderPhone").value = "";
                    updateSenderHistory(phoneClean, "Berhasil");
                    showToast("Sender berhasil terhubung!");
                }
                
                if (pollCount > 60) clearInterval(poll); // 3 menit
            }, 3000);

        } catch (e) {
            console.error(e);
            showToast("Error koneksi ke server");
            btn.disabled = false;
            btn.innerHTML = '<svg class="icon" style="width:16px;height:16px;"><use href="#i-refresh"/></svg> Create';
        }
    }

    async function deleteSender(id) {
        if (!confirm("Yakin ingin menghapus sender ini?")) return;
        try {
            const res = await bugApiFetch({ action: "delete_sender", senderId: id });
            const data = await res.json();
            if (data.success) {
                showToast("Sender dihapus");
                loadSenders();
            } else {
                showToast("Gagal: " + data.error);
            }
        } catch (e) {
            showToast("Error koneksi");
        }
    }

    // =============================================
    // SENDER SELECT MODAL
    // =============================================
    function openSenderSelectModal() {
        const wrap = document.getElementById("senderSelectList");
        wrap.innerHTML = "";

        sendersCache.forEach(function (s) {
            const btn = document.createElement("button");
            btn.className = "sender-btn-select";
            btn.innerHTML = ''
                + '<div class="phone-wrap">'
                + '  <div class="phone-line">' + s.phone + (s.owner ? ' <span class="badge-owner">OWNER</span>' : '') + '</div>'
                + '  <div class="phone-model">' + (s.model || 'Unknown') + ' · ' + s.status + '</div>'
                + '</div>'
                + '<span class="badge">' + (s.totalBug || 0) + 'x</span>';
            btn.onclick = function () {
                closeSenderSelectModal();
                executeBug(s.id);
            };
            wrap.appendChild(btn);
        });

        document.getElementById("senderSelectModal").classList.remove("hidden");
    }

    function closeSenderSelectModal() {
        document.getElementById("senderSelectModal").classList.add("hidden");
    }

    // =============================================
    // MONITOR LOG
    // =============================================
    function addMonitorEntry(monitorId, emptyId, text, isError) {
        const monitor = document.getElementById(monitorId);
        const empty = document.getElementById(emptyId);
        if (!monitor) return;
        if (empty) empty.style.display = "none";

        const time = new Date().toLocaleTimeString("id-ID");
        const item = document.createElement("div");
        item.className = "sender-item";
        item.style.borderColor = isError ? "#ff3333" : "#00ff88";
        item.innerHTML = ''
            + '<div class="info">'
            + '  <div class="phone" style="font-size:13px;">' + text + '</div>'
            + '  <div class="meta"><span>' + time + '</span></div>'
            + '</div>';
        monitor.insertBefore(item, monitor.children[1] || null);
    }

    // =============================================
    // BUG TRIGGERS
    // =============================================
    function startDelayBug() {
        const target = (document.getElementById("delayTarget") || {}).value || "";
        if (!target.trim()) return showToast("Masukkan nomor target");
        pendingBugTarget = target.trim();
        pendingBugType = "delay";

        if (sendersCache.length === 0) {
            showToast("Kamu Belum Menambahkan Sender Silahkan Hubungkan Sender Terlebih Dahulu");
            return;
        }
        if (sendersCache.length === 1) {
            executeBug(sendersCache[0].id);
            return;
        }
        openSenderSelectModal();
    }

    function startClearBug() {
        const target = (document.getElementById("clearTarget") || {}).value || "";
        if (!target.trim()) return showToast("Masukkan nomor target");
        pendingBugTarget = target.trim();
        pendingBugType = "clear";

        // validasi: target harus ada di daftar bug
        if (!isTargetBugged(pendingBugTarget)) {
            showToast("Nomor " + pendingBugTarget + " tidak terkena bug");
            pendingBugTarget = null;
            pendingBugType = null;
            return;
        }

        if (sendersCache.length === 0) {
            showToast("Kamu Belum Menambahkan Sender Silahkan Hubungkan Sender Terlebih Dahulu");
            return;
        }
        if (sendersCache.length === 1) {
            executeBug(sendersCache[0].id);
            return;
        }
        openSenderSelectModal();
    }

    async function executeBug(senderId) {
        const sender = sendersCache.find(function (s) { return s.id === senderId; });
        const typeLabel = pendingBugType === "delay" ? "Delay" : "Clear";
        const monitorId = pendingBugType === "delay" ? "delayMonitor" : "clearMonitor";
        const emptyId = pendingBugType === "delay" ? "delayMonitorEmpty" : "clearMonitorEmpty";
        const target = pendingBugTarget;

        addMonitorEntry(monitorId, emptyId,
            "Mengirim " + typeLabel + " → " + target + " (sender: " + (sender ? sender.phone : senderId) + ")");

        try {
            const res = await bugApiFetch({
                action: "send_bug",
                senderId: senderId,
                phone: target,
                type: pendingBugType
            });
            const data = await res.json();
            if (data.success) {
                if (pendingBugType === "delay") {
                    addBugHistory(target, "delay");
                } else {
                    removeBugHistory(target);
                }
                addMonitorEntry(monitorId, emptyId,
                    typeLabel + " terkirim → " + target + " (sender: " + (sender ? sender.phone : senderId) + ")");
                showToast(typeLabel + " terkirim ke " + target);
                if (pendingBugType === "delay") (document.getElementById("delayTarget") || {}).value = "";
                if (pendingBugType === "clear") (document.getElementById("clearTarget") || {}).value = "";
                loadSenders();
            } else {
                addMonitorEntry(monitorId, emptyId,
                    "Gagal " + typeLabel + " → " + target + ": " + (data.error || "Unknown"), true);
                showToast("Gagal: " + (data.error || "Unknown"));
            }
        } catch (e) {
            addMonitorEntry(monitorId, emptyId, "Error koneksi: " + e.message, true);
            showToast("Error koneksi");
        } finally {
            pendingBugTarget = null;
            pendingBugType = null;
        }
    }

    // =============================================
    // INIT
    // =============================================
    function init() {
        loadBugHistory();
        loadSenderHistory();
        renderSenderHistory();
        log("bug-client loaded, device:", deviceInfo);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // =============================================
    // EXPOSE
    // =============================================
    window.showToast = showToast;
    window.hideToast = hideToast;
    window.loadSenders = loadSenders;
    window.createSenderPairing = createSenderPairing;
    window.deleteSender = deleteSender;
    window.openSenderSelectModal = openSenderSelectModal;
    window.closeSenderSelectModal = closeSenderSelectModal;
    window.startDelayBug = startDelayBug;
    window.startClearBug = startClearBug;
    window.executeBug = executeBug;
    window.setPairMode = setPairMode;
    window.renderSenderHistory = renderSenderHistory;
})();