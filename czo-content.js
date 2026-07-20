// czo-content.js - DOM interaction, file injection, verification trigger, and result parsing

let contentRequestId = null;
let injectionTriggered = false;
let resultPollingCount = 0;
const maxResultPollingCount = 60;
let signInfoFoundTicks = 0;
let readyChecked = false;

function logToBackground(progress) {
  if (contentRequestId) {
    browser.runtime.sendMessage({
      action: "reportProgress",
      requestId: contentRequestId,
      progress
    }).catch(() => {});
  }
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function base64ToBytes(base64) {
  return base64ToUint8Array(base64);
}

function getExtensionMimeType(ext) {
  switch ((ext || "").toLowerCase()) {
    case "pdf": return "application/pdf";
    case "xml": return "text/xml";
    case "p7s": return "application/pkcs7-signature";
    case "asics":
    case "asice": return "application/zip";
    case "zip": return "application/zip";
    default: return "";
  }
}

function getSecureMimeType(filename, bytes) {
  let mime = "";

  try {
    if (bytes && bytes.length >= 2) {
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
      } else if (hex.startsWith("25504446")) {
        mime = "application/pdf";
      } else if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) {
        mime = "image/gif";
      } else if (hex.startsWith("504B0304")) {
        const ext = filename.toLowerCase().split(".").pop();
        if (ext === "asics" || ext === "asice" || ext === "zip") {
          mime = "application/zip";
        } else {
          mime = getExtensionMimeType(ext);
        }
      } else if (hex.startsWith("7F454C46")) {
        mime = "application/x-elf";
      } else if (hex.startsWith("4D5A")) {
        mime = "application/x-msdownload";
      } else if (hex.startsWith("3C3F786D6C")) {
        mime = "text/xml";
      } else if (hex.startsWith("3082") || hex.startsWith("3080")) {
        mime = "application/pkcs7-signature";
      }
    }
  } catch (err) {
    console.warn("Failed to read magic bytes, falling back to extension lookup:", err.message);
  }

  if (!mime) {
    const ext = filename.toLowerCase().split(".").pop();
    mime = getExtensionMimeType(ext);
  }

  return mime || "application/octet-stream";
}

function toBase64(uint8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function makeFile(fileInfo) {
  const b64 = fileInfo.base64 || fileInfo.content;
  const bytes = base64ToBytes(b64);
  const mimeType = fileInfo.mime || fileInfo.type || getSecureMimeType(fileInfo.name, bytes);
  return new File([bytes], fileInfo.name, { type: mimeType });
}

function setFilesOnInput(input, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return dt;
}

function buildFileObjects(filesData) {
  return filesData.map(makeFile);
}

function injectFiles(files) {
  try {
    const input =
      document.querySelector("#chooseFilesInput") ||
      document.querySelector("input[type=file]");

    const dropZone =
      document.querySelector("#filesDropZone") ||
      document.querySelector(".drop-zone") ||
      document.querySelector(".dropzone");

    if (!input) {
      logToBackground("CZO Input element not found in DOM.");
      return false;
    }

    logToBackground("Injecting files into DOM input element...");
    const dataTransfer = setFilesOnInput(input, files);
    logToBackground("Standard file input change and input events dispatched.");

    try {
      Object.defineProperty(dataTransfer, "dropEffect", {
        value: "copy",
        writable: true,
        configurable: true,
        enumerable: true
      });
      Object.defineProperty(dataTransfer, "effectAllowed", {
        value: "copy",
        writable: true,
        configurable: true,
        enumerable: true
      });
      Object.defineProperty(dataTransfer, "types", {
        value: ["Files"],
        writable: true,
        configurable: true,
        enumerable: true
      });
    } catch (e) {
      console.warn("Failed to set DataTransfer properties:", e.message);
    }

    if (dropZone && dropZone.dropzone) {
      logToBackground("Direct Dropzone instance detected. Calling addFile...");
      for (const file of files) {
        dropZone.dropzone.addFile(file);
      }
      return true;
    }

    const container =
      document.querySelector("main > section.form-block > div.container-fluid") ||
      document.querySelector(".container-fluid") ||
      document.querySelector("#filesDropZone") ||
      document.querySelector(".drop-zone") ||
      dropZone;

    if (container && dataTransfer) {
      logToBackground("Simulating drag & drop sequence on container...");

      const dragEnterEvent = new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperty(dragEnterEvent, "dataTransfer", {
        value: dataTransfer,
        writable: false,
        configurable: true,
        enumerable: true
      });
      container.dispatchEvent(dragEnterEvent);

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
      container.dispatchEvent(dragOverEvent);

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
      container.dispatchEvent(dropEvent);

      logToBackground("Dragover and Drop events simulated with defined dataTransfer on container.");
    }

    return true;
  } catch (err) {
    logToBackground(`File injection error: ${err.message}`);
    return false;
  }
}

function getVerifyButton() {
  return (
    document.querySelector("#checkButton") ||
    document.querySelector("button.verify-btn") ||
    document.querySelector("button#checkButton")
  );
}

function getInputElement() {
  return (
    document.querySelector("#chooseFilesInput") ||
    document.querySelector("input[type=file]")
  );
}

function getDropZone() {
  return (
    document.querySelector("#filesDropZone") ||
    document.querySelector(".drop-zone") ||
    document.querySelector(".dropzone")
  );
}

function pollForWidgetReady() {
  if (readyChecked) return;

  const input = getInputElement();
  const dropZone = getDropZone();
  const checkBtn = getVerifyButton();

  if (input && dropZone && checkBtn) {
    readyChecked = true;
    console.log("[CZO Verifier] Widget loaded in DOM.");
    browser.runtime.sendMessage({ action: "widgetReady" }).catch(() => {});
  } else {
    setTimeout(pollForWidgetReady, 1000);
  }
}

async function waitFor(conditionFn, timeout = 4000, interval = 100) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (conditionFn()) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error("Timeout waiting for condition");
}

function resetResultPollingState() {
  resultPollingCount = 0;
  signInfoFoundTicks = 0;
}

async function handleInjectAndVerify(payload) {
  contentRequestId = payload.requestId || contentRequestId;
  resetResultPollingState();

  logToBackground("Commencing verification sequence.");
  console.log("[CZO Verifier] Starting verification sequence for payload.");

  const input = getInputElement();
  const dropZone = getDropZone();
  const checkBtn = getVerifyButton();

  if (!input || !checkBtn) {
    logToBackground("CZO Input or Verify elements disappeared from DOM.");
    reportOutcome("error", "", "CZO target elements not found in DOM.");
    return;
  }

  logToBackground("Waiting 7 seconds before file injection...");
  await new Promise(resolve => setTimeout(resolve, 7000));

  const preparedFiles = buildFileObjects(payload.files || []);
  const injected = injectFiles(preparedFiles);

  if (!injected) {
    reportOutcome("error", "", "Failed to inject files into CZO input.");
    return;
  }

  logToBackground("Awaiting DOM acknowledgement of uploaded files...");

  const isFileStateReady = () => {
    if (input && input.files && input.files.length > 0) return true;

    if (dropZone) {
      if (dropZone.classList.contains("dz-started")) return true;
      if (dropZone.querySelectorAll(".dz-preview, .file-preview, .uploaded-file, .file-item").length > 0) {
        return true;
      }

      const dropZoneText = dropZone.innerText || "";
      for (const f of preparedFiles) {
        if (dropZoneText.includes(f.name)) {
          return true;
        }
      }
    }

    const bodyText = document.body.innerText || "";
    let foundAll = true;
    for (const f of preparedFiles) {
      if (!bodyText.includes(f.name)) {
        foundAll = false;
        break;
      }
    }
    if (foundAll) return true;

    return false;
  };

  try {
    try {
      await waitFor(isFileStateReady, 10000, 200);
      logToBackground("File state is ready on CZO widget.");
    } catch (waitErr) {
      logToBackground("Error: File state not fully acknowledged in DOM within timeout. Aborting verification.");
      reportOutcome("error", "", "Failed to upload files: Dropzone did not acknowledge files within 10 seconds.");
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    logToBackground("Triggering programmatic click on Verify button...");
    checkBtn.click();
    logToBackground("Verify ('РџРµСЂРµРІС–СЂРёС‚Рё') button clicked.");

    pollForVerificationResults();
  } catch (clickErr) {
    logToBackground(`Failed to trigger Verify click: ${clickErr.message}`);
    reportOutcome("error", "", `Failed to click Verify: ${clickErr.message}`);
  }
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getElementText(el) {
  return ((el?.innerText || el?.textContent || "") + "").trim();
}

function getElementDebugInfo(el, index = null) {
  const text = getElementText(el);
  const href = el.getAttribute ? (el.getAttribute("href") || "") : "";
  const download = el.getAttribute ? (el.getAttribute("download") || "") : "";
  const id = el.id || "";
  const cls = (el.className || "").toString();
  const tag = el.tagName || "";
  const visible = isVisibleElement(el);
  const disabled = !!(el.disabled || el.getAttribute?.("aria-disabled") === "true");

  return {
    index,
    tag,
    id,
    className: cls,
    text,
    href,
    download,
    visible,
    disabled
  };
}

function formatElementDebugInfo(info) {
  return [
    `#${info.index}`,
    `tag=${info.tag || "-"}`,
    `id=${info.id || "-"}`,
    `class=${info.className || "-"}`,
    `visible=${info.visible}`,
    `disabled=${info.disabled}`,
    `text="${(info.text || "").replace(/\s+/g, " ").slice(0, 200)}"`,
    `href="${(info.href || "").slice(0, 200)}"`,
    `download="${(info.download || "").slice(0, 200)}"`
  ].join(" | ");
}

function findArchiveDownloadButton(downloadButtonId = null) {
  if (downloadButtonId) {
    const byId = document.getElementById(downloadButtonId);
    if (byId) {
      const label = byId.querySelector("label.i18n");
      const labelText = getElementText(label || byId);
      const info = getElementDebugInfo(byId, 0);

      logToBackground(`[findArchiveDownloadButton] Explicit id candidate: ${formatElementDebugInfo(info)}`);
      logToBackground(`[findArchiveDownloadButton] Explicit id candidate label text: "${labelText}"`);

      if (
        byId.id === "saveAllButton" &&
        label &&
        labelText.trim() === "Р—Р°РІР°РЅС‚Р°Р¶РёС‚Рё РІСЃРµ Р°СЂС…С–РІРѕРј"
      ) {
        logToBackground(`[findArchiveDownloadButton] Explicit id matched exact saveAllButton.`);
        return byId;
      }

      logToBackground(`[findArchiveDownloadButton] Explicit id exists but is not the required saveAllButton.`);
    } else {
      logToBackground(`[findArchiveDownloadButton] Explicit button id "${downloadButtonId}" not found in DOM.`);
    }
  }

  const exactButton = document.querySelector("div#saveAllButton.Block");
  if (exactButton) {
    const label = exactButton.querySelector("label.i18n");
    const labelText = getElementText(label || exactButton);
    const info = getElementDebugInfo(exactButton, 1);

    logToBackground(`[findArchiveDownloadButton] Exact selector candidate: ${formatElementDebugInfo(info)}`);
    logToBackground(`[findArchiveDownloadButton] Exact selector label text: "${labelText}"`);

    if (label && labelText.trim() === "Р—Р°РІР°РЅС‚Р°Р¶РёС‚Рё РІСЃРµ Р°СЂС…С–РІРѕРј") {
      logToBackground(`[findArchiveDownloadButton] Selected exact saveAllButton with exact label match.`);
      return exactButton;
    }

    logToBackground(`[findArchiveDownloadButton] saveAllButton found, but label does not match required text.`);
  } else {
    logToBackground(`[findArchiveDownloadButton] Exact selector div#saveAllButton.Block not found.`);
  }

  const allCandidates = Array.from(document.querySelectorAll("div.Block, button, a, [role='button']"));
  logToBackground(`[findArchiveDownloadButton] Debug candidates count: ${allCandidates.length}`);

  allCandidates.forEach((el, index) => {
    const info = getElementDebugInfo(el, index + 1);
    logToBackground(`[findArchiveDownloadButton] Debug candidate ${formatElementDebugInfo(info)}`);
  });

  logToBackground(`[findArchiveDownloadButton] Required archive button was not found.`);
  return null;
}

async function handleClickArchiveDownload(message) {
  contentRequestId = message.requestId || contentRequestId;

  try {
    const button = findArchiveDownloadButton(message.downloadButtonId || null);

    if (!button) {
      const err = 'Button "Р—Р°РІР°РЅС‚Р°Р¶РёС‚Рё РІСЃРµ Р°СЂС…С–РІРѕРј" not found';
      logToBackground(err);
      await browser.runtime.sendMessage({
        action: "archiveDownloadClickFailed",
        requestId: contentRequestId,
        error: err
      });
      return;
    }

    button.scrollIntoView({ block: "center", behavior: "instant" });

    try {
      button.focus({ preventScroll: true });
    } catch (e) {}

    logToBackground(`Clicking archive download control: "${getElementText(button) || button.id || button.tagName}"`);
    button.click();

    await browser.runtime.sendMessage({
      action: "archiveDownloadClickDone",
      requestId: contentRequestId
    });
  } catch (err) {
    logToBackground(`Archive click error: ${err.message}`);
    await browser.runtime.sendMessage({
      action: "archiveDownloadClickFailed",
      requestId: contentRequestId,
      error: err.message
    }).catch(() => {});
  }
}

function collectErrorText() {
  const errorElements = document.querySelectorAll(
    ".error, .alert-danger, .alert-error, .text-danger, .invalid-feedback, .error-message, .error-text"
  );

  let errorText = "";
  if (errorElements && errorElements.length > 0) {
    for (const el of errorElements) {
      const text = getElementText(el);
      if (text && text.length > 3) {
        errorText += text + "\n";
      }
    }
  }
  return errorText.trim();
}

function containsStrongErrorSignal(textLower, errorText) {
  if (errorText) return true;

  const errorPhrases = [
    "РЅРµРІС–СЂРЅРёР№",
    "РїРѕРјРёР»РєР°",
    "РЅРµ РїС–РґС‚СЂРёРјСѓС”С‚СЊСЃСЏ",
    "РїРѕРјРёР»РєР° Р·С‡РёС‚СѓРІР°РЅРЅСЏ",
    "РЅРµ РјС–СЃС‚РёС‚СЊ",
    "РЅРµ Р·РЅР°Р№РґРµРЅРѕ",
    "РІС–РґСЃСѓС‚РЅС–",
    "РІС–РґСЃСѓС‚РЅС–Р№",
    "РЅРµРјР°С”",
    "invalid",
    "error"
  ];

  return errorPhrases.some(kw => textLower.includes(kw));
}

function getResultBlock() {
  return (
    document.querySelector("#signInfo") ||
    document.querySelector(".sign-info") ||
    document.querySelector(".results-block")
  );
}

function pollForVerificationResults() {
  resultPollingCount++;
  logToBackground(`Polling for CZO results (tick ${resultPollingCount}/${maxResultPollingCount})...`);

  const reportBtn =
    document.querySelector("#saveReportFileButton") ||
    document.querySelector("a[id*='Report']") ||
    document.querySelector("button[id*='Report']");

  const signInfoBlock = getResultBlock();
  const errorText = collectErrorText();
  const widgetText = document.body.innerText || "";
  const lowercaseText = widgetText.toLowerCase();

  if (containsStrongErrorSignal(lowercaseText, errorText) && !signInfoBlock && !reportBtn) {
    logToBackground("Error indicator detected in DOM text.");
    const fullErrorMsg = errorText || "CZO reported an error during validation.";
    reportOutcome("error", "", fullErrorMsg);
    return;
  }

  if (signInfoBlock || reportBtn) {
    const resultText = signInfoBlock
      ? getElementText(signInfoBlock)
      : "Qualified Electronic Signature successfully verified by CZO.";

    const archiveButton = findArchiveDownloadButton();

    if (!archiveButton && signInfoBlock && signInfoFoundTicks < 5 && resultPollingCount < maxResultPollingCount) {
      signInfoFoundTicks++;
      logToBackground(`Verification block found. Waiting for archive download button to appear (tick ${signInfoFoundTicks}/5)...`);
      setTimeout(pollForVerificationResults, 1000);
      return;
    }

    let fallbackBlobUrl = null;
    let fallbackFilename = "verification-receipt.zip";

    if (archiveButton) {
      const href = archiveButton.getAttribute("href");
      const downloadAttr = archiveButton.getAttribute("download");

      if (href) {
        try {
          fallbackBlobUrl = new URL(href, window.location.href).href;
        } catch (e) {}
      }

      if (downloadAttr) {
        fallbackFilename = downloadAttr;
      } else if (href) {
        const lastPart = href.split("/").pop();
        if (lastPart) fallbackFilename = lastPart;
      }
    }

    logToBackground("Verification result found in DOM.");

    reportOutcome(
      "ok",
      resultText,
      "",
      fallbackBlobUrl,
      fallbackFilename,
      true,
      archiveButton ? (archiveButton.id || null) : null
    );
    return;
  }

  if (resultPollingCount >= maxResultPollingCount) {
    logToBackground("Reached maximum results polling duration. Checking if partial results exist.");
    if (widgetText.includes("РџС–РґРїРёСЃ") || widgetText.includes("РџСЂРѕС‚РѕРєРѕР»")) {
      reportOutcome("ok", "Verification completed with partial results.", "", null, "", false, null);
    } else {
      reportOutcome("unknown", "", "CZO portal is taking too long to respond. Automated timeout.", null, "", false, null);
    }
    return;
  }

  setTimeout(pollForVerificationResults, 1000);
}

function reportOutcome(
  status,
  resultText = "",
  errorText = "",
  receiptBlobUrl = null,
  receiptFilename = "",
  autoDownloadArchive = false,
  downloadButtonId = null
) {
  logToBackground(`Final outcome classified: Status = ${status}`);
  browser.runtime.sendMessage({
    action: "reportResult",
    requestId: contentRequestId,
    status,
    resultText,
    errorText,
    receiptBlobUrl,
    receiptFilename,
    autoDownloadArchive,
    downloadButtonId
  }).catch(() => {});
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "czo-inject-and-verify") {
    handleInjectAndVerify(message.payload);
    sendResponse?.({ success: true });
    return true;
  }

  if (message.action === "injectFiles") {
    if (contentRequestId === message.requestId && injectionTriggered) {
      console.log("[CZO Verifier] Idempotency Guard triggered. Duplicated injectFiles request ignored.");
      sendResponse?.({ success: true, ignored: true });
      return true;
    }

    contentRequestId = message.requestId;
    injectionTriggered = true;

    logToBackground("Received files from background script.");
    handleInjectAndVerify({
      requestId: message.requestId,
      files: message.files
    });

    sendResponse?.({ success: true });
    return true;
  }

  if (message.action === "clickArchiveDownload") {
    handleClickArchiveDownload(message);
    sendResponse?.({ success: true });
    return true;
  }

  return false;
});

if (window.location.host.includes("czo.gov.ua") || window.location.host.includes("id.gov.ua")) {
  console.log("[CZO Verifier] content script loaded on page: " + window.location.href);
  pollForWidgetReady();
}
