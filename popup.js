// popup.js - provides controls, checklists, real-time logging, progress tracking, and file opening
let currentMessageId = null;
let selectedCandidates = new Set();
let foundCandidates = [];

// DOM References
const btnScan = document.getElementById("btn-scan");
const btnVerify = document.getElementById("btn-verify");
const btnOptions = document.getElementById("btn-options");
const candidatesList = document.getElementById("candidates-list");
const statusPanel = document.getElementById("status-panel");
const latestFileCard = document.getElementById("latest-file-card");
const latestFileName = document.getElementById("latest-file-name");
const btnShowFolder = document.getElementById("btn-show-folder");
const logConsole = document.getElementById("log-console");
const btnCopyLog = document.getElementById("btn-copy-log");
const btnClearLog = document.getElementById("btn-clear-log");

// Open options page
btnOptions.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

// Update the enabled state of the Verify button
function updateVerifyButtonState() {
  btnVerify.disabled = selectedCandidates.size === 0 || !currentMessageId;
}

// Copy logs to clipboard
btnCopyLog.addEventListener("click", () => {
  logConsole.select();
  document.execCommand("copy");
  const origText = btnCopyLog.innerText;
  btnCopyLog.innerText = "Copied!";
  setTimeout(() => {
    btnCopyLog.innerText = origText;
  }, 1500);
});

// Clear logs
btnClearLog.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ action: "clearLogs" });
  logConsole.value = "";
});

// Format candidate labels
function formatScenarioLabel(scenario) {
  switch (scenario) {
    case "single": return "Standalone File";
    case "single-p7s": return "Isolated Sig";
    case "detached-p7s": return "Detached Sig Pair";
    default: return scenario;
  }
}

// Render the checklist of candidates
function renderCandidates(candidates) {
  candidatesList.innerHTML = "";
  if (!candidates || candidates.length === 0) {
    candidatesList.innerHTML = `<div style="color: #6c757d; font-size: 12px; text-align: center; padding: 10px;">No compatible attachments found.</div>`;
    return;
  }

  foundCandidates = candidates;

  candidates.forEach(cand => {
    const item = document.createElement("div");
    item.className = "candidate-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = cand.id;
    // Default to checked
    checkbox.checked = true;
    selectedCandidates.add(cand.id);

    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        selectedCandidates.add(cand.id);
      } else {
        selectedCandidates.delete(cand.id);
      }
      updateVerifyButtonState();
    });

    const label = document.createElement("span");
    label.style.fontSize = "13px";
    label.innerText = cand.label;

    const badge = document.createElement("span");
    badge.className = `candidate-scenario scenario-${cand.scenario}`;
    badge.innerText = formatScenarioLabel(cand.scenario);

    item.appendChild(checkbox);
    item.appendChild(label);
    item.appendChild(badge);
    candidatesList.appendChild(item);
  });

  updateVerifyButtonState();
}

// Fetch and render diagnostics logs
async function updateLogs() {
  const response = await browser.runtime.sendMessage({ action: "getLogs" });
  if (response && response.logs) {
    logConsole.value = response.logs.join("\n");
    // Scroll to bottom
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

// Keep tracking of last download ID
let lastDownloadId = null;

// Show downloaded file in system folder location
btnShowFolder.addEventListener("click", () => {
  if (lastDownloadId) {
    browser.downloads.show(lastDownloadId).catch(err => {
      console.error("Failed to show file in folder:", err);
    });
  }
});

// Synchronize all status tasks and logs from background
async function syncStatusAndLogs() {
  // Sync Logs
  await updateLogs();

  // Sync Tasks & Download widget
  const res = await browser.runtime.sendMessage({ action: "getTasks" });
  if (res) {
    const { tasks, lastSavedResult } = res;
    
    // Render status progress
    const taskIds = Object.keys(tasks);
    if (taskIds.length === 0) {
      statusPanel.innerHTML = `<div style="color: #6c757d; font-size: 12px; text-align: center; padding: 10px;">No active tasks running.</div>`;
    } else {
      statusPanel.innerHTML = "";
      taskIds.forEach(reqId => {
        const task = tasks[reqId];
        const row = document.createElement("div");
        row.className = `task-row status-${task.status}`;

        const header = document.createElement("div");
        header.className = "task-header";
        
        const titleSpan = document.createElement("span");
        titleSpan.innerText = task.candidate.label;
        
        const statusSpan = document.createElement("span");
        statusSpan.style.fontSize = "11px";
        statusSpan.style.textTransform = "uppercase";
        statusSpan.style.fontWeight = "bold";
        
        if (task.status === "pending") {
          statusSpan.style.color = "#007bff";
          statusSpan.innerText = "PENDING";
        } else if (task.status === "ok") {
          statusSpan.style.color = "#28a745";
          statusSpan.innerText = "VERIFIED (OK)";
        } else if (task.status === "error") {
          statusSpan.style.color = "#dc3545";
          statusSpan.innerText = "FAILED";
        } else {
          statusSpan.style.color = "#6c757d";
          statusSpan.innerText = task.status;
        }

        header.appendChild(titleSpan);
        header.appendChild(statusSpan);
        row.appendChild(header);

        // Progress text
        const prog = document.createElement("div");
        prog.className = "task-progress";
        prog.innerText = task.progress;
        row.appendChild(prog);

        // Result Details
        if (task.result) {
          const det = document.createElement("div");
          det.className = "task-result";
          if (task.status === "ok" && task.result.resultText) {
            det.innerText = task.result.resultText;
          } else if (task.status === "error" && task.result.errorText) {
            det.innerText = `Error:\n${task.result.errorText}`;
          } else {
            det.innerText = "No detailed response extracted.";
          }
          row.appendChild(det);
        }

        statusPanel.appendChild(row);
      });
    }

    // Render Latest Saved Receipt Widget
    if (lastSavedResult) {
      latestFileCard.style.display = "block";
      latestFileName.innerText = `${lastSavedResult.filename} (${lastSavedResult.status || 'saved'})`;
      lastDownloadId = lastSavedResult.downloadId;
    } else {
      latestFileCard.style.display = "none";
    }
  }
}

// Trigger attachment scanning
btnScan.addEventListener("click", async () => {
  btnScan.disabled = true;
  candidatesList.innerHTML = `<div style="color: #6c757d; font-size: 12px; text-align: center; padding: 10px;">Scanning email attachments...</div>`;
  
  try {
    const res = await browser.runtime.sendMessage({ action: "scan" });
    if (res && res.success) {
      currentMessageId = res.messageId;
      selectedCandidates.clear();
      renderCandidates(res.candidates);
    } else {
      candidatesList.innerHTML = `<div style="color: #dc3545; font-size: 12px; text-align: center; padding: 10px;">Scan failed: ${res.error || 'Unknown error'}</div>`;
    }
  } catch (err) {
    candidatesList.innerHTML = `<div style="color: #dc3545; font-size: 12px; text-align: center; padding: 10px;">Error communicating with background script.</div>`;
  } finally {
    btnScan.disabled = false;
  }
  await updateLogs();
});

// Trigger verification
btnVerify.addEventListener("click", async () => {
  if (selectedCandidates.size === 0 || !currentMessageId) return;

  btnVerify.disabled = true;
  const idsToVerify = Array.from(selectedCandidates);
  
  try {
    await browser.runtime.sendMessage({
      action: "verifySelected",
      candidateIds: idsToVerify,
      messageId: currentMessageId
    });
  } catch (err) {
    console.error("Failed to trigger verification selected:", err);
  }
});

// Real-time log/status update listener
browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "logAdded") {
    // Fast append
    logConsole.value += "\n" + msg.log;
    logConsole.scrollTop = logConsole.scrollHeight;
  } else if (msg.action === "progressUpdate") {
    syncStatusAndLogs();
  }
});

// Initial loading syncs
document.addEventListener("DOMContentLoaded", () => {
  syncStatusAndLogs();
  // Poll status changes every 1000ms
  setInterval(syncStatusAndLogs, 1500);
});
