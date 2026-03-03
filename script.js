const HEADQUARTERS = [
  { id: "canada", label: "Canada", focus: "Urban mixed-use and civic projects." },
  { id: "uk", label: "UK", focus: "Adaptive reuse and heritage-sensitive design." },
  { id: "emirates", label: "Emirates", focus: "High-density innovation districts and towers." },
  { id: "denmark", label: "Denmark", focus: "Climate-aware coastal and cultural architecture." },
  { id: "usa", label: "USA", focus: "Research-driven sustainable campus architecture." },
  { id: "japan", label: "Japan", focus: "Minimal, compact, and precision-crafted spaces." }
];

const tabsEl = document.getElementById("country-tabs");
const statusEl = document.getElementById("status");
const galleryEl = document.getElementById("gallery");
const docEmbedEl = document.getElementById("doc-embed");
const uploadFilesInputEl = document.getElementById("upload-files");
const uploadFilesBtnEl = document.getElementById("upload-files-btn");
const uploadLinkNameEl = document.getElementById("upload-link-name");
const uploadLinkUrlEl = document.getElementById("upload-link-url");
const uploadLinkBtnEl = document.getElementById("upload-link-btn");
const uploadSpoilerEl = document.getElementById("upload-spoiler");
const UPLOAD_PANEL_PASSWORD = "7516";
let activeCountry = "uk";

function findHeadquarter(country) {
  return HEADQUARTERS.find((hq) => hq.id === country);
}

function displayName(country) {
  const entry = findHeadquarter(country);
  return entry ? entry.label : country.charAt(0).toUpperCase() + country.slice(1).toLowerCase();
}

function createTabs() {
  HEADQUARTERS.forEach((hq) => {
    const button = document.createElement("button");
    button.className = "tab-btn";
    button.type = "button";
    button.dataset.country = hq.id;
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = `<span class="tab-label">${hq.label}</span><span class="tab-meta">${hq.focus}</span>`;
    button.addEventListener("click", () => loadCountry(hq.id));
    tabsEl.appendChild(button);
  });
}

function setActiveTab(country) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.country === country;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function googleDocEmbedUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("docs.google.com")) {
      return null;
    }
    if (parsed.pathname.includes("/document/")) {
      return `${url.replace(/\/edit.*$/, "")}/preview`;
    }
    return url;
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPdfUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function createRenameIconButton(title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-rename-btn";
  button.textContent = "✎";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

async function renameMediaFile(country, oldName, newName) {
  const trimmed = String(newName || "").trim();
  if (!trimmed) {
    statusEl.textContent = "Rename failed: file name cannot be empty.";
    return false;
  }

  try {
    const response = await fetch("/api/rename-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country, oldName, newName: trimmed })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Rename failed");
    }
    statusEl.textContent = `Renamed file to "${payload.name}".`;
    return true;
  } catch (error) {
    statusEl.textContent = `Rename failed: ${error.message}`;
    return false;
  }
}

function makeMediaCard(country, fileName, href, previewElement) {
  const card = document.createElement("article");
  card.className = "media-card";

  const previewLink = document.createElement("a");
  previewLink.className = "media-link";
  previewLink.href = href;
  previewLink.target = "_blank";
  previewLink.rel = "noopener noreferrer";
  previewLink.appendChild(previewElement);

  const captionRow = document.createElement("div");
  captionRow.className = "media-caption-row";

  const captionLink = document.createElement("a");
  captionLink.className = "media-caption-link";
  captionLink.href = href;
  captionLink.target = "_blank";
  captionLink.rel = "noopener noreferrer";
  captionLink.textContent = fileName;

  const renameButton = createRenameIconButton(`Rename ${fileName}`, async () => {
    const requestedName = window.prompt("Rename media file:", fileName);
    if (requestedName === null) {
      return;
    }
    const ok = await renameMediaFile(country, fileName, requestedName);
    if (ok) {
      await loadCountry(activeCountry);
    }
  });

  captionRow.appendChild(captionLink);
  captionRow.appendChild(renameButton);
  card.appendChild(previewLink);
  card.appendChild(captionRow);
  return card;
}

function normalizeDocRecord(record, index) {
  const name = record && typeof record.name === "string" ? record.name.trim() : "";
  const url = record && typeof record.url === "string" ? record.url.trim() : "";
  const id = record && typeof record.id === "string" ? record.id.trim() : "";
  if (!isHttpUrl(url)) {
    return null;
  }
  return {
    id: id || `doc-${index + 1}`,
    name: name || `Document ${index + 1}`,
    url
  };
}

async function fetchDocLinks(country) {
  try {
    const response = await fetch(`/api/doc-links?country=${encodeURIComponent(country)}`);
    if (!response.ok) {
      throw new Error("Could not load document links");
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload.map((item, index) => normalizeDocRecord(item, index)).filter((item) => item);
  } catch {
    statusEl.textContent += " Could not load named links.";
    return [];
  }
}

async function renameDocument(documentId, newName) {
  const trimmedName = String(newName || "").trim();
  if (!trimmedName) {
    statusEl.textContent = "Rename failed: name cannot be empty.";
    return false;
  }

  try {
    const response = await fetch("/api/rename-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: activeCountry, id: documentId, name: trimmedName })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Rename failed");
    }
    statusEl.textContent = `Renamed document to "${payload.name}".`;
    return true;
  } catch (error) {
    statusEl.textContent = `Rename failed: ${error.message}`;
    return false;
  }
}

function renderLinkCards(label, documents) {
  documents.forEach((doc, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "doc-box";

    const headerRow = document.createElement("div");
    headerRow.className = "doc-header-row";

    const anchor = document.createElement("a");
    anchor.href = doc.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.className = "doc-link";
    anchor.textContent = doc.name;
    headerRow.appendChild(anchor);

    const renameButton = createRenameIconButton(`Rename ${doc.name}`, async () => {
      const requestedName = window.prompt("Rename document:", doc.name);
      if (requestedName === null) {
        return;
      }
      const ok = await renameDocument(doc.id, requestedName);
      if (ok) {
        await loadCountry(activeCountry);
      }
    });
    headerRow.appendChild(renameButton);
    wrapper.appendChild(headerRow);

    const embedUrl = googleDocEmbedUrl(doc.url) || (isPdfUrl(doc.url) ? doc.url : null);
    if (embedUrl) {
      const frame = document.createElement("iframe");
      frame.src = embedUrl;
      frame.title = `${label} document preview ${index + 1}`;
      wrapper.appendChild(frame);
    }

    docEmbedEl.appendChild(wrapper);
  });
}

async function renderGallery(country, files, docLinks) {
  galleryEl.innerHTML = "";
  docEmbedEl.innerHTML = "";
  const label = displayName(country);

  const imageFiles = files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
  const pdfFiles = files.filter((f) => /\.pdf$/i.test(f));

  if (imageFiles.length === 0 && pdfFiles.length === 0 && docLinks.length === 0) {
    statusEl.textContent = `No media or documents found for ${label}.`;
    return;
  }

  imageFiles.forEach((file) => {
    const mediaPath = `data/${country}/${encodeURIComponent(file)}`;
    const img = document.createElement("img");
    img.src = mediaPath;
    img.alt = `${label} project: ${file}`;
    galleryEl.appendChild(makeMediaCard(country, file, mediaPath, img));
  });

  pdfFiles.forEach((file) => {
    const mediaPath = `data/${country}/${encodeURIComponent(file)}`;
    const frame = document.createElement("iframe");
    frame.className = "pdf-preview";
    frame.src = mediaPath;
    frame.title = `${label} PDF preview ${file}`;
    galleryEl.appendChild(makeMediaCard(country, file, mediaPath, frame));
  });

  renderLinkCards(label, docLinks);

  statusEl.textContent =
    `Loaded ${imageFiles.length} image(s), ${pdfFiles.length} PDF(s), and ${docLinks.length} named link(s) for ${label}.`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles() {
  const files = Array.from(uploadFilesInputEl.files || []);
  if (files.length === 0) {
    statusEl.textContent = "Choose at least one file to upload.";
    return;
  }

  statusEl.textContent = `Uploading ${files.length} file(s) to ${displayName(activeCountry)}...`;

  try {
    const payloadFiles = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        contentBase64: await readFileAsBase64(file)
      }))
    );

    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: activeCountry, files: payloadFiles })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Upload failed");
    }

    uploadFilesInputEl.value = "";
    statusEl.textContent = `Uploaded ${payload.saved.length} file(s) to ${displayName(activeCountry)}.`;
    await loadCountry(activeCountry);
  } catch (error) {
    statusEl.textContent = `Upload failed: ${error.message}`;
  }
}

async function saveNamedLink() {
  const name = String(uploadLinkNameEl.value || "").trim();
  const url = String(uploadLinkUrlEl.value || "").trim();

  if (!name) {
    statusEl.textContent = "Enter a document name.";
    return;
  }

  if (!isHttpUrl(url)) {
    statusEl.textContent = "Enter a valid HTTP/HTTPS document URL.";
    return;
  }

  statusEl.textContent = `Saving "${name}" for ${displayName(activeCountry)}...`;

  try {
    const response = await fetch("/api/doc-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: activeCountry, name, url })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not save document link");
    }

    uploadLinkNameEl.value = "";
    uploadLinkUrlEl.value = "";
    statusEl.textContent = `Saved document "${payload.name}" for ${displayName(activeCountry)}.`;
    await loadCountry(activeCountry);
  } catch (error) {
    statusEl.textContent = `Could not save document: ${error.message}`;
  }
}

async function loadCountry(country) {
  activeCountry = country;
  setActiveTab(country);
  statusEl.textContent = `Loading ${displayName(country)} documents...`;
  galleryEl.innerHTML = "";
  docEmbedEl.innerHTML = "";

  try {
    const [filesResponse, links] = await Promise.all([
      fetch(`/api/list?country=${encodeURIComponent(country)}`),
      fetchDocLinks(country)
    ]);

    if (!filesResponse.ok) {
      throw new Error("Missing country directory");
    }
    const files = await filesResponse.json();
    await renderGallery(country, files, links);
  } catch {
    statusEl.textContent = `Could not load documents for ${displayName(country)}. Make sure the folder exists.`;
  }
}

function setupUploadSpoilerLock() {
  if (!uploadSpoilerEl) {
    return;
  }

  uploadSpoilerEl.addEventListener("toggle", () => {
    if (!uploadSpoilerEl.open) {
      return;
    }

    const entered = window.prompt("Enter password to open upload panel:");
    if (entered !== UPLOAD_PANEL_PASSWORD) {
      uploadSpoilerEl.open = false;
      statusEl.textContent = "Incorrect password. Upload panel remains locked.";
    }
  });
}

createTabs();
setupUploadSpoilerLock();
uploadFilesBtnEl.addEventListener("click", uploadFiles);
uploadLinkBtnEl.addEventListener("click", saveNamedLink);
loadCountry("uk");
