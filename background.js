// background.js - orchestrates business logic, ZIP parsing, downloads, and tags
if (typeof importScripts !== "undefined") {
  importScripts("jszip.min.js");
}

// Browser-compatible mime object matching specifications
const mime = {
  lookup: function (filename) {
    const ext = filename.toLowerCase().split(".").pop();
    switch (ext) {
      case "pdf": return "application/pdf";
      case "xml": return "text/xml";
      case "p7s": return "application/pkcs7-signature";
      case "asics":
      case "asice": return "application/zip";
      case "zip": return "application/zip";
      case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case "webp": return "image/webp";
      case "png": return "image/png";
      case "jpg":
      case "jpeg": return "image/jpeg";
      case "gif": return "image/gif";
      case "txt": return "text/plain";
      default: return null;
    }
  }
};

/**
 * Safely resolves the MIME type of an attachment buffer using a hybrid approach:
 * 1. Inspects the first 8 bytes (Magic Bytes) to block malicious file masquerading.
 * 2. Falls back to the extension-based resolution.
 *
 * @param {ArrayBuffer} arrayBuffer - The raw binary data of the file.
 * @param {string} filename - The declared filename.
 * @returns {string} - Resolved secure MIME-type or "application/octet-stream".
 */
function getSecureMimeType(arrayBuffer, filename) {
  const uint8 = new Uint8Array(arrayBuffer.slice(0, 8));
  let hex = "";
  for (let i = 0; i < uint8.length; i++) {
    hex += uint8[i].toString(16).padStart(2, "0").toUpperCase();
  }

  const ext = filename.toLowerCase().split(".").pop();

  if (hex.startsWith("4D5A")) {
    logDebug(`SECURITY ALERT: File "${filename}" detected as Windows Executable (MZ). Aborting processing!`);
    return "application/x-msdownload";
  }
  if (hex.startsWith("7F454C46")) {
    logDebug(`SECURITY ALERT: File "${filename}" detected as Linux Executable (ELF). Aborting processing!`);
    return "application/x-elf";
  }

  if (hex.startsWith("25504446")) {
    return "application/pdf";
  }
  if (hex.startsWith("3C3F786D6C")) {
    return "text/xml";
  }
  if (hex.startsWith("3082") || hex.startsWith("3080")) {
    return "application/pkcs7-signature";
  }
  if (hex.startsWith("504B0304")) {
    try {
      const lookedUpMime = mime.lookup(filename);
      if (lookedUpMime && lookedUpMime.includes("zip")) {
        return lookedUpMime;
      }
    } catch (e) {}
    return "application/zip";
  }

  try {
    return mime.lookup(filename) || "application/octet-stream";
  } catch (e) {
    return "application/octet-stream";
  }
}

// Detailed logs array for debugging without DevTools
let diagnosticsLogs = [];

function logDebug(message) {
  const timestamp = new Date().toISOString();
  const formattedLog = `[${timestamp}] ${message}`;
  diagnosticsLogs.push(formattedLog);
  console.log(formattedLog);
  try {
    browser.runtime.sendMessage({ action: "logAdded", log: formattedLog }).catch(() => {});
  } catch (e) {}
}

// Store download tracking
let lastSavedResult = null;

// Keeps map of current tasks being verified
let verificationTasks = {};

// Keeps pending page-triggered downloads matched by requestId
const pendingPageDownloads = new Map();

// Get current options
async function getOptions() {
  const defaults = {
    subfolder: "CZO-Verify-Results",
    askWhereToSave: false,
    verbose: false
  };
  try {
    const res = await browser.storage.local.get(["subfolder", "askWhereToSave", "verbose"]);
    return { ...defaults, ...res };
  } catch (e) {
    return defaults;
  }
}

// Convert helper for ArrayBuffer/Blob to Base64
function arrayBufferToBase64(buffer) {
  return toBase64(new Uint8Array(buffer));
}

// Fast Base64 conversion helper matching specification
function toBase64(uint8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Stem normalization for fuzzy pairing
function getStem(filename) {
  let name = filename.toLowerCase();
  name = name.replace(/\.p7s$/, "");
  name = name.replace(/\.(pdf|xml|asics|asice|zip)$/, "");
  name = name.replace(/\s*\(\d+\)/g, "");
  name = name.replace(/[\s\-_+()]/g, "");
  return name;
}

// Levenshtein distance calculation for fuzzy matching
function levenshteinDistance(s1, s2) {
  let memo = Array.from({ length: s1.length + 1 }, () => Array(s2.length + 1).fill(0));
  for (let i = 0; i <= s1.length; i++) memo[i][0] = i;
  for (let j = 0; j <= s2.length; j++) memo[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      memo[i][j] = Math.min(
        memo[i - 1][j] + 1,
        memo[i][j - 1] + 1,
        memo[i - 1][j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1)
      );
    }
  }
  return memo[s1.length][s2.length];
}

// Perform scan on displayed email message
async function scanActiveMessage() {
  logDebug("Starting message scan...");
  try {
    const messageList = await browser.messageDisplay.getDisplayedMessages();
    const displayedMessages = Array.isArray(messageList)
      ? messageList
      : (messageList && messageList.messages ? messageList.messages : []);

    if (!displayedMessages || displayedMessages.length === 0) {
      logDebug("No active message displayed in Thunderbird.");
      return { success: false, error: "No active message displayed." };
    }

    const msg = displayedMessages[0];
    logDebug(`Found displayed message: ID ${msg.id}, Subject: "${msg.subject}"`);

    const attachments = await browser.messages.listAttachments(msg.id);
    logDebug(`Found ${attachments.length} attachments on the message.`);

    let filePool = [];

    for (const attach of attachments) {
      logDebug(`Processing attachment: "${attach.name}" (${attach.size} bytes)`);
      try {
        const fileObj = await browser.messages.getAttachmentFile(msg.id, attach.partName);
        const arrayBuffer = await fileObj.arrayBuffer();

        const detectedMime = getSecureMimeType(arrayBuffer, attach.name);
        const ext = attach.name.toLowerCase().split(".").pop();

        logDebug(`Processing "${attach.name}": Declared Extension: .${ext} | Resolved MIME: ${detectedMime}`);

        if (detectedMime === "application/x-msdownload" || detectedMime === "application/x-elf") {
          logDebug(`Processing blocked for "${attach.name}" due to critical security threat (MIME mismatch).`);
          continue;
        }

        if (ext === "zip") {
          logDebug(`Extracting ZIP attachment: "${attach.name}"`);
          try {
            const zip = await JSZip.loadAsync(arrayBuffer);
            for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
              if (zipEntry.dir) continue;
              if (relativePath.includes("/")) continue;

              logDebug(`Extracted root file from ZIP: "${relativePath}"`);
              const contentBuffer = await zipEntry.async("arraybuffer");

              const entryMime = getSecureMimeType(contentBuffer, relativePath);
              if (entryMime === "application/x-msdownload" || entryMime === "application/x-elf") {
                logDebug(`SECURITY ALERT: Extracted file "${relativePath}" inside ZIP detected as Executable. Skipping file.`);
                continue;
              }

              filePool.push({
                name: relativePath,
                content: arrayBufferToBase64(contentBuffer),
                mime: entryMime,
                source: `zip:${attach.name}`
              });
            }
          } catch (zipErr) {
            logDebug(`Error loading/unpacking zip "${attach.name}": ${zipErr.message}`);
          }
        } else {
          filePool.push({
            name: attach.name,
            content: arrayBufferToBase64(arrayBuffer),
            mime: detectedMime,
            source: "attachment"
          });
        }
      } catch (attachErr) {
        logDebug(`Error processing attachment "${attach.name}": ${attachErr.message}`);
      }
    }

    logDebug(`Total files collected in pool for matching: ${filePool.length}`);

    const supportedExtensions = ["p7s", "pdf", "xml", "asics", "asice", "zip"];
    const candidates = [];

    const pool = filePool.filter(f => {
      const parts = f.name.toLowerCase().split(".");
      const ext = parts[parts.length - 1];
      return supportedExtensions.includes(ext);
    });

    logDebug(`Pool filtered to supported types: ${pool.length} files`);

    let sigFiles = pool.filter(f => f.name.toLowerCase().endsWith(".p7s"));
    let dataFiles = pool.filter(f => !f.name.toLowerCase().endsWith(".p7s"));

    const matchedDataNames = new Set();
    const matchedSigNames = new Set();

    for (const sig of sigFiles) {
      const sigStem = getStem(sig.name);
      let bestMatch = null;
      let minDistance = 999;

      logDebug(`Attempting to match detached signature: "${sig.name}" (stem: "${sigStem}")`);

      for (const data of dataFiles) {
        if (matchedDataNames.has(data.name)) continue;

        const dataStem = getStem(data.name);
        let isMatch = false;

        if (sigStem === dataStem) {
          isMatch = true;
          logDebug(`Exact stem match: "${sig.name}" <-> "${data.name}"`);
        } else if (sigStem.includes(dataStem) || dataStem.includes(sigStem)) {
          isMatch = true;
          logDebug(`Fuzzy stem contains: "${sig.name}" <-> "${data.name}"`);
        } else {
          const dist = levenshteinDistance(sigStem, dataStem);
          if (dist <= 3) {
            isMatch = true;
            logDebug(`Fuzzy Levenshtein match (dist ${dist}): "${sig.name}" <-> "${data.name}"`);
          }
        }

        if (isMatch) {
          const dist = levenshteinDistance(sigStem, dataStem);
          if (dist < minDistance) {
            minDistance = dist;
            bestMatch = data;
          }
        }
      }

      if (bestMatch) {
        logDebug(`Successfully matched signature "${sig.name}" with data file "${bestMatch.name}"`);
        candidates.push({
          id: `detached_${sig.name}_${bestMatch.name}`,
          scenario: "detached-p7s",
          label: `${sig.name} + ${bestMatch.name}`,
          files: [sig, bestMatch]
        });
        matchedDataNames.add(bestMatch.name);
        matchedSigNames.add(sig.name);
      }
    }

    for (const sig of sigFiles) {
      if (matchedSigNames.has(sig.name)) continue;
      logDebug(`Signature "${sig.name}" is unmatched. Creating single-p7s scenario.`);
      candidates.push({
        id: `single_p7s_${sig.name}`,
        scenario: "single-p7s",
        label: `${sig.name} (Signature only)`,
        files: [sig]
      });
    }

    for (const data of dataFiles) {
      if (matchedDataNames.has(data.name)) continue;

      const ext = data.name.toLowerCase().split(".").pop();
      if (["pdf", "xml", "asics", "asice", "zip"].includes(ext)) {
        logDebug(`Standalone file "${data.name}" is unmatched. Creating single scenario.`);
        candidates.push({
          id: `single_${data.name}`,
          scenario: "single",
          label: `${data.name}`,
          files: [data]
        });
      }
    }

    logDebug(`Completed pairing. Total candidates: ${candidates.length}`);
    return { success: true, messageId: msg.id, candidates };
  } catch (err) {
    logDebug(`Error scanning message: ${err.message}\n${err.stack}`);
    return { success: false, error: err.message };
  }
}

// Broadcast real-time verification tasks status
function updatePopupProgress() {
  try {
    browser.runtime.sendMessage({ action: "progressUpdate", tasks: verificationTasks, lastSavedResult }).catch(() => {});
  } catch (e) {}
}

function cleanupPendingDownload(requestId) {
  if (pendingPageDownloads.has(requestId)) {
    pendingPageDownloads.delete(requestId);
  }
  const task = verificationTasks[requestId];
  if (task) {
    delete task.pendingDownload;
  }
}

function sanitizeFilenamePart(name) {
  return String(name || "")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/[\\\/]+/g, "_")
    .trim() || "download";
}

async function tryMatchRecentDownloadForTask(requestId) {
  const task = verificationTasks[requestId];
  if (!task || !task.pendingDownload) return null;

  try {
    const startedAfter = new Date(task.pendingDownload.startedAt - 2000).toISOString();
    const results = await browser.downloads.search({
      startedAfter,
      limit: 20
    });

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const matched = results
      .filter(item => {
        if (!item) return false;
        if (item.byExtensionId) return false;
        const url = item.url || "";
        const referrer = item.referrer || "";
        return url.includes("czo.gov.ua") || referrer.includes("czo.gov.ua");
      })
      .sort((a, b) => {
        const ta = new Date(a.startTime || 0).getTime();
        const tb = new Date(b.startTime || 0).getTime();
        return tb - ta;
      })[0];

    if (!matched) return null;

    registerDownloadForTask(requestId, matched);
    return matched;
  } catch (err) {
    logDebug(`[${task.candidate.label}] Failed to search recent downloads: ${err.message}`);
    return null;
  }
}

function registerDownloadForTask(requestId, downloadItem) {
  const task = verificationTasks[requestId];
  if (!task) return;

  const fallbackName = task.pendingDownload?.expectedFilename || "archive.zip";
  const absoluteOrName = downloadItem.filename || fallbackName;
  const justName = absoluteOrName.split(/[\\/]/).pop() || fallbackName;

  lastSavedResult = {
    downloadId: downloadItem.id,
    filename: justName,
    filepath: absoluteOrName,
    timestamp: Date.now(),
    status: downloadItem.state || "in_progress",
    source: "page-click"
  };

  task.lastDownloadId = downloadItem.id;
  task.lastDownloadFilename = justName;
  task.lastDownloadPath = absoluteOrName;

  if (task.result) {
    task.result.savedResult = lastSavedResult;
  }

  logDebug(`[${task.candidate.label}] Captured page-triggered download. ID=${downloadItem.id}, file="${justName}"`);
  updatePopupProgress();
}

// Safely modify Thunderbird message tags
async function updateMessageTags(messageId, status) {
  logDebug(`Updating message tags for message ID ${messageId}. Status: ${status}`);
  let currentTags = [];

  try {
    const msg = await browser.messages.get(messageId);
    if (!msg) {
      logDebug(`Message ${messageId} not found for tagging.`);
      return;
    }

    currentTags = msg.tags || [];
    logDebug(`Pre-existing tags: ${JSON.stringify(currentTags)}`);

    currentTags = currentTags.filter(t => t !== "czo-verified" && t !== "czo-failed");

    if (status === "success") {
      currentTags.push("czo-verified");
      logDebug(`Appending tag czo-verified.`);
    } else {
      currentTags.push("czo-failed");
      logDebug(`Appending tag czo-failed.`);
    }

    await browser.messages.update(messageId, { tags: currentTags });
    logDebug(`Successfully updated tags: ${JSON.stringify(currentTags)}`);
  } catch (err) {
    logDebug(`Error updating message tags: ${err.message}. Trying fallback.`);
    try {
      if (browser.messages.setTags) {
        await browser.messages.setTags(messageId, currentTags);
        logDebug(`Fallback setTags succeeded.`);
      }
    } catch (fallbackErr) {
      logDebug(`Fallback tagging failed: ${fallbackErr.message}`);
    }
  }
}

// Verify candidate using CZO Automation background tab
async function runVerificationTask(candidate, messageId) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  logDebug(`[${candidate.label}] Starting verification task. scenario: ${candidate.scenario}, requestId: ${requestId}`);

  verificationTasks[requestId] = {
    candidate,
    messageId,
    status: "pending",
    progress: "Creating background tab",
    result: null,
    tabId: null,
    timeoutId: null,
    pendingDownload: null,
    lastDownloadId: null,
    lastDownloadFilename: null,
    lastDownloadPath: null
  };

  try {
    const url = "https://czo.gov.ua/verify";
    logDebug(`[${candidate.label}] Creating CZO verification tab: ${url}`);
    const tab = await browser.tabs.create({ url, active: false });

    verificationTasks[requestId].tabId = tab.id;

    const safetyTimeout = setTimeout(async () => {
      if (verificationTasks[requestId] && verificationTasks[requestId].status === "pending") {
        logDebug(`[${candidate.label}] Verification task timed out.`);
        verificationTasks[requestId].status = "error";
        verificationTasks[requestId].progress = "Timeout reached during CZO automation.";
        verificationTasks[requestId].error = "Verification process timed out.";
        cleanupPendingDownload(requestId);
        try {
          await browser.tabs.remove(tab.id);
        } catch (e) {}
        updatePopupProgress();
      }
    }, 300000);

    verificationTasks[requestId].timeoutId = safetyTimeout;
    updatePopupProgress();
  } catch (err) {
    logDebug(`[${candidate.label}] Error during tab creation: ${err.message}`);
    verificationTasks[requestId].status = "error";
    verificationTasks[requestId].progress = `Failed to create CZO tab: ${err.message}`;
    verificationTasks[requestId].error = err.message;
    updatePopupProgress();
  }

  return requestId;
}

// Silent automatic download handler via page-side click
async function handleSilentDownload(requestId, downloadButtonId) {
  const taskInfo = verificationTasks[requestId];
  if (!taskInfo || !taskInfo.tabId) return;

  const options = await getOptions();
  let folder = options.subfolder || "CZO-Verify-Results";
  folder = folder.replace(/[\\\/]+/g, "/").replace(/^\/|\/$/g, "");

  const expectedFilename = sanitizeFilenamePart(
    `${taskInfo.candidate.label}-archive-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`
  );

  taskInfo.pendingDownload = {
    startedAt: Date.now(),
    folder,
    expectedFilename,
    source: "page-click",
    buttonId: downloadButtonId || null
  };

  pendingPageDownloads.set(requestId, {
    tabId: taskInfo.tabId,
    startedAt: taskInfo.pendingDownload.startedAt
  });

  taskInfo.progress = 'Triggering page click on "Р—Р°РІР°РЅС‚Р°Р¶РёС‚Рё РІСЃРµ Р°СЂС…С–РІРѕРј"';
  logDebug(`[${taskInfo.candidate.label}] Requesting content script to click archive download button. Subfolder="${folder}" ButtonId="${downloadButtonId || ""}"`);

  try {
    await browser.tabs.sendMessage(taskInfo.tabId, {
      action: "clickArchiveDownload",
      requestId,
      downloadButtonId: downloadButtonId || null
    });

    setTimeout(() => {
      tryMatchRecentDownloadForTask(requestId);
    }, 2000);

    setTimeout(() => {
      tryMatchRecentDownloadForTask(requestId);
    }, 5000);

    updatePopupProgress();
  } catch (err) {
    logDebug(`[${taskInfo.candidate.label}] Failed to request page-side download click: ${err.message}`);
    taskInfo.progress = `Failed to trigger archive button: ${err.message}`;
    updatePopupProgress();
  }
}

// Legacy direct blob-url download fallback
async function downloadBlobUrl(requestId, blobUrl, filename) {
  const taskInfo = verificationTasks[requestId];
  if (!taskInfo) return;

  try {
    const options = await getOptions();
    let folder = options.subfolder || "CZO-Verify-Results";
    folder = folder.replace(/[\\\/]+/g, "/").replace(/^\/|\/$/g, "");

    const safeName = sanitizeFilenamePart(filename || "receipt.bin");
    const targetFilename = folder ? `${folder}/${safeName}` : safeName;

    logDebug(`[${taskInfo.candidate.label}] Triggering browser.downloads.download for url: ${blobUrl.substring(0, 100)}... to filename: ${targetFilename}`);

    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename: targetFilename,
      saveAs: options.askWhereToSave,
      conflictAction: "uniquify"
    });

    logDebug(`[${taskInfo.candidate.label}] Download started. Download ID: ${downloadId}`);

    lastSavedResult = {
      downloadId,
      filename: safeName,
      filepath: targetFilename,
      timestamp: Date.now(),
      status: "downloading",
      source: "extension-download"
    };

    if (taskInfo.result) {
      taskInfo.result.savedResult = lastSavedResult;
    }

    updatePopupProgress();
  } catch (err) {
    logDebug(`[${taskInfo.candidate.label}] Download failed: ${err.message}`);
  }
}

// Listen for created downloads and try to associate with pending CZO task
browser.downloads.onCreated.addListener((downloadItem) => {
  try {
    const activePending = Object.entries(verificationTasks).find(([requestId, task]) => {
      if (!task || !task.pendingDownload) return false;
      const now = Date.now();
      const age = now - task.pendingDownload.startedAt;
      if (age > 30000) return false;

      const url = downloadItem.url || "";
      const referrer = downloadItem.referrer || "";

      return !downloadItem.byExtensionId &&
        (url.includes("czo.gov.ua") || referrer.includes("czo.gov.ua"));
    });

    if (!activePending) return;

    const [requestId, task] = activePending;
    registerDownloadForTask(requestId, downloadItem);
    logDebug(`[${task.candidate.label}] downloads.onCreated matched download ID ${downloadItem.id}`);
  } catch (err) {
    logDebug(`Error in downloads.onCreated handler: ${err.message}`);
  }
});

// Listen to download completions and state changes
browser.downloads.onChanged.addListener((delta) => {
  if (lastSavedResult && delta.id === lastSavedResult.downloadId) {
    if (delta.state) {
      lastSavedResult.status = delta.state.current;
      logDebug(`Download ID ${delta.id} state changed to ${delta.state.current}`);
      if (delta.state.current === "complete") {
        lastSavedResult.completedTimestamp = Date.now();

        const matchedTask = Object.values(verificationTasks).find(task => task.lastDownloadId === delta.id);
        if (matchedTask) {
          matchedTask.progress = "Verification receipt/archive downloaded successfully";
        }
      }
      updatePopupProgress();
    }

    if (delta.filename && delta.filename.current) {
      lastSavedResult.filepath = delta.filename.current;
      lastSavedResult.filename = delta.filename.current.split(/[\\/]/).pop() || lastSavedResult.filename;

      const matchedTask = Object.values(verificationTasks).find(task => task.lastDownloadId === delta.id);
      if (matchedTask) {
        matchedTask.lastDownloadPath = delta.filename.current;
        matchedTask.lastDownloadFilename = lastSavedResult.filename;
        if (matchedTask.result) {
          matchedTask.result.savedResult = lastSavedResult;
        }
      }

      updatePopupProgress();
    }
  }
});

// Orchestrate overall verification runs
async function runAllVerifications(candidateIds, messageId) {
  logDebug(`Requested verification for candidates: ${JSON.stringify(candidateIds)}`);

  const scanResult = await scanActiveMessage();
  if (!scanResult.success) {
    logDebug("Failed to fetch candidates for running verification.");
    return;
  }

  const selectedCandidates = scanResult.candidates.filter(c => candidateIds.includes(c.id));
  logDebug(`Running verification on ${selectedCandidates.length} selected candidates.`);

  const requestIds = [];
  for (const candidate of selectedCandidates) {
    const requestId = await runVerificationTask(candidate, messageId);
    requestIds.push(requestId);
  }

  const intervalId = setInterval(async () => {
    let allFinished = true;
    let anyError = false;
    let allSuccess = true;

    for (const reqId of requestIds) {
      const task = verificationTasks[reqId];
      if (!task) continue;

      if (task.status === "pending") {
        allFinished = false;
      } else if (task.status === "error") {
        anyError = true;
        allSuccess = false;
      } else if (task.status === "ok") {
      } else {
        allSuccess = false;
      }
    }

    if (allFinished) {
      clearInterval(intervalId);
      logDebug(`All verification tasks finished. Success count: ${allSuccess}, Any error: ${anyError}`);

      const overallStatus = allSuccess ? "success" : "failure";
      await updateMessageTags(messageId, overallStatus);
    }
  }, 3000);
}

// Receive messages from content script, popup, and options
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "getLogs" && request.action !== "getTasks") {
    logDebug(`Message received: action = ${request.action}`);
  }

  if (request.action === "getLogs") {
    sendResponse({ logs: diagnosticsLogs });
    return true;
  }

  if (request.action === "clearLogs") {
    diagnosticsLogs = [];
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "scan") {
    scanActiveMessage().then(sendResponse);
    return true;
  }

  if (request.action === "verifySelected") {
    runAllVerifications(request.candidateIds, request.messageId).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === "getTasks") {
    sendResponse({ tasks: verificationTasks, lastSavedResult });
    return true;
  }

  if (request.action === "getLastSavedResult") {
    sendResponse({ lastSavedResult });
    return true;
  }

  // --- Content Script Interaction ---
  if (request.action === "widgetReady") {
    const senderTabId = sender.tab ? sender.tab.id : null;
    logDebug(`Content script reported ready in tab ID ${senderTabId}. Frame URL: ${sender.url}`);

    if (senderTabId) {
      const matchedReqId = Object.keys(verificationTasks).find(
        reqId => verificationTasks[reqId].tabId === senderTabId && verificationTasks[reqId].status === "pending"
      );

      if (matchedReqId) {
        const task = verificationTasks[matchedReqId];
        logDebug(`Found matching pending task ${matchedReqId} for tab ${senderTabId}. Injecting files!`);

        browser.tabs.sendMessage(senderTabId, {
          action: "injectFiles",
          requestId: matchedReqId,
          scenario: task.candidate.scenario,
          files: task.candidate.files
        }, { frameId: sender.frameId }).catch(err => {
          logDebug(`Error sending injectFiles to tab ${senderTabId}: ${err.message}`);
        });
      } else {
        logDebug(`No matching pending task found for tab ID ${senderTabId}.`);
      }
    }

    sendResponse({ success: true });
    return true;
  }

  if (request.action === "reportProgress") {
    const { requestId, progress } = request;
    if (verificationTasks[requestId]) {
      verificationTasks[requestId].progress = progress;
      logDebug(`[${verificationTasks[requestId].candidate.label}] Progress: ${progress}`);
      updatePopupProgress();
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "reportResult") {
    const {
      requestId,
      status,
      resultText,
      errorText,
      receiptBlobUrl,
      receiptFilename,
      autoDownloadArchive,
      downloadButtonId
    } = request;

    logDebug(`[verification result] for request ${requestId}. status: ${status}`);

    if (verificationTasks[requestId]) {
      const task = verificationTasks[requestId];
      task.status = status;
      task.progress = status === "ok"
        ? "Verification Completed Successfully"
        : "Verification Failed";

      task.result = {
        scenario: task.candidate.scenario,
        status,
        resultText,
        errorText,
        savedResult: null
      };

      if (task.timeoutId) {
        clearTimeout(task.timeoutId);
      }

      // Preferred flow: ask content script to click "Р—Р°РІР°РЅС‚Р°Р¶РёС‚Рё РІСЃРµ Р°СЂС…С–РІРѕРј"
      if (autoDownloadArchive) {
        handleSilentDownload(requestId, downloadButtonId).catch(err => {
          logDebug(`[${task.candidate.label}] handleSilentDownload failed: ${err.message}`);
        });
      }
      // Fallback: direct extension download if blob URL is explicitly provided
      else if (receiptBlobUrl && receiptFilename) {
        downloadBlobUrl(requestId, receiptBlobUrl, receiptFilename);
      }

      setTimeout(async () => {
        try {
          if (task.tabId) {
            logDebug(`Closing background tab ID ${task.tabId}`);
            await browser.tabs.remove(task.tabId);
          }
        } catch (e) {
          logDebug(`Error closing tab: ${e.message}`);
        } finally {
          cleanupPendingDownload(requestId);
        }
      }, 15000);

      updatePopupProgress();
    }

    sendResponse({ success: true });
    return true;
  }

  // Content script says it clicked archive button successfully
  if (request.action === "archiveDownloadClickDone") {
    const { requestId } = request;
    const task = verificationTasks[requestId];
    if (task) {
      task.progress = 'Archive button clicked; waiting for browser download';
      logDebug(`[${task.candidate.label}] Content script reported archive click completed.`);
      updatePopupProgress();
    }
    sendResponse({ success: true });
    return true;
  }

  // Content script says it failed to click archive button
  if (request.action === "archiveDownloadClickFailed") {
    const { requestId, error } = request;
    const task = verificationTasks[requestId];
    if (task) {
      task.progress = `Archive click failed: ${error}`;
      logDebug(`[${task.candidate.label}] Content script failed to click archive button: ${error}`);
      updatePopupProgress();
    }
    sendResponse({ success: true });
    return true;
  }

  // Legacy manual download request path
  if (request.action === "downloadReceipt") {
    const { requestId, blobUrl, filename } = request;
    downloadBlobUrl(requestId, blobUrl, filename);
    sendResponse({ success: true });
    return true;
  }

  return false;
});
