// options.js - handles loading and saving extension settings to storage.local
const form = document.getElementById("settings-form");
const subfolderInput = document.getElementById("subfolder");
const askWhereToSaveInput = document.getElementById("askWhereToSave");
const verboseInput = document.getElementById("verbose");
const statusDiv = document.getElementById("status");

// Load saved options on open
async function loadOptions() {
  try {
    const res = await browser.storage.local.get({
      subfolder: "CZO-Verify-Results",
      askWhereToSave: false,
      verbose: false
    });

    subfolderInput.value = res.subfolder;
    askWhereToSaveInput.checked = res.askWhereToSave;
    verboseInput.checked = res.verbose;
  } catch (err) {
    console.error("Error loading options:", err);
  }
}

// Save options on form submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const subfolder = subfolderInput.value.trim() || "CZO-Verify-Results";
  const askWhereToSave = askWhereToSaveInput.checked;
  const verbose = verboseInput.checked;

  try {
    await browser.storage.local.set({
      subfolder,
      askWhereToSave,
      verbose
    });

    // Display status banner
    statusDiv.style.display = "block";
    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 2000);
  } catch (err) {
    console.error("Error saving options:", err);
  }
});

// Load options initially
document.addEventListener("DOMContentLoaded", loadOptions);
