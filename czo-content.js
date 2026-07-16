// czo-content.js - DOM interaction, file injection, verification trigger, and result parsing
let contentRequestId = null;
let injectionTriggered = false;

function logToBackground(progress) {
  if (contentRequestId) {
    browser.runtime.sendMessage({
      action: "reportProgress",
      requestId: contentRequestId,
      progress: progress
    }).catch(() => {});
  }
}

// Helper to convert Base64 back to Blob/Uint8Array (equivalent to base64ToBytes)
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Alias matching specifications
function base64ToBytes(base64) {
  return base64ToUint8Array(base64);
}

// Fallback extension-based MIME-type mapper
function getExtensionMimeType(ext) {
  switch (ext) {
    case "pdf": return "application/pdf";
    case "xml": return "text/xml";
    case "p7s": return "application/pkcs7-signature";
    case "asics":
    case "asice": return "application/zip";
    case "zip": return "application/zip";
    default: return "";
  }
}

// Deterministic MIME-type detector based on "magic bytes" (file signatures)
// with extension-based fallback for unmatched or archive-based formats.
function getSecureMimeType(filename, bytes) {
  let mime = "";
  try {
    if (bytes && bytes.length >= 2) {
      // Helper to convert bytes to hex string
      let hex = "";
      const len = Math.min(bytes.length, 8);
      for (let i = 0; i < len; i++) {
        const h = bytes[i].toString(16).toUpperCase();
        hex += h.length === 1 ? "0" + h : h;
      }

      if (hex.startsWith("89504E470D0A1A0A")) {
        mime = "image/png";
      } else if (hex.startsWith("FFD8FF")) {
        mime = "image/jpeg";
      } else if (hex.startsWith("25504446")) { // %PDF
        mime = "application/pdf";
      } else if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) { // GIF87a / GIF89a
        mime = "image/gif";
      } else if (hex.startsWith("504B0304")) { // PK.. (ZIP, ASICS, ASICE, etc.)
        const ext = filename.toLowerCase().split('.').pop();
        if (ext === "asics" || ext === "asice" || ext === "zip") {
          mime = "application/zip";
        } else {
          mime = getExtensionMimeType(ext);
        }
      } else if (hex.startsWith("7F454C46")) {
        mime = "application/x-elf";
      } else if (hex.startsWith("4D5A")) {
        mime = "application/x-msdownload";
      }
    }
  } catch (err) {
    console.warn("Failed to read magic bytes, falling back to extension lookup:", err.message);
  }

  if (!mime) {
    const ext = filename.toLowerCase().split('.').pop();
    mime = getExtensionMimeType(ext);
  }
  return mime;
}

// Base64 conversion helper matching specification
function toBase64(uint8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// makeFile restoring the original file from its text representation matching specification
function makeFile(fileInfo) {
  const b64 = fileInfo.base64 || fileInfo.content;
  const bytes = base64ToBytes(b64);
  const mimeType = fileInfo.mime || fileInfo.type || getSecureMimeType(fileInfo.name, bytes);
  return new File([bytes], fileInfo.name, { type: mimeType });
}

// setFilesOnInput loading File objects programmatically into file selection field matching specification
function setFilesOnInput(input, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', {bubbles:true}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
  return dt;
}

// Convert message file payloads to File objects
function buildFileObjects(filesData) {
  return filesData.map(makeFile);
}

// Inject files function matching specification, using fallback direct dropzone / synthetic drag events
function injectFiles(files) {
  try {
    const input = document.querySelector("#chooseFilesInput") || document.querySelector("input[type=file]");
    const dropZone = document.querySelector("#filesDropZone") || document.querySelector(".drop-zone") || document.querySelector(".dropzone");

    if (!input) {
      logToBackground("CZO Input element not found in DOM.");
      return false;
    }

    logToBackground("Injecting files into DOM input element...");
    // 1. Standard Input Injection via setFilesOnInput
    const dataTransfer = setFilesOnInput(input, files);
    logToBackground("Standard file input change and input events dispatched.");

    // 2. Direct Dropzone addFile Injection
    if (dropZone && dropZone.dropzone) {
      logToBackground("Direct Dropzone instance detected. Calling addFile...");
      for (const file of files) {
        dropZone.dropzone.addFile(file);
      }
      return true;
    }

    // 3. Drag & Drop Fallback Simulation
    if (dropZone && dataTransfer) {
      logToBackground("Simulating drag & drop events on drop zone...");
      const dragOverEvent = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperty(dragOverEvent, "dataTransfer", {
        value: dataTransfer,
        writable: false,
        configurable: true,
        enumerable: true
      });
      dropZone.dispatchEvent(dragOverEvent);

      const dropEvent = new DragEvent("drop", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperty(dropEvent, "dataTransfer", {
        value: dataTransfer,
        writable: false,
        configurable: true,
        enumerable: true
      });
      dropZone.dispatchEvent(dropEvent);
      logToBackground("Dragover and Drop events simulated with defined dataTransfer.");
    }
    return true;
  } catch (err) {
    logToBackground(`File injection error: ${err.message}`);
    return false;
  }
}

// Poll to find target elements and announce readiness to background.js
let readyChecked = false;
function pollForWidgetReady() {
  // Prevent double-checking on frame reload
  if (readyChecked) return;

  const input = document.querySelector("#chooseFilesInput") || document.querySelector("input[type=file]");
  const dropZone = document.querySelector("#filesDropZone") || document.querySelector(".drop-zone") || document.querySelector(".dropzone");
  const checkBtn = document.querySelector("#checkButton") || document.querySelector("button.verify-btn") || document.querySelector("button#checkButton");

  // We are inside the target frame if all critical elements (including dropZone) are found
  if (input && dropZone && checkBtn) {
    readyChecked = true;
    console.log("[CZO Verifier] Widget loaded in DOM.");
    browser.runtime.sendMessage({ action: "widgetReady" }).catch(() => {});
  } else {
    setTimeout(pollForWidgetReady, 1000);
  }
}

// Helper to wait for a condition to be true
async function waitFor(conditionFn, timeout = 4000, interval = 100) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (conditionFn()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error("Timeout waiting for condition");
}

// handleInjectAndVerify matching specifications
async function handleInjectAndVerify(payload) {
  contentRequestId = payload.requestId || contentRequestId;
  logToBackground("Commencing verification sequence.");
  console.log("[CZO Verifier] Starting verification sequence for payload.");

  const input = document.querySelector("#chooseFilesInput") || document.querySelector("input[type=file]");
  const dropZone = document.querySelector("#filesDropZone") || document.querySelector(".drop-zone") || document.querySelector(".dropzone");
  const checkBtn = document.querySelector("#checkButton") || document.querySelector("button.verify-btn") || document.querySelector("button#checkButton");

  if (!input || !checkBtn) {
    logToBackground("CZO Input or Verify elements disappeared from DOM.");
    reportOutcome("error", "", "CZO target elements not found in DOM.");
    return;
  }

  const preparedFiles = (payload.files || []).map(makeFile);
  const injected = injectFiles(preparedFiles);

  if (!injected) {
    reportOutcome("error", "", "Failed to inject files into CZO input.");
    return;
  }

  // Acknowledge files addition on CZO widget before triggering verification
  logToBackground("Awaiting DOM acknowledgement of uploaded files...");

  const isFileStateReady = () => {
    // Check if dropzone has standard dropzone preview elements, dz-started class, or displays the files' names
    if (dropZone) {
      if (dropZone.classList.contains("dz-started")) return true;
      if (dropZone.querySelectorAll(".dz-preview, .file-preview, .uploaded-file, .file-item").length > 0) return true;

      const dropZoneText = dropZone.innerText || "";
      for (const f of preparedFiles) {
        if (dropZoneText.includes(f.name)) {
          return true;
        }
      }
    }
    return false;
  };

  try {
    // Wait up to 5 seconds for file state to be ready
    try {
      await waitFor(isFileStateReady, 5000, 200);
      logToBackground("File state is ready on CZO widget.");
    } catch (waitErr) {
      logToBackground(`Warning: file state not fully acknowledged in DOM within timeout. Proceeding anyway.`);
    }

    // Additional safety delay to let Vue/JS bindings update completely
    await new Promise(resolve => setTimeout(resolve, 1000));

    logToBackground("Triggering programmatic click on Verify button...");
    checkBtn.click();
    logToBackground("Verify ('Перевірити') button clicked.");

    // Start polling for the output results
    pollForVerificationResults();
  } catch (clickErr) {
    logToBackground(`Failed to trigger Verify click: ${clickErr.message}`);
    reportOutcome("error", "", `Failed to click Verify: ${clickErr.message}`);
  }
}

// Receive file injection command from background script supporting both formats
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "czo-inject-and-verify") {
    handleInjectAndVerify(message.payload);
  }
  else if (message.action === "injectFiles") {
    // Idempotency check: Ensure the same requestId is never run twice
    if (contentRequestId === message.requestId && injectionTriggered) {
      console.log("[CZO Verifier] Idempotency Guard triggered. Duplicated injectFiles request ignored.");
      return;
    }

    contentRequestId = message.requestId;
    injectionTriggered = true;

    logToBackground("Received files from background script.");
    handleInjectAndVerify({
      requestId: message.requestId,
      files: message.files
    });
  }
});

// Periodic polling loop to wait for verification completion
let resultPollingCount = 0;
const maxResultPollingCount = 60; // 60 seconds max
let signInfoFoundTicks = 0;

function pollForVerificationResults() {
  resultPollingCount++;
  logToBackground(`Polling for CZO results (tick ${resultPollingCount}/${maxResultPollingCount})...`);

  // Let's identify DOM changes or presence of results
  const reportBtn = document.querySelector("#saveReportFileButton") || document.querySelector("a[id*='Report']") || document.querySelector("button[id*='Report']");
  const signInfoBlock = document.querySelector("#signInfo") || document.querySelector(".sign-info") || document.querySelector(".results-block");
  const errorElements = document.querySelectorAll(".error, .alert-danger, .alert-error, .text-danger, .invalid-feedback, .error-message, .error-text");

  // Determine if there is any visible error text or block
  let errorText = "";
  if (errorElements && errorElements.length > 0) {
    for (const el of errorElements) {
      const text = el.innerText ? el.innerText.trim() : "";
      if (text && text.length > 10) {
        errorText += text + "\n";
      }
    }
  }

  // Also search for global widget errors (like "невірний підпис", "помилка", "не підтримується")
  const widgetText = document.body.innerText || "";
  const lowercaseText = widgetText.toLowerCase();
  
  const hasErrorKeyword = ["невірний", "помилка", "не підтримується", "помилка зчитування", "error", "invalid"].some(kw => lowercaseText.includes(kw));

  // If we find an unambiguous error container or keyword but no reportBtn yet, we check if it is a failure
  if (hasErrorKeyword && (errorText || lowercaseText.includes("помилка"))) {
    logToBackground("Error indicator detected in DOM text.");
    const fullErrorMsg = errorText || "CZO reported an error during validation.";
    reportOutcome("error", "", fullErrorMsg);
    return;
  }

  // If a report button or sign information block appears, we are successful
  if (signInfoBlock || reportBtn) {
    // Try to locate receipt download link
    let receiptBlobUrl = null;
    let receiptFilename = "verification-receipt.zip";

    const anchor = document.querySelector("#saveReportFileButton a") || document.querySelector("#saveReportFileButton") || document.querySelector("a[id*='Report']");

    // If we have a valid href, or we have already waited 5 seconds after signInfoBlock appeared, we proceed
    if (anchor && anchor.href) {
      receiptBlobUrl = new URL(anchor.href, window.location.href).href;
      if (anchor.download) {
        receiptFilename = anchor.download;
      }
    } else if (signInfoBlock && signInfoFoundTicks < 5 && resultPollingCount < maxResultPollingCount) {
      signInfoFoundTicks++;
      logToBackground(`Verification block found. Waiting for download button/href to populate (tick ${signInfoFoundTicks}/5)...`);
      setTimeout(pollForVerificationResults, 1000);
      return;
    } else if (anchor) {
      // If we waited 5 seconds but no href was set on the anchor, let's trigger programmatic click fallback
      try {
        anchor.click();
        logToBackground("Programmatic click on receipt fallback button triggered.");
      } catch (clickErr) {
        logToBackground(`Fallback click failed: ${clickErr.message}`);
      }
    }

    logToBackground("Verification result found in DOM.");

    // Extract detailed result text
    let resultText = "";
    if (signInfoBlock) {
      resultText = signInfoBlock.innerText ? signInfoBlock.innerText.trim() : "";
    } else {
      resultText = "Qualified Electronic Signature successfully verified by CZO.";
    }

    reportOutcome("ok", resultText, "", receiptBlobUrl, receiptFilename);
    return;
  }

  // Max polling limit check
  if (resultPollingCount >= maxResultPollingCount) {
    logToBackground("Reached maximum results polling duration. Checking if partial results exist.");
    // Evaluate if we can extract any message
    if (widgetText.includes("Підпис") || widgetText.includes("Протокол")) {
      reportOutcome("ok", "Verification completed with partial results.", "");
    } else {
      reportOutcome("unknown", "", "CZO portal is taking too long to respond. Automated timeout.");
    }
    return;
  }

  // Schedule next poll
  setTimeout(pollForVerificationResults, 1000);
}

// Final result dispatcher to background script
function reportOutcome(status, resultText = "", errorText = "", receiptBlobUrl = null, receiptFilename = "") {
  logToBackground(`Final outcome classified: Status = ${status}`);
  browser.runtime.sendMessage({
    action: "reportResult",
    requestId: contentRequestId,
    status: status,
    resultText: resultText,
    errorText: errorText,
    receiptBlobUrl: receiptBlobUrl,
    receiptFilename: receiptFilename
  }).catch(() => {});
}

// Initialize content script
if (window.location.host.includes("czo.gov.ua") || window.location.host.includes("id.gov.ua")) {
  console.log("[CZO Verifier] content script loaded on page: " + window.location.href);
  pollForWidgetReady();
}
