/* SafeSignal demo client. All sample alerts and locations are explicitly simulated. */
(function () {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const isReadOnly = document.body.dataset.readOnly === "true";
  const isAdmin = !isReadOnly && document.body.dataset.userRole === "admin";
  const state = { overview: null, alerts: [], reports: [], resources: [], volunteers: [], guides: {}, mapPoints: [], floodZones: [], floodSimulation: null, activeGuide: "Floods", charts: {}, map: null, previewMap: null, baseLayer: null, previewBaseLayer: null, baseStyle: "satellite", markerLayers: {}, mapReady: false };
  const layerTypes = ["Flood reports", "Cyclone information", "Fire reports", "Landslide reports", "Earthquake information", "Relief camps", "Hospitals", "Community reports", "Road closure reports"];
  const layerIcons = ["fa-water", "fa-wind", "fa-fire", "fa-mountain-sun", "fa-house-crack", "fa-tent", "fa-house-medical", "fa-bullhorn", "fa-road"];
  const guideIcons = { Floods: "fa-water", Cyclones: "fa-wind", Earthquakes: "fa-house-crack", Fires: "fa-fire", Landslides: "fa-mountain-sun", Heatwaves: "fa-temperature-high" };
  const severityRank = { CRITICAL: 4, WARNING: 3, WATCH: 2, INFORMATION: 1 };
  const categories = ["Food", "Water", "Medical", "Shelter", "Clothing", "Supplies", "Shelter capacity", "Other"];
  let chartsReady = false;
  let lastGeocodeRequest = 0;

  async function api(url, options = {}) {
    const csrfToken = $('meta[name="csrf-token"]')?.content;
    const config = { ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}), ...(options.headers || {}) } };
    const response = await fetch(url, config);
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : {};
    if (response.status === 401) window.location.assign("/login");
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  function renderMapConsole(data = state.overview) {
    if (!data) return;
    $("#map-hud-alerts").textContent = data.active_incidents ?? "—";
    $("#map-hud-reports").textContent = data.reports_count ?? "—";
    $("#map-hud-zones").textContent = state.floodZones.length;
    $("#map-community-count").textContent = state.mapPoints.filter(point => point.type === "Community reports").length;
    $("#map-shortage-count").textContent = `${data.shortages || 0} low`;
    const alert = state.alerts[0];
    $("#map-alert-preview").innerHTML = alert ? `<div class="rail-alert-card"><span class="severity-pill ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}${alert.id === "sim-flood-01" ? " · SIMULATION" : ""}</span><b>${escapeHtml(alert.title)}</b><small><i class="fa-solid fa-location-dot"></i> ${escapeHtml(alert.location)}</small><p>${escapeHtml(alert.details)}</p><button class="map-rail-open" data-view="alerts">View alert center <i class="fa-solid fa-arrow-right"></i></button></div>` : `<p class="rail-muted">No sample alerts available.</p>`;
  }
  async function activateFloodSimulation() {
    const button = $("#start-flood-simulation");
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Activating…';
    try {
      await api("/api/simulation/flood", { method: "POST", body: JSON.stringify({}) });
      await Promise.all([loadOverview(), loadAlerts(), loadMapPoints()]);
      toast("Flood response exercise active. This scenario is simulated only.");
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-water"></i> Flood Simulation'; }
  }
  async function resetFloodSimulation() {
    if (!window.confirm("Reset the flood simulation? Saved reports, resources and volunteers will remain unchanged.")) return;
    const button = $("#reset-flood-simulation");
    button.disabled = true;
    try {
      const result = await api("/api/simulation/reset", { method: "POST", body: JSON.stringify({}) });
      await Promise.all([loadOverview(), loadAlerts(), loadMapPoints()]);
      toast(result.message);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function toast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.innerHTML = `<i class="fa-solid ${error ? "fa-circle-exclamation" : "fa-circle-check"}"></i><span>${escapeHtml(message)}</span>`;
    $("#toast-region").appendChild(node);
    window.setTimeout(() => node.remove(), 3700);
  }
  function localTime() {
    const now = new Date();
    $("#local-time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function setNetworkState() {
    const online = navigator.onLine;
    $("#network-label").textContent = online ? "Connected" : "Offline mode";
    $("#network-sub").textContent = online ? "Maps & API need internet" : "Cached guides & checklist";
    $("#network-indicator").classList.toggle("online", online);
  }
  function showView(name) {
    const target = $(`#view-${name}`);
    if (!target) return;
    $$(".view").forEach(view => view.classList.toggle("active", view === target));
    $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    const active = $(`.nav-link[data-view="${name}"]`);
    $("#current-crumb").textContent = active ? active.querySelector("span")?.textContent || "Overview" : "Overview";
    $("#sidebar").classList.remove("open");
    $("#mobile-scrim").classList.remove("show");
    if (name === "map") window.setTimeout(initMap, 80);
    if (name === "dashboard") window.setTimeout(initPreviewMap, 80);
    if (name === "analytics") loadAnalytics();
    if (name === "reports" || name === "admin") loadReports();
    if (name === "resources") loadResources();
    if (name === "volunteers") loadVolunteers();
    if (name === "preparedness") loadPreparedness();
    if (name === "shelters") loadShelters();
    if (name === "recovery") loadRecovery();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function reportDate(value) {
    if (!value) return "Time not recorded";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  function categoryIcon(category) {
    const key = String(category).toLowerCase();
    if (key.includes("water")) return "fa-droplet";
    if (key.includes("food")) return "fa-bowl-food";
    if (key.includes("medical")) return "fa-kit-medical";
    if (key.includes("shelter")) return "fa-tent";
    if (key.includes("cloth")) return "fa-shirt";
    return "fa-box";
  }
  function stockStatus(item) {
    if (Number(item.quantity) <= 10) return "Critical shortage";
    if (Number(item.quantity) <= 30) return "Low stock";
    return "Available";
  }
  function renderDashboard(data) {
    state.overview = data;
    state.alerts = data.alerts || [];
    $("#metric-alerts").textContent = data.active_incidents ?? "—";
    $("#metric-reports").textContent = data.reports_count ?? "—";
    $("#metric-resources").textContent = (data.resources || []).length;
    $("#metric-volunteers").textContent = data.volunteer_count ?? "—";
    $("#metric-shortage").textContent = `${data.shortages || 0} shortages flagged`;
    $("#mission-alert-count").textContent = state.alerts.length;
    $("#dashboard-alerts").innerHTML = state.alerts.slice(0, 3).map(alert => `<article class="mission-incident-row"><span class="alert-stripe ${escapeHtml(alert.severity)}"></span><div class="mission-incident-copy"><b>${escapeHtml(alert.title)}</b><small><i class="fa-solid fa-location-dot"></i> ${escapeHtml(alert.location)}</small><small><i class="fa-regular fa-clock"></i> ${escapeHtml(alert.time)} · ${escapeHtml(alert.source || "Demo feed")}</small></div><span class="severity-pill ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span></article>`).join("") || emptyMarkup("fa-circle-check", "No demo alerts", "No sample alerts are currently available.");
    const requests = data.rescue_requests || [];
    $("#rescue-count").textContent = data.rescue_request_count ?? requests.length;
    $("#rescue-request-list").innerHTML = requests.length ? requests.slice(0, 3).map(report => `<article class="rescue-request-row"><span class="rescue-request-icon"><i class="fa-solid fa-kit-medical"></i></span><span><b>${escapeHtml(report.area)}</b><small>${escapeHtml(report.severity)} · ${escapeHtml(report.status)}</small></span><i class="fa-solid fa-chevron-right"></i></article>`).join("") : `<div class="mission-empty">No open medical assistance reports.</div>`;
    const stockItems = (data.resources || []).filter(item => Number(item.quantity) <= 30);
    $("#mission-stock-total").textContent = stockItems.length;
    $("#mission-inventory-list").innerHTML = stockItems.length ? stockItems.slice(0, 4).map(item => {
      const critical = Number(item.quantity) <= 10;
      return `<div class="mission-stock-row"><span class="stock-state-dot${critical ? " critical" : ""}"></span><span class="mission-stock-copy"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.area)} · ${escapeHtml(item.category)}</small></span><span class="mission-stock-quantity${critical ? " critical-text" : ""}">${Number(item.quantity)} ${escapeHtml(item.unit)}<small>${critical ? "CRITICAL" : "LOW STOCK"}</small></span></div>`;
    }).join("") : `<div class="mission-empty">No low-stock items in local inventory.</div>`;
    $("#mission-report-total").textContent = data.reports_count ?? 0;
    $("#mission-volunteer-total").textContent = data.volunteer_count ?? 0;
    const recent = data.recent_reports || [];
    $("#dashboard-reports").innerHTML = recent.length ? recent.map(report => reportMarkup(report)).join("") : emptyMarkup("fa-inbox", "No community reports yet", "New submissions will appear here. Sample alerts are not community reports.");
    state.floodSimulation = data.flood_simulation;
    renderFloodSimulation(state.floodSimulation);
    renderMapConsole(data);
    updateDashboardChart(data.report_daily || []);
    renderAlertSummary();
  }
  function renderFloodSimulation(simulation) {
    const active = Boolean(simulation?.active);
    $("#flood-simulation-panel").hidden = !active;
    $("#start-flood-simulation").hidden = active;
    $("#reset-flood-simulation").hidden = !active;
    if (!active) return;
    $("#flood-sim-note").textContent = simulation.note;
    $("#flood-affected-areas").innerHTML = simulation.affected_areas.map(area => `<span class="affected-area-chip"><i class="fa-solid fa-location-dot"></i>${escapeHtml(area)}</span>`).join("");
    $("#flood-shortages").innerHTML = simulation.resource_shortages.length ? simulation.resource_shortages.map(item => `<div class="flood-shortage-row"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.category)} · need ${item.required} ${escapeHtml(item.unit)}</small></span><strong>${item.shortage} ${escapeHtml(item.unit)} short</strong></div>`).join("") : `<div class="simulation-clear"><i class="fa-solid fa-circle-check"></i> No simulated shortages against the current local inventory.</div>`;
    $("#flood-volunteer-tasks").innerHTML = simulation.volunteer_tasks.map(task => `<div class="flood-task-row"><span class="task-check"><i class="fa-solid fa-check"></i></span><span><b>${escapeHtml(task.title)}</b><small>${escapeHtml(task.area)} · ${escapeHtml(task.safety)}</small></span></div>`).join("");
    $("#flood-plan-en").innerHTML = simulation.action_plan.English.map(step => `<li>${escapeHtml(step)}</li>`).join("");
    $("#flood-plan-ta").innerHTML = simulation.action_plan.Tamil.map(step => `<li>${escapeHtml(step)}</li>`).join("");
  }
  function chartDefaults() {
    return { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#9cb0bc", boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { family: "DM Sans", size: 9 } } }, tooltip: { backgroundColor: "#142b3a", titleColor: "#eaf4f6", bodyColor: "#bfd0d9", borderColor: "#2b4959", borderWidth: 1 } }, scales: { x: { grid: { color: "#ffffff0b" }, ticks: { color: "#7890a0", font: { family: "DM Sans", size: 8 } }, border: { display: false } }, y: { beginAtZero: true, grid: { color: "#ffffff0b" }, ticks: { color: "#7890a0", precision: 0, font: { family: "DM Sans", size: 8 } }, border: { display: false } } } };
  }
  function makeChart(canvas, type, data, options = {}) {
    if (!window.Chart || !canvas) return null;
    const key = canvas.id;
    if (state.charts[key]) state.charts[key].destroy();
    state.charts[key] = new Chart(canvas, { type, data, options: { ...chartDefaults(), ...options } });
    return state.charts[key];
  }
  function updateDashboardChart(daily) {
    if (!window.Chart) return;
    let labels = daily.map(item => {
      const date = new Date(`${item.day}T00:00:00`);
      return Number.isNaN(date.getTime()) ? item.day : date.toLocaleDateString([], { month: "short", day: "numeric" });
    });
    $("#basemap-satellite").addEventListener("click", () => setBasemap("satellite"));
    $("#basemap-street").addEventListener("click", () => setBasemap("streets"));
    let values = daily.map(item => item.count);
    if (!labels.length) { labels = ["No submissions"]; values = [0]; }
    makeChart($("#dashboard-chart"), "line", { labels, datasets: [{ label: "Community reports", data: values, borderColor: "#4ed0cf", backgroundColor: "rgba(78,208,207,.12)", fill: true, tension: .38, pointRadius: 3, pointBackgroundColor: "#4ed0cf" }] }, { plugins: { legend: { display: false } } });
  }
  function renderAlertSummary() {
    const counts = { INFORMATION: 0, WATCH: 0, WARNING: 0, CRITICAL: 0 };
    state.alerts.forEach(alert => { counts[alert.severity] = (counts[alert.severity] || 0) + 1; });
    $("#alert-nav-count").textContent = state.alerts.length;
    $("#alert-summary").innerHTML = Object.entries(counts).map(([name, count]) => `<div class="alert-summary-card ${name}"><span>${name}</span><b>${count}</b></div>`).join("");
  }
  function renderAlerts() {
    const search = ($("#alert-search").value || "").trim().toLowerCase();
    const severity = $("#alert-severity").value;
    const sort = $("#alert-sort").value;
    let alerts = state.alerts.filter(alert => (!severity || alert.severity === severity) && `${alert.title} ${alert.type} ${alert.location} ${alert.source}`.toLowerCase().includes(search));
    if (sort === "severity") alerts.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
    if (sort === "title") alerts.sort((a, b) => a.title.localeCompare(b.title));
    $("#alert-results-count").textContent = `${alerts.length} shown`;
    $("#alert-list").innerHTML = alerts.length ? alerts.map(alert => `<article class="alert-detail-card"><span class="alert-stripe ${escapeHtml(alert.severity)}"></span><div class="alert-detail-body"><div class="alert-detail-title"><h3>${escapeHtml(alert.title)}</h3><span class="severity-pill ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span></div><p>${escapeHtml(alert.details)}</p><div class="alert-meta"><span><i class="fa-solid fa-location-dot"></i>${escapeHtml(alert.location)}</span><span><i class="fa-regular fa-clock"></i>${escapeHtml(alert.time)}</span><span><i class="fa-solid fa-circle-check"></i>${escapeHtml(alert.status)}</span><span><i class="fa-regular fa-hourglass-half"></i>Expires ${escapeHtml(alert.expires)}</span></div><div class="alert-source">SOURCE · ${escapeHtml(alert.source)} · SIMULATED</div></div></article>`).join("") : emptyMarkup("fa-tower-broadcast", "No matching alerts", "Try changing the filters or search terms.");
  }
  function emptyMarkup(icon, title, detail) {
    return `<div class="empty-state"><i class="fa-solid ${icon}"></i><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`;
  }
  async function loadAlerts() {
    try { const result = await api("/api/alerts"); state.alerts = result.alerts || []; renderAlertSummary(); renderAlerts(); renderMapConsole(); }
    catch (error) { $("#alert-list").innerHTML = emptyMarkup("fa-triangle-exclamation", "Alerts unavailable", error.message); }
  }
  function reportMarkup(report, admin = false) {
    const statusClass = String(report.status).replace(/\s/g, "-");
    const meta = `${escapeHtml(report.area)} · ${reportDate(report.created_at)}`;
    const photoPreview = report.has_photo ? `<a class="report-photo-preview" href="/api/reports/${encodeURIComponent(report.id)}/photo" target="_blank" rel="noopener noreferrer" aria-label="Open attached report photo"><img src="/api/reports/${encodeURIComponent(report.id)}/photo" alt="Photo attached to this community report" loading="lazy"><span><i class="fa-solid fa-expand"></i> View attached photo</span></a>` : "";
    if (admin) {
      return `<article class="admin-report" data-report-id="${report.id}"><div class="report-item-top"><h4>${escapeHtml(report.incident_type)} <span class="status-chip ${statusClass}">${escapeHtml(report.status)}</span></h4><small>${meta}</small></div><p>${escapeHtml(report.description)}</p><div class="admin-report-controls">${report.has_photo ? `<a class="outline-button" href="/api/reports/${report.id}/photo" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-image"></i> View photo</a>` : ""}<select class="select-control admin-status"><option ${report.status === "Submitted" ? "selected" : ""}>Submitted</option><option ${report.status === "Under Review" ? "selected" : ""}>Under Review</option><option ${report.status === "Verified" ? "selected" : ""}>Verified</option><option ${report.status === "Resolved" ? "selected" : ""}>Resolved</option><option ${report.status === "Rejected" ? "selected" : ""}>Rejected</option></select><button class="outline-button admin-save"><i class="fa-solid fa-check"></i> Update status</button></div></article>`;
    }
    return `<article class="report-item"><div class="report-item-top"><h4>${escapeHtml(report.incident_type)} <span class="status-chip ${statusClass}">${escapeHtml(report.status)}</span></h4><small>${escapeHtml(report.severity)}</small></div><p>${escapeHtml(report.description)}</p><small><i class="fa-solid fa-location-dot"></i> ${meta}</small>${photoPreview}</article>`;
  }
  async function loadReports() {
    const statusEl = $("#report-status-filter"), categoryEl = $("#report-category-filter");
    const params = new URLSearchParams();
    if ($("#view-reports").classList.contains("active")) {
      if (statusEl && statusEl.value !== "All statuses") params.set("status", statusEl.value);
      if (categoryEl && categoryEl.value !== "All categories") params.set("category", categoryEl.value);
    }
    try {
      const response = await api(`/api/reports?${params.toString()}`);
      state.reports = response.reports || [];
      if ($("#report-history")) $("#report-history").innerHTML = state.reports.length ? state.reports.map(report => reportMarkup(report)).join("") : emptyMarkup("fa-inbox", "No reports yet", "Community submissions will appear here after they are submitted.");
      if (isAdmin && $("#admin-report-list")) renderAdminReports();
      if ($("#recovery-needs-list")) renderRecoveryNeeds();
    } catch (error) {
      if ($("#report-history")) $("#report-history").innerHTML = emptyMarkup("fa-triangle-exclamation", "Unable to load reports", error.message);
      if (isAdmin && $("#admin-report-list")) $("#admin-report-list").innerHTML = emptyMarkup("fa-triangle-exclamation", "Unable to load reports", error.message);
    }
  }
  async function submitReport(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = $("#report-submit");
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';
    const formData = new FormData(form);
    try {
      const result = await api("/api/reports", { method: "POST", body: formData });
      form.reset();
      toast(result.message || "Report submitted for review.");
      await Promise.all([loadReports(), loadOverview(), loadAnalytics()]);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit report'; }
  }
  async function updateReportStatus(button) {
    const card = button.closest("[data-report-id]");
    const status = $(".admin-status", card).value;
    if (!window.confirm(`Update this report to "${status}"? This changes the local demo record only.`)) return;
    button.disabled = true;
    try {
      await api(`/api/reports/${card.dataset.reportId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast("Report workflow updated.");
      await Promise.all([loadReports(), loadOverview(), loadAnalytics()]);
      if ($("#view-recovery").classList.contains("active")) loadRecovery();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }
  function renderAdminReports() {
    const pending = state.reports.filter(report => !["Verified", "Resolved", "Rejected"].includes(report.status));
    const allCount = state.reports.length;
    const verifiedCount = state.reports.filter(report => report.status === "Verified").length;
    $("#admin-metrics").innerHTML = [
      ["Total reports", allCount], ["Awaiting review", pending.length], ["Verified", verifiedCount], ["Resolved", state.reports.filter(report => report.status === "Resolved").length],
    ].map(([label, count]) => `<div class="admin-stat"><small>${label}</small><b>${count}</b></div>`).join("");
    $("#admin-report-list").innerHTML = state.reports.length ? state.reports.map(report => reportMarkup(report, true)).join("") : emptyMarkup("fa-clipboard-check", "Nothing to review", "New community reports will appear here. Demo sample alerts are not community reports.");
  }
  function renderRecoveryNeeds() {
    const open = state.reports.filter(report => !["Resolved", "Rejected"].includes(report.status));
    $("#recovery-needs-list").innerHTML = open.length ? open.slice(0, 5).map(report => reportMarkup(report)).join("") : emptyMarkup("fa-heart", "No outstanding submissions", "Any open user submissions will appear here for review.");
  }
  function resourceMarkup(item) {
    const status = stockStatus(item);
    const statusClass = status.replace(/\s/g, "-");
    const updated = reportDate(item.updated_at);
    const actions = isAdmin ? `<div class="row-actions"><button class="row-action resource-edit" title="Edit resource" aria-label="Edit ${escapeHtml(item.name)}"><i class="fa-solid fa-pen"></i></button><button class="row-action danger resource-delete" title="Delete resource" aria-label="Delete ${escapeHtml(item.name)}"><i class="fa-solid fa-trash"></i></button></div>` : `<span class="viewer-label">View only</span>`;
    return `<tr data-resource-id="${item.id}"><td><div class="resource-name"><span class="resource-icon"><i class="fa-solid ${categoryIcon(item.category)}"></i></span><b>${escapeHtml(item.name)}</b></div></td><td>${escapeHtml(item.category)}</td><td><b>${Number(item.quantity).toLocaleString()}</b> ${escapeHtml(item.unit)}</td><td>${escapeHtml(item.area)}</td><td><span class="supply-pill ${statusClass}">${status}</span></td><td>${escapeHtml(updated)}</td><td>${actions}</td></tr>`;
  }
  async function loadResources(search = "") {
    try {
      const response = await api(`/api/resources?q=${encodeURIComponent(search)}`);
      state.resources = response.resources || [];
      const filtered = state.resources.filter(item => {
        const status = $("#resource-status-filter")?.value;
        return !status || stockStatus(item) === status;
      });
      $("#resource-table").innerHTML = filtered.length ? filtered.map(resourceMarkup).join("") : `<tr><td colspan="7">${emptyMarkup("fa-box-open", "No matching resources", "Try another search or add an inventory item.")}</td></tr>`;
      $("#resource-count").textContent = `${filtered.length} items`;
      renderResourceSummary(state.resources);
    } catch (error) {
      $("#resource-table").innerHTML = `<tr><td colspan="7">${emptyMarkup("fa-triangle-exclamation", "Inventory unavailable", error.message)}</td></tr>`;
      toast(error.message, true);
    }
  }
  function renderResourceSummary(items) {
    const counts = { total: items.length, available: 0, low: 0, critical: 0 };
    items.forEach(item => {
      const status = stockStatus(item);
      if (status === "Available") counts.available++;
      else if (status === "Low stock") counts.low++;
      else counts.critical++;
    });
    $("#resource-summary").innerHTML = [
      ["Tracked items", counts.total, ""], ["Available", counts.available, ""], ["Low stock", counts.low, "low"], ["Critical shortage", counts.critical, "critical"],
    ].map(([name, count, cls]) => `<div class="resource-stat ${cls}"><small>${name}</small><b>${count}</b></div>`).join("");
  }
  function openResourceModal(item = null) {
    const form = $("#resource-form");
    form.reset();
    form.elements.id.value = item?.id || "";
    $("#modal-title").textContent = item ? "Update resource" : "Add resource";
    if (item) ["name", "category", "quantity", "unit", "area"].forEach(key => { form.elements[key].value = item[key]; });
    $("#modal-backdrop").hidden = false;
    form.elements.name.focus();
  }
  async function saveResource(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    const id = data.id;
    delete data.id;
    data.quantity = Number(data.quantity);
    try {
      await api(id ? `/api/resources/${id}` : "/api/resources", { method: id ? "PATCH" : "POST", body: JSON.stringify(data) });
      $("#modal-backdrop").hidden = true;
      toast(id ? "Resource updated." : "Resource added.");
      await Promise.all([loadResources($("#resource-search").value), loadOverview()]);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }
  async function deleteResource(button) {
    const row = button.closest("[data-resource-id]");
    const item = state.resources.find(resource => resource.id === Number(row.dataset.resourceId));
    if (!window.confirm(`Delete "${item?.name || "this resource"}" from the demo inventory?`)) return;
    try {
      await api(`/api/resources/${row.dataset.resourceId}`, { method: "DELETE" });
      toast("Resource removed.");
      await Promise.all([loadResources($("#resource-search").value), loadOverview(), loadAnalytics()]);
    } catch (error) { toast(error.message, true); }
  }
  async function loadVolunteers(search = "") {
    try {
      const response = await api("/api/volunteers");
      state.volunteers = response.volunteers || [];
      const list = state.volunteers.filter(person => `${person.name} ${person.skills} ${person.area} ${person.activity}`.toLowerCase().includes(search.toLowerCase()));
      const available = state.volunteers.filter(person => person.availability === "Available").length;
      const assigned = state.volunteers.filter(person => person.status === "Assigned").length;
      $("#volunteer-summary").innerHTML = [["Registered", state.volunteers.length, "fa-people-group", "cyan"], ["Available", available, "fa-circle-check", "mint"], ["Assigned to safe tasks", assigned, "fa-list-check", "violet"]].map(([label, count, icon, color]) => `<article class="metric-card"><div class="metric-top"><span class="metric-icon ${color}"><i class="fa-solid ${icon}"></i></span><span class="metric-caption">LOCAL DIRECTORY</span></div><div class="metric-value">${count}</div><div class="metric-label">${label}</div></article>`).join("");
      const activities = ["Not assigned", "Information desk support", "Relief kit packing", "Neighbour check-in calls", "Translation support", "Data entry"];
      $("#volunteer-grid").innerHTML = list.length ? list.map(person => `<article class="volunteer-card" data-volunteer-id="${person.id}"><div class="volunteer-card-head"><span class="volunteer-avatar">${escapeHtml(person.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase())}</span><span><b>${escapeHtml(person.name)}</b><small>${escapeHtml(person.area)}</small></span><span class="status-chip ${escapeHtml(person.status)}">${escapeHtml(person.status)}</span></div><p class="volunteer-skills">${escapeHtml(person.skills)}</p><div class="volunteer-card-foot"><span>Availability: <b class="availability ${escapeHtml(person.availability)}">${escapeHtml(person.availability)}</b></span><span>${escapeHtml(person.activity)}</span></div>${isAdmin ? `<div class="volunteer-coordination"><select class="select-control volunteer-activity" aria-label="Safe volunteer activity">${activities.map(activity => `<option ${person.activity === activity ? "selected" : ""}>${escapeHtml(activity)}</option>`).join("")}</select><select class="select-control volunteer-status" aria-label="Volunteer assignment status"><option ${person.status === "Available" ? "selected" : ""}>Available</option><option ${person.status === "Assigned" ? "selected" : ""}>Assigned</option><option ${person.status === "Unavailable" ? "selected" : ""}>Unavailable</option></select><button class="outline-button volunteer-save"><i class="fa-solid fa-check"></i> Update</button></div>` : ""}</article>`).join("") : emptyMarkup("fa-people-group", "No matching volunteers", "Try another search term or register a volunteer.");
    } catch (error) { $("#volunteer-grid").innerHTML = emptyMarkup("fa-triangle-exclamation", "Directory unavailable", error.message); }
  }
  async function saveVolunteer(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api("/api/volunteers", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      $("#volunteer-modal-backdrop").hidden = true;
      toast("Volunteer added to the local demo directory.");
      await Promise.all([loadVolunteers($("#volunteer-search").value), loadOverview()]);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }
  async function updateVolunteer(button) {
    const card = button.closest("[data-volunteer-id]");
    const status = $(".volunteer-status", card).value;
    const activity = $(".volunteer-activity", card).value;
    if (status === "Assigned" && activity === "Not assigned") {
      toast("Choose a non-hazardous support activity before assigning.", true);
      return;
    }
    if (!window.confirm("Confirm this non-hazardous coordination update? Volunteers must not enter hazardous areas.")) return;
    button.disabled = true;
    try {
      await api(`/api/volunteers/${card.dataset.volunteerId}`, { method: "PATCH", body: JSON.stringify({ status, activity }) });
      toast("Volunteer coordination updated.");
      await loadVolunteers($("#volunteer-search").value);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }
  async function loadPreparedness() {
    try {
      const [guideResponse, checklistResponse] = await Promise.all([
        api("/api/preparedness"),
        isReadOnly
          ? Promise.resolve({ completed: JSON.parse(localStorage.getItem("safesignal-checklist") || "{}") })
          : api("/api/checklist").catch(() => ({ completed: JSON.parse(localStorage.getItem("safesignal-checklist") || "{}") })),
      ]);
      state.guides = guideResponse.guides || {};
      state.checklist = checklistResponse.completed || {};
      renderPreparedness();
    } catch (error) {
      const cached = localStorage.getItem("safesignal-guides");
      if (cached) {
        state.guides = JSON.parse(cached);
        state.checklist = JSON.parse(localStorage.getItem("safesignal-checklist") || "{}");
        renderPreparedness();
        toast("Showing cached preparedness guides.");
      } else $("#prep-content").innerHTML = emptyMarkup("fa-triangle-exclamation", "Guides unavailable", error.message);
    }
  }
  function renderPreparedness() {
    localStorage.setItem("safesignal-guides", JSON.stringify(state.guides));
    const names = Object.keys(state.guides);
    if (!names.includes(state.activeGuide)) state.activeGuide = names[0] || "Floods";
    $("#prep-tabs").innerHTML = names.map(name => `<button class="prep-tab ${state.activeGuide === name ? "active" : ""}" data-guide="${escapeHtml(name)}"><i class="fa-solid ${guideIcons[name] || "fa-shield"}"></i>${escapeHtml(name)}</button>`).join("");
    const guide = state.guides[state.activeGuide];
    if (!guide) return;
    const groups = [["Before", "before", "fa-clock"], ["During", "during", "fa-person-running"], ["After", "after", "fa-arrow-rotate-left"]];
    $("#prep-content").innerHTML = `<div class="prep-guide-header"><div class="eyebrow"><span class="eyebrow-line"></span> HAZARD PREPAREDNESS</div><h2>${escapeHtml(state.activeGuide)}</h2><p>General preparedness information · Confirm current advice with official local authorities.</p></div><div class="guide-columns">${groups.map(([label, key, icon]) => `<article class="guide-stage"><h3><i class="fa-solid ${icon}"></i>${label} the event</h3>${(guide[key] || []).map((item, index) => checklistItem(`${state.activeGuide}/${key}/${index}`, item)).join("")}</article>`).join("")}</div><article class="panel kit-panel"><h3><i class="fa-solid fa-kit-medical" style="color:var(--cyan);margin-right:6px"></i>Emergency kit checklist</h3><div class="kit-items">${["Drinking water", "Non-perishable food", "Essential medicines", "First-aid supplies", "Torch and batteries", "Battery radio", "Copies of important documents", "Phone charger or power bank"].map((item, index) => checklistItem(`kit/${index}`, item)).join("")}</div><p class="field-help">Adapt this list for your household, local hazards and official guidance.</p></article><article class="panel kit-panel"><h3><i class="fa-solid fa-people-arrows-left-right" style="color:var(--cyan);margin-right:6px"></i>Family communication plan</h3><div class="kit-items">${["Choose an out-of-area contact.", "Agree on a meeting point.", "Keep key phone numbers on paper.", "Plan support for children, older adults and pets."].map((item, index) => checklistItem(`family/${index}`, item)).join("")}</div></article>`;
    updatePrepProgress();
  }
  function checklistItem(key, text) {
    return `<label class="checklist-item"><input type="checkbox" data-check-key="${escapeHtml(key)}" ${state.checklist[key] ? "checked" : ""}><span>${escapeHtml(text)}</span></label>`;
  }
  async function persistChecklist(input) {
    const key = input.dataset.checkKey;
    state.checklist[key] = input.checked;
    localStorage.setItem("safesignal-checklist", JSON.stringify(state.checklist));
    updatePrepProgress();
    if (!isReadOnly && navigator.onLine) {
      try { await api("/api/checklist", { method: "POST", body: JSON.stringify({ item_key: key, completed: input.checked }) }); }
      catch (_) { /* local copy remains available if the network is interrupted */ }
    }
  }
  function updatePrepProgress() {
    const items = $$("[data-check-key]", $("#prep-content"));
    const done = items.filter(input => input.checked).length;
    const percent = items.length ? Math.round(done / items.length * 100) : 0;
    $("#prep-progress-value").textContent = `${percent}%`;
    $("#prep-progress-bar").style.width = `${percent}%`;
  }
  async function loadAnalytics() {
    try {
      const data = await api("/api/analytics");
      const types = data.report_types || [], statuses = data.report_statuses || [], days = data.daily || [];
      $("#category-empty").style.display = types.length ? "none" : "grid";
      $("#status-empty").style.display = statuses.length ? "none" : "grid";
      $("#daily-empty").style.display = days.length ? "none" : "grid";
      makeChart($("#category-chart"), "bar", { labels: types.map(item => item.incident_type), datasets: [{ label: "Reports", data: types.map(item => item.count), backgroundColor: ["#50d0c6", "#68acec", "#e7ae59", "#ed856f", "#9d8ce5", "#6db88a", "#de7291"], borderRadius: 5, maxBarThickness: 26 }] }, { plugins: { legend: { display: false } }, scales: { x: { ...chartDefaults().scales.x, grid: { display: false } } } });
      makeChart($("#status-chart"), "doughnut", { labels: statuses.map(item => item.status), datasets: [{ data: statuses.map(item => item.count), backgroundColor: ["#e7b45e", "#6bb7ed", "#71d0a1", "#43c8bf", "#ec8278"], borderWidth: 2, borderColor: "#10212e" }] }, { plugins: { legend: { position: "bottom" } }, scales: {} });
      makeChart($("#daily-chart"), "line", { labels: days.map(item => item.day), datasets: [{ label: "Recorded reports", data: days.map(item => item.count), borderColor: "#64d6cc", backgroundColor: "#64d6cc20", fill: true, tension: .35, pointRadius: 3 }] }, { plugins: { legend: { display: false } } });
      $("#shortage-list").innerHTML = data.shortages.length ? data.shortages.map(item => `<div class="shortage-item"><span>${escapeHtml(item.name)} · ${escapeHtml(item.area)}</span><b>${item.quantity} ${escapeHtml(item.unit)}</b></div>`).join("") : emptyMarkup("fa-box-open", "No low quantities", "No tracked item has a quantity at or below 20.");
    } catch (error) { toast(`Analytics unavailable: ${error.message}`, true); }
  }
  async function loadShelters() {
    try {
      const result = await api("/api/shelters");
      const icons = { "Public shelter": "fa-house", Hospital: "fa-house-medical", "Public assistance center": "fa-hand-holding-heart", "Relief camp": "fa-tent" };
      $("#shelter-grid").innerHTML = (result.locations || []).map(item => `<article class="shelter-card"><span class="shelter-card-icon"><i class="fa-solid ${icons[item.type] || "fa-location-dot"}"></i></span><h3>${escapeHtml(item.name)}</h3><span class="shelter-type">${escapeHtml(item.type)} · ${escapeHtml(item.status)}</span><dl><div><dt>Location</dt><dd>${escapeHtml(item.location)}</dd></div><div><dt>Capacity</dt><dd>${escapeHtml(item.capacity)}</dd></div><div><dt>Contact</dt><dd>${escapeHtml(item.contact)}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(item.updated)}</dd></div></dl><div class="shelter-card-foot">SOURCE · ${escapeHtml(item.source)} · DEMO ENTRY</div></article>`).join("");
    } catch (error) { $("#shelter-grid").innerHTML = emptyMarkup("fa-triangle-exclamation", "Directory unavailable", error.message); }
  }
  async function loadRecovery() {
    try {
      const data = await api("/api/recovery");
      $("#recovery-percent").innerHTML = `${data.progress}<span>%</span>`;
      $("#recovery-total").textContent = data.total_reports;
      $("#recovery-note").textContent = data.note;
      $("#recovery-ring").style.background = `conic-gradient(var(--cyan) ${data.progress}%,#203a45 ${data.progress}%)`;
      const statuses = ["Submitted", "Under Review", "Verified", "Resolved"];
      const colors = ["#e7b45e", "#79b8e9", "#80d1a2", "#50c8bd"];
      $("#recovery-cards").innerHTML = statuses.map((status, index) => `<div class="recovery-stat"><span>${status}</span><b style="color:${colors[index]}">${data.report_status[status] || 0}</b></div>`).join("");
      await loadReports();
      renderRecoveryNeeds();
    } catch (error) { toast(`Recovery data unavailable: ${error.message}`, true); }
  }
  async function loadOverview() {
    try {
      const data = await api("/api/overview");
      renderDashboard(data);
      if ($("#view-dashboard").classList.contains("active")) initPreviewMap();
    } catch (error) {
      $("#dashboard-alerts").innerHTML = emptyMarkup("fa-triangle-exclamation", "Dashboard unavailable", error.message);
      toast(error.message, true);
    }
  }
  async function loadMapPoints() {
    try {
      const data = await api("/api/map-points");
      state.mapPoints = data.points || [];
      state.floodZones = data.flood_zones || [];
      buildLayerToggles();
      if (state.map) renderMapMarkers();
      if (state.previewMap) renderPreviewMarkers();
      renderMapZones();
      renderMapConsole();
    } catch (error) {
      if ($("#map-layers")) $("#map-layers").innerHTML = `<p class="field-help">${escapeHtml(error.message)}</p>`;
    }
  }
  function tileLayer(map, style = "streets") {
    if (!window.L) return null;
    if (style === "satellite") {
      return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxZoom: 19, crossOrigin: true,
      }).addTo(map);
    }
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      subdomains: "abc", maxZoom: 19, crossOrigin: true,
    }).addTo(map);
  }
  function setBasemap(style) {
    if (!state.map || !["streets", "satellite"].includes(style)) return;
    state.baseStyle = style;
    if (state.baseLayer) state.map.removeLayer(state.baseLayer);
    state.baseLayer = tileLayer(state.map, style);
    $("#basemap-satellite").classList.toggle("active", style === "satellite");
    $("#basemap-street").classList.toggle("active", style === "streets");
    if (state.previewMap && state.previewBaseLayer) {
      state.previewMap.removeLayer(state.previewBaseLayer);
      state.previewBaseLayer = tileLayer(state.previewMap, style);
    }
  }
  function initMap() {
    if (state.map || !window.L || !$("#main-map")) return;
    state.map = L.map("main-map", { zoomControl: true }).setView([13.0827, 80.2707], 11);
    state.baseLayer = tileLayer(state.map, state.baseStyle);
    state.markerLayers = {};
    layerTypes.forEach(type => { state.markerLayers[type] = L.layerGroup().addTo(state.map); });
    renderMapMarkers();
    window.setTimeout(() => state.map.invalidateSize(), 120);
  }
  function initPreviewMap() {
    if (state.previewMap || !window.L || !$("#preview-map")) return;
    state.previewMap = L.map("preview-map", { zoomControl: true, attributionControl: true }).setView([13.0827, 80.2707], 11);
    state.previewBaseLayer = tileLayer(state.previewMap, state.baseStyle);
    renderPreviewMarkers();
    renderMapZones();
    window.setTimeout(() => state.previewMap.invalidateSize(), 120);
  }
  function markerColor(type) {
    if (type === "Hospitals" || type === "Relief camps") return "#53d2b0";
    if (type === "Community reports" || type === "Flood reports" || type === "Road closure reports" || type === "Landslide reports") return "#e97970";
    return "#e8a84e";
  }
  function addMarker(point, map, small = false) {
    const color = point.type === "Community reports" && point.status === "Verified" ? "#53d2b0" : markerColor(point.type);
    const marker = L.circleMarker([point.lat, point.lng], { radius: small ? 5 : 8, color: "#071923", weight: 2, fillColor: color, fillOpacity: .95 }).addTo(map);
    const provenance = point.simulated === false ? "COMMUNITY SUBMISSION" : "SIMULATED MARKER";
    marker.bindPopup(`<b>${escapeHtml(point.title)}</b><br><small>${escapeHtml(provenance)}<br>${escapeHtml(point.type)} · ${escapeHtml(point.status)}<br>${escapeHtml(point.detail)}</small>`);
    if (!small) marker.on("click", () => {
      $("#selected-location").innerHTML = `<span class="empty-icon"><i class="fa-solid fa-location-dot"></i></span><b>${escapeHtml(point.title)}</b><p>${escapeHtml(point.type)} · ${escapeHtml(point.status)}<br>${escapeHtml(point.detail)}</p>`;
    });
    return marker;
  }
  function renderMapMarkers() {
    if (!state.map) return;
    Object.values(state.markerLayers).forEach(layer => layer.clearLayers());
    state.mapPoints.forEach(point => {
      const group = state.markerLayers[point.type];
      if (!group || !document.getElementById(`layer-${point.type}`)?.checked) return;
      addMarker(point, group);
    });
    renderMapZones();
  }
  function renderMapZones() {
    if (state.map) {
      state.mainZonePolygons?.forEach(polygon => polygon.remove());
      state.mainZonePolygons = [];
      const visible = document.getElementById("layer-Flood reports")?.checked !== false;
      if (visible) state.mainZonePolygons = state.floodZones.map(zone => L.polygon(zone.coordinates, { color: "#f27670", weight: 2, dashArray: "7 6", fillColor: "#e9645d", fillOpacity: .19 }).addTo(state.map).bindTooltip(`${zone.name} · SIMULATED`, { sticky: true }));
    }
    if (state.previewMap) {
      state.previewZonePolygons?.forEach(polygon => polygon.remove());
      state.previewZonePolygons = state.floodZones.map(zone => L.polygon(zone.coordinates, { color: "#f27670", weight: 1.5, dashArray: "5 5", fillColor: "#e9645d", fillOpacity: .22 }).addTo(state.previewMap));
    }
  }
  function renderPreviewMarkers() {
    if (!state.previewMap) return;
    state.previewMarkers?.forEach(marker => marker.remove());
    state.previewMarkers = state.mapPoints.map(point => addMarker(point, state.previewMap, true));
  }
  function buildLayerToggles() {
    $("#map-layers").innerHTML = layerTypes.map((type, index) => `<label class="layer-toggle"><input id="layer-${escapeHtml(type)}" type="checkbox" checked data-layer="${escapeHtml(type)}"><span>${escapeHtml(type)}</span><i class="fa-solid ${layerIcons[index]}"></i></label>`).join("");
    if (state.map) {
      state.markerLayers = {};
      layerTypes.forEach(type => { state.markerLayers[type] = L.layerGroup().addTo(state.map); });
      renderMapMarkers();
    }
  }
  async function searchMap() {
    const query = $("#map-search").value.trim().toLowerCase();
    if (!state.map || !query) return;
    const point = state.mapPoints.find(item => `${item.title} ${item.type} ${item.detail}`.toLowerCase().includes(query));
    if (point) {
      state.map.setView([point.lat, point.lng], 14);
      const layers = state.markerLayers[point.type];
      layers?.eachLayer(marker => {
        if (marker.getLatLng().lat === point.lat && marker.getLatLng().lng === point.lng) marker.openPopup();
      });
      return;
    }
    const elapsed = Date.now() - lastGeocodeRequest;
    if (elapsed < 1000) await new Promise(resolve => window.setTimeout(resolve, 1000 - elapsed));
    lastGeocodeRequest = Date.now();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 9000);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Place search failed (${response.status}).`);
      const results = await response.json();
      if (!results.length) { toast("No matching place found on OpenStreetMap.", true); return; }
      const result = results[0];
      const lat = Number(result.lat), lng = Number(result.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("OpenStreetMap returned an invalid location.");
      state.map.setView([lat, lng], 14);
      state.searchMarker?.remove();
      state.searchMarker = L.marker([lat, lng]).addTo(state.map).bindPopup(`<b>Place search result</b><br><small>${escapeHtml(result.display_name)}<br>OpenStreetMap Nominatim</small>`).openPopup();
      $("#selected-location").innerHTML = `<span class="empty-icon"><i class="fa-solid fa-map-pin"></i></span><b>Place search result</b><p>${escapeHtml(result.display_name)}<br>Found using OpenStreetMap Nominatim. Not a disaster or shelter marker.</p>`;
    } catch (error) {
      const detail = error.name === "AbortError" ? "Place search timed out. Try again." : error.message;
      toast(detail || "Place search is unavailable. Check your connection.", true);
    } finally { window.clearTimeout(timeout); }
  }
  async function useLocation(target) {
    if (!navigator.geolocation) { toast("Location is not available in this browser.", true); return; }
    if (!window.confirm("Share your current location with this page? Coordinates are used only to fill the form or center the map and are not saved unless you submit them.")) return;
    navigator.geolocation.getCurrentPosition(position => {
      const { latitude, longitude } = position.coords;
      if (target === "report") {
        $("#report-form").elements.latitude.value = latitude.toFixed(6);
        $("#report-form").elements.longitude.value = longitude.toFixed(6);
        toast("Location added to the optional report fields.");
      } else if (state.map) state.map.setView([latitude, longitude], 13);
    }, error => toast(error.message || "Unable to access location.", true), { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }
  function appendChat(text, role, mode = "") {
    const row = document.createElement("div");
    row.className = `chat-message ${role === "user" ? "user-message" : "assistant-message"}`;
    const icon = role === "user" ? "fa-user" : "fa-sparkles";
    const author = role === "user" ? "YOU" : "SAFESIGNAL AI";
    row.innerHTML = `<span class="message-avatar"><i class="fa-solid ${icon}"></i></span><div class="message-body"><div class="message-author">${author}${mode ? `<span>${escapeHtml(mode.toUpperCase())}</span>` : ""}</div><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>${role === "assistant" ? "<small>Not official emergency guidance · verify with authorities</small>" : ""}</div>`;
    $("#chat-messages").appendChild(row);
    $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  }
  async function sendChat(event) {
    event.preventDefault();
    const input = $("#chat-input");
    const message = input.value.trim();
    if (!message) return;
    appendChat(message, "user");
    input.value = "";
    const typing = document.createElement("div");
    typing.className = "chat-message assistant-message typing-row";
    typing.innerHTML = '<span class="message-avatar"><i class="fa-solid fa-sparkles"></i></span><div class="message-body"><div class="message-author">SAFESIGNAL AI</div><p><i class="fa-solid fa-circle-notch fa-spin"></i> Thinking…</p></div>';
    $("#chat-messages").appendChild(typing);
    $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
    try {
      const response = await api("/api/assistant", { method: "POST", body: JSON.stringify({ message, language: $("#assistant-language").value }) });
      typing.remove();
      appendChat(response.answer, "assistant", response.mode === "demo fallback" ? "fallback" : response.mode);
    } catch (error) { typing.remove(); appendChat(`I couldn't process that request: ${error.message}. If you need urgent help, contact local emergency services.`, "assistant", "error"); }
  }
  async function translateMessage() {
    const button = $("#translate-button");
    const text = $("#translation-input").value.trim();
    if (!text) { toast("Enter a short message to translate.", true); return; }
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Translating…';
    try {
      const result = await api("/api/translate", { method: "POST", body: JSON.stringify({ text, language: $("#translation-language").value }) });
      $("#translation-output").innerHTML = `<span class="translation-success"><i class="fa-solid fa-check"></i> ${escapeHtml(result.mode)}</span><b>${escapeHtml(result.translation)}</b><p>${escapeHtml(result.disclaimer || "Review translations carefully; this is not official emergency guidance.")}</p>`;
    } catch (error) {
      $("#translation-output").innerHTML = `<span class="translation-error"><i class="fa-solid fa-circle-exclamation"></i> Translation unavailable</span><b>${escapeHtml(error.message)}</b><p>Try one of the curated phrases or configure an AI translation API.</p>`;
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-language"></i> Translate';
    }
  }
  function registerEvents() {
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-view]");
      if (nav) { event.preventDefault(); showView(nav.dataset.view); }
      const notice = event.target.closest(".notice-close");
      if (notice) notice.closest(".notice-banner").remove();
      const prompt = event.target.closest("[data-prompt]");
      if (prompt) { $("#chat-input").value = prompt.dataset.prompt; $("#chat-input").focus(); }
      const guide = event.target.closest("[data-guide]");
      if (guide) { state.activeGuide = guide.dataset.guide; renderPreparedness(); }
      const check = event.target.closest("[data-check-key]");
      if (check && check.type === "checkbox") persistChecklist(check);
      const edit = event.target.closest(".resource-edit");
      if (edit) openResourceModal(state.resources.find(item => item.id === Number(edit.closest("[data-resource-id]").dataset.resourceId)));
      const remove = event.target.closest(".resource-delete");
      if (remove) deleteResource(remove);
      const adminUpdate = event.target.closest(".admin-save");
      if (adminUpdate) updateReportStatus(adminUpdate);
      const volunteerUpdate = event.target.closest(".volunteer-save");
      if (volunteerUpdate) updateVolunteer(volunteerUpdate);
    });
    $("#menu-button").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#mobile-scrim").classList.add("show"); });
    $("#mobile-scrim").addEventListener("click", () => { $("#sidebar").classList.remove("open"); $("#mobile-scrim").classList.remove("show"); });
    $("#large-text-button").addEventListener("click", () => { document.body.classList.toggle("large-text"); toast(document.body.classList.contains("large-text") ? "Larger text enabled." : "Standard text size restored."); });
    $("#language-button").addEventListener("click", () => showView("language"));
    $("#alert-search").addEventListener("input", renderAlerts);
    $("#alert-severity").addEventListener("change", renderAlerts);
    $("#alert-sort").addEventListener("change", renderAlerts);
    $("#report-form").addEventListener("submit", submitReport);
    $("#report-status-filter").addEventListener("change", loadReports);
    $("#report-category-filter").addEventListener("change", loadReports);
    $("#refresh-reports").addEventListener("click", loadReports);
    $("#new-report-button").addEventListener("click", () => { $("#report-form-panel").scrollIntoView({ behavior: "smooth", block: "start" }); $("#report-form").elements.incident_type.focus({ preventScroll: true }); });
    $("#report-location").addEventListener("click", () => useLocation("report"));
    $("#resource-form").addEventListener("submit", saveResource);
    $("#add-resource-button")?.addEventListener("click", () => openResourceModal());
    $("#modal-close").addEventListener("click", () => { $("#modal-backdrop").hidden = true; });
    $("#modal-backdrop").addEventListener("click", event => { if (event.target === $("#modal-backdrop")) $("#modal-backdrop").hidden = true; });
    $("#volunteer-form").addEventListener("submit", saveVolunteer);
    $("#register-volunteer-button").addEventListener("click", () => { $("#volunteer-modal-backdrop").hidden = false; $("#volunteer-form").elements.name.focus(); });
    $("#volunteer-modal-close").addEventListener("click", () => { $("#volunteer-modal-backdrop").hidden = true; });
    $("#volunteer-modal-backdrop").addEventListener("click", event => { if (event.target === $("#volunteer-modal-backdrop")) $("#volunteer-modal-backdrop").hidden = true; });
    $("#resource-search").addEventListener("input", event => loadResources(event.target.value));
    $("#resource-status-filter").addEventListener("change", () => loadResources($("#resource-search").value));
    $("#volunteer-search").addEventListener("input", event => loadVolunteers(event.target.value));
    $("#admin-refresh").addEventListener("click", loadReports);
    $("#chat-form").addEventListener("submit", sendChat);
    $("#translate-button").addEventListener("click", translateMessage);
    $("#chat-input").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#chat-form").requestSubmit(); } });
    $("#map-search").addEventListener("keydown", event => { if (event.key === "Enter") searchMap(); });
    $("#locate-button").addEventListener("click", () => useLocation("map"));
    $("#map-reset").addEventListener("click", () => {
      state.searchMarker?.remove();
      state.map?.setView([13.0827, 80.2707], 11);
      $("#map-search").value = "";
      $("#selected-location").innerHTML = '<span class="empty-icon"><i class="fa-solid fa-location-crosshairs"></i></span><b>Select a marker</b><p>Location details will appear here. Verify information with official sources.</p>';
    });
    $("#map-search-submit").addEventListener("click", searchMap);
    $("#map-layers").addEventListener("change", event => { if (event.target.matches("[data-layer]")) { renderMapMarkers(); renderMapZones(); } });
    $("#layers-all").addEventListener("click", () => { $$("[data-layer]").forEach(input => { input.checked = true; }); renderMapMarkers(); });
    $("#start-flood-simulation").addEventListener("click", activateFloodSimulation);
    $("#reset-flood-simulation").addEventListener("click", resetFloodSimulation);
    window.addEventListener("online", setNetworkState);
    window.addEventListener("offline", setNetworkState);
  }
  async function start() {
    registerEvents();
    setNetworkState();
    localTime();
    window.setInterval(localTime, 30000);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(error => console.info("Offline cache not registered:", error.message));
    if (!window.L) {
      $("#map-layers").innerHTML = emptyMarkup("fa-map", "Map library unavailable", "Connect to the internet to load Leaflet and OpenStreetMap tiles.");
    }
    if (!window.Chart) console.warn("Chart.js is not available; data panels remain accessible without charts.");
    try {
      await loadOverview();
      await loadAlerts();
      await loadMapPoints();
      await loadAnalytics();
    } catch (error) { toast(error.message, true); }
    finally {
      renderAlerts();
      chartsReady = true;
      const loader = $("#app-loading-screen");
      loader?.classList.add("is-hidden");
      window.setTimeout(() => loader?.remove(), 350);
    }
  }
  start();
}());
