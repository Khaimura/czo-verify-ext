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

// Helper to convert Base64 back to Blob/Uint8Array
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Standard file mime-type detector based on extension
function getMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "xml": return "text/xml";
    case "p7s": return "";
    case "asics":
    case "asice": return "";
    case "zip": return "application/zip";
    default: return "";
  }
}

// Convert message file payloads to File objects
function buildFileObjects(filesData) {
  return filesData.map(data => {
    const bytes = base64ToUint8Array(data.content);
    const mime = getMimeType(data.name);
    return new File([bytes], data.name, { type: mime });
  });
}

// Inject files using both input.files (DataTransfer) and fallback drag-and-drop
function injectFiles(inputEl, dropZoneEl, files) {
  try {
    logToBackground("Injecting files into DOM input element...");
    const dataTransfer = new DataTransfer();
    for (const file of files) {
      dataTransfer.items.add(file);
    }

    // 1. Standard Input Injection
    inputEl.files = dataTransfer.files;
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    logToBackground("Standard file input change and input events dispatched.");

    // 2. Direct Dropzone addFile Injection
    if (dropZoneEl && dropZoneEl.dropzone) {
      logToBackground("Direct Dropzone instance detected. Calling addFile...");
      for (const file of files) {
        dropZoneEl.dropzone.addFile(file);
      }
      return true;
    }

    // 3. Drag & Drop Fallback Simulation
    if (dropZoneEl) {
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
      dropZoneEl.dispatchEvent(dragOverEvent);

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
      dropZoneEl.dispatchEvent(dropEvent);
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

  // We are inside the target frame if elements are found
  if (input && checkBtn) {
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

// Receive file injection command from background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "injectFiles") {
    // Idempotency check: Ensure the same requestId is never run twice
    if (contentRequestId === message.requestId && injectionTriggered) {
      console.log("[CZO Verifier] Idempotency Guard triggered. Duplicated injectFiles request ignored.");
      return;
    }

    contentRequestId = message.requestId;
    injectionTriggered = true;

    logToBackground("Received files from background script. Commencing verification sequence.");
    console.log("[CZO Verifier] Starting verification sequence for " + message.requestId);

    const input = document.querySelector("#chooseFilesInput") || document.querySelector("input[type=file]");
    const dropZone = document.querySelector("#filesDropZone") || document.querySelector(".drop-zone") || document.querySelector(".dropzone");
    const checkBtn = document.querySelector("#checkButton") || document.querySelector("button.verify-btn") || document.querySelector("button#checkButton");

    if (!input || !checkBtn) {
      logToBackground("CZO Input or Verify elements disappeared from DOM.");
      reportOutcome("error", "", "CZO target elements not found in DOM.");
      return;
    }

    const files = buildFileObjects(message.files);
    const injected = injectFiles(input, dropZone, files);

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
        for (const f of files) {
          if (dropZoneText.includes(f.name)) {
            return true;
          }
        }
      }
      return false;
    };

    const triggerVerification = async () => {
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
    };

    triggerVerification();
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
