// background.js - orchestrates business logic, ZIP parsing, downloads, and tags
if (typeof importScripts !== "undefined") {
  importScripts("jszip.min.js");
}

// Detailed logs array for debugging without DevTools
let diagnosticsLogs = [];

function logDebug(message) {
  const timestamp = new Date().toISOString();
  const formattedLog = `[${timestamp}] ${message}`;
  diagnosticsLogs.push(formattedLog);
  console.log(formattedLog);
  // Send log update to popup if connected
  try {
    browser.runtime.sendMessage({ action: "logAdded", log: formattedLog }).catch(() => {});
  } catch (e) {}
}

// Store download trackings
let lastSavedResult = null;

// Get current options
async function getOptions() {
  const defaults = {
    subfolder: "CZO-Verify-Results",
    askWhereToSave: false,
    verbose: true
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
  let binary = "";
  let bytes = new Uint8Array(buffer);
  let len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Stem normalization for fuzzy pairing
function getStem(filename) {
  let name = filename.toLowerCase();
  // Strip trailing extension and dot
  name = name.replace(/\.p7s$/, "");
  name = name.replace(/\.(pdf|xml|asics|asice|zip)$/, "");
  // Strip punctuation, spaces, numbers in parens like " (1)" or "_signed"
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
    const displayedMessages = await browser.messageDisplay.getDisplayedMessages();
    if (!displayedMessages || displayedMessages.length === 0) {
      logDebug("No active message displayed in Thunderbird.");
      return { success: false, error: "No active message displayed." };
    }
    const msg = displayedMessages[0];
    logDebug(`Found displayed message: ID ${msg.id}, Subject: "${msg.subject}"`);

    const attachments = await browser.messages.listAttachments(msg.id);
    logDebug(`Found ${attachments.length} attachments on the message.`);

    let filePool = [];

    // Process attachments
    for (const attach of attachments) {
      logDebug(`Processing attachment: "${attach.name}" (${attach.size} bytes)`);
      try {
        const fileObj = await browser.messages.getAttachmentFile(msg.id, attach.part);
        const arrayBuffer = await fileObj.arrayBuffer();

        const ext = attach.name.toLowerCase().split('.').pop();
        if (ext === "zip") {
          logDebug(`Extracting ZIP attachment: "${attach.name}"`);
          try {
            const zip = await JSZip.loadAsync(arrayBuffer);
            for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
              if (zipEntry.dir) continue;
              // Extract at root level only, no nested folders parsing required
              if (relativePath.includes("/")) continue;

              logDebug(`Extracted root file from ZIP: "${relativePath}"`);
              const contentBuffer = await zipEntry.async("arraybuffer");
              filePool.push({
                name: relativePath,
                content: arrayBufferToBase64(contentBuffer),
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
            source: "attachment"
          });
        }
      } catch (attachErr) {
        logDebug(`Error retrieving attachment "${attach.name}": ${attachErr.message}`);
      }
    }

    logDebug(`Total files collected in pool for matching: ${filePool.length}`);

    // Pair/Categorize Candidates
    // Supported file types: .p7s, .pdf, .xml, .asics, .asice, .zip
    const supportedExtensions = ["p7s", "pdf", "xml", "asics", "asice", "zip"];
    const candidates = [];

    // Filter to only supported file extensions in pool
    const pool = filePool.filter(f => {
      const parts = f.name.toLowerCase().split('.');
      const ext = parts[parts.length - 1];
      return supportedExtensions.includes(ext);
    });

    logDebug(`Pool filtered to supported types: ${pool.length} files`);

    // Separate p7s signatures and potential payload/data files
    let sigFiles = pool.filter(f => f.name.toLowerCase().endsWith(".p7s"));
    let dataFiles = pool.filter(f => !f.name.toLowerCase().endsWith(".p7s"));

    // Track matched data file names to avoid double pairing
    const matchedDataNames = new Set();
    const matchedSigNames = new Set();

    // 1. Detached Signature Matching (fuzzy and stem matching)
    for (const sig of sigFiles) {
      const sigStem = getStem(sig.name);
      let bestMatch = null;
      let minDistance = 999;

      logDebug(`Attempting to match detached signature: "${sig.name}" (stem: "${sigStem}")`);

      for (const data of dataFiles) {
        if (matchedDataNames.has(data.name)) continue;

        const dataStem = getStem(data.name);

        // Check exact match, substring, or Levenshtein similarity
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
          // If multiple matches are possible, take the one with closest Levenshtein distance
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
          id: `detached_${sig.name}_${bestMatch.name}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          scenario: "detached-p7s",
          label: `${sig.name} + ${bestMatch.name}`,
          files: [sig, bestMatch]
        });
        matchedDataNames.add(bestMatch.name);
        matchedSigNames.add(sig.name);
      }
    }

    // 2. Unmatched signatures become single-p7s
    for (const sig of sigFiles) {
      if (matchedSigNames.has(sig.name)) continue;
      logDebug(`Signature "${sig.name}" is unmatched. Creating single-p7s scenario.`);
      candidates.push({
        id: `single_p7s_${sig.name}_${Date.now()}`,
        scenario: "single-p7s",
        label: `${sig.name} (Signature only)`,
        files: [sig]
      });
    }

    // 3. Unmatched data files (.pdf, .xml, .asics, .asice) become single
    for (const data of dataFiles) {
      if (matchedDataNames.has(data.name)) continue;

      const ext = data.name.toLowerCase().split('.').pop();
      // Standalone ZIPs are typically already unpacked, but if a standalone zip was somehow unmatched, it's ok.
      // Standalone .pdf, .xml, .asics, .asice
      if (["pdf", "xml", "asics", "asice", "zip"].includes(ext)) {
        logDebug(`Standalone file "${data.name}" is unmatched. Creating single scenario.`);
        candidates.push({
          id: `single_${data.name}_${Date.now()}`,
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

// Keeps map of current tasks being verified
let verificationTasks = {};

// Verify candidate using CZO Automation background tab
async function runVerificationTask(candidate, messageId) {
  const options = await getOptions();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  logDebug(`[${candidate.label}] Starting verification task. scenario: ${candidate.scenario}, requestId: ${requestId}`);

  // Put in verification map
  verificationTasks[requestId] = {
    candidate,
    messageId,
    status: "pending",
    progress: "Creating background tab",
    result: null
  };

  try {
    // Open czo.gov.ua/verify in background tab
    const url = "https://czo.gov.ua/verify";
    logDebug(`[${candidate.label}] Creating CZO verification tab: ${url}`);
    const tab = await browser.tabs.create({ url, active: false });

    verificationTasks[requestId].tabId = tab.id;

    // Set a safety timeout for overall verification flow (e.g. 5 minutes)
    const safetyTimeout = setTimeout(async () => {
      if (verificationTasks[requestId] && verificationTasks[requestId].status === "pending") {
        logDebug(`[${candidate.label}] Verification task timed out.`);
        verificationTasks[requestId].status = "error";
        verificationTasks[requestId].progress = "Timeout reached during CZO automation.";
        verificationTasks[requestId].error = "Verification process timed out.";
        // Close the tab
        try {
          await browser.tabs.remove(tab.id);
        } catch (e) {}
        updatePopupProgress();
      }
    }, 300000); // 5 minutes

    verificationTasks[requestId].timeoutId = safetyTimeout;

    // Send the upload configurations to background tab via storage/cookies or message.
    // Wait, content script is not yet loaded! So we will wait for it to report "ready" or poll.
    // Content script runs inside frames, so it will ping us or we can listen to tab status.
  } catch (err) {
    logDebug(`[${candidate.label}] Error during tab creation: ${err.message}`);
    verificationTasks[requestId].status = "error";
    verificationTasks[requestId].progress = `Failed to create CZO tab: ${err.message}`;
    verificationTasks[requestId].error = err.message;
    updatePopupProgress();
  }

  return requestId;
}

// Broadcast real-time verification tasks status
function updatePopupProgress() {
  try {
    browser.runtime.sendMessage({ action: "progressUpdate", tasks: verificationTasks }).catch(() => {});
  } catch (e) {}
}

// Safely modify Thunderbird message tags
async function updateMessageTags(messageId, status) {
  logDebug(`Updating message tags for message ID ${messageId}. Status: ${status}`);
  try {
    const msg = await browser.messages.get(messageId);
    if (!msg) {
      logDebug(`Message ${messageId} not found for tagging.`);
      return;
    }

    let currentTags = msg.tags || [];
    logDebug(`Pre-existing tags: ${JSON.stringify(currentTags)}`);

    // Clean existing tags from our keys
    currentTags = currentTags.filter(t => t !== "czo-verified" && t !== "czo-failed");

    if (status === "success") {
      // Success tag czo-verified
      currentTags.push("czo-verified");
      logDebug(`Appending tag czo-verified.`);
    } else {
      // Failure tag czo-failed
      currentTags.push("czo-failed");
      logDebug(`Appending tag czo-failed.`);
    }

    // Attempt to merge tags using update
    await browser.messages.update(messageId, { tags: currentTags });
    logDebug(`Successfully updated tags: ${JSON.stringify(currentTags)}`);
  } catch (err) {
    logDebug(`Error updating message tags: ${err.message}. Trying fallback.`);
    // Fallback tag update logic if update fails (some environments might use message.update)
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

// Silent automatic download handler
async function handleSilentDownload(requestId, downloadButtonId) {
  const taskInfo = verificationTasks[requestId];
  if (!taskInfo) return;

  const options = await getOptions();
  logDebug(`[${taskInfo.candidate.label}] Requesting silent download from content script. Subfolder: "${options.subfolder}"`);

  // We ask the tab to click the specific download button and download.
  // Wait, the specification says:
  // "If the CZO page provides a verification receipt or file, it must be downloaded automatically without displaying the system "Save As" file picker dialog"
  // If we download via the extension downloads API, how do we get the URL?
  // The content script can fetch the blob URL and send it to us, and we download it!
  // Yes! The content script can extract the blob URL or object URL from the download button, and send it to the background script,
  // then background.js can use browser.downloads.download() with that blob URL!
  // This is extremely robust and completely avoids any "Save As" prompt!
}

// Download a blob URL safely
async function downloadBlobUrl(requestId, blobUrl, filename) {
  const taskInfo = verificationTasks[requestId];
  if (!taskInfo) return;

  try {
    const options = await getOptions();
    let folder = options.subfolder || "CZO-Verify-Results";
    // clean folder slashes
    folder = folder.replace(/[\\\/]+/g, "/").replace(/^\/|\/$/g, "");

    const targetFilename = folder ? `${folder}/${filename}` : filename;
    logDebug(`[${taskInfo.candidate.label}] Triggering browser.downloads.download for url: ${blobUrl.substring(0, 100)}... to filename: ${targetFilename}`);

    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename: targetFilename,
      saveAs: options.askWhereToSave,
      conflictAction: "uniquify"
    });

    logDebug(`[${taskInfo.candidate.label}] Download started. Download ID: ${downloadId}`);

    // Track last downloaded
    lastSavedResult = {
      downloadId,
      filename,
      filepath: targetFilename,
      timestamp: Date.now(),
      status: "downloading"
    };

    if (taskInfo.result) {
      taskInfo.result.savedResult = lastSavedResult;
    }

    updatePopupProgress();
  } catch (err) {
    logDebug(`[${taskInfo.candidate.label}] Download failed: ${err.message}`);
  }
}

// Listen to download completions
browser.downloads.onChanged.addListener((delta) => {
  if (lastSavedResult && delta.id === lastSavedResult.downloadId) {
    if (delta.state) {
      lastSavedResult.status = delta.state.current;
      logDebug(`Download ID ${delta.id} state changed to ${delta.state.current}`);
      if (delta.state.current === "complete") {
        lastSavedResult.completedTimestamp = Date.now();
      }
      updatePopupProgress();
    }
  }
});

// Orchestrate overall verification runs
async function runAllVerifications(candidateIds, messageId) {
  logDebug(`Requested verification for candidates: ${JSON.stringify(candidateIds)}`);

  // We need current candidates list
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

  // Monitor verification state to determine final tags
  // Wait, let's periodically poll or check if all requestIds are resolved.
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
        // success
      } else {
        // unknown or anything else is treated as not perfectly success
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
  logDebug(`Message received: action = ${request.action}`);

  if (request.action === "getLogs") {
    sendResponse({ logs: diagnosticsLogs });
    return true;
  }
  else if (request.action === "clearLogs") {
    diagnosticsLogs = [];
    sendResponse({ success: true });
    return true;
  }
  else if (request.action === "scan") {
    scanActiveMessage().then(sendResponse);
    return true; // Keep message channel open for async response
  }
  else if (request.action === "verifySelected") {
    runAllVerifications(request.candidateIds, request.messageId).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  else if (request.action === "getTasks") {
    sendResponse({ tasks: verificationTasks, lastSavedResult });
    return true;
  }
  else if (request.action === "getLastSavedResult") {
    sendResponse({ lastSavedResult });
    return true;
  }

  // --- Content Script Interaction ---
  else if (request.action === "widgetReady") {
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
  }

  else if (request.action === "reportProgress") {
    const { requestId, progress } = request;
    if (verificationTasks[requestId]) {
      verificationTasks[requestId].progress = progress;
      logDebug(`[${verificationTasks[requestId].candidate.label}] Progress: ${progress}`);
      updatePopupProgress();
    }
  }

  else if (request.action === "reportResult") {
    const { requestId, status, resultText, errorText, receiptBlobUrl, receiptFilename } = request;
    logDebug(`[verification result] for request ${requestId}. status: ${status}`);

    if (verificationTasks[requestId]) {
      const task = verificationTasks[requestId];
      task.status = status;
      task.progress = status === "ok" ? "Verification Completed Successfully" : "Verification Failed";
      task.result = {
        scenario: task.candidate.scenario,
        status,
        resultText,
        errorText,
        savedResult: null
      };

      // Clear safety timeout
      if (task.timeoutId) {
        clearTimeout(task.timeoutId);
      }

      // Automatically download receipt if provided
      if (receiptBlobUrl && receiptFilename) {
        downloadBlobUrl(requestId, receiptBlobUrl, receiptFilename);
      }

      // Close background tab after a short delay
      setTimeout(async () => {
        try {
          if (task.tabId) {
            logDebug(`Closing background tab ID ${task.tabId}`);
            await browser.tabs.remove(task.tabId);
          }
        } catch (e) {
          logDebug(`Error closing tab: ${e.message}`);
        }
      }, 5000);

      updatePopupProgress();
    }
    sendResponse({ success: true });
  }

  else if (request.action === "downloadReceipt") {
    const { requestId, blobUrl, filename } = request;
    downloadBlobUrl(requestId, blobUrl, filename);
    sendResponse({ success: true });
  }
});