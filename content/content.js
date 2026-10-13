/**
 * PrivacyLens Content Script — content/content.js
 *
 * Responsibilities:
 *  1. Detect privacy policy links on the current page DOM.
 *  2. Extract clean plain text from the current page when it IS the policy.
 *
 * Injected by manifest.json on all http/https pages at document_idle.
 */

'use strict';

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FIND_POLICY_URL') {
    const url = findPolicyUrl();
    sendResponse({ policy_url: url });
    return true; // keep channel open
  }

  if (message.type === 'EXTRACT_POLICY_TEXT') {
    const text = extractPageText();
    const is_policy_page = isPrivacyPolicyPage();
    sendResponse({ policy_text: text, is_policy_page });
    return true;
  }

  if (message.type === "CLEAN_HTML_TEXT") {
    const cleaned = CleanPolicyFromHtmlText(message.html, message.url);
    sendResponse({ cleaned_text: cleaned });
    return true;
  }
});

if (document.readyState === 'loading') {
  document.addEventListener("DOMContentLoaded", init);
}else{
  init();
}
// ------ Toast on policy found -------------------------------------------------

function init() {
 const is_policy_page = isPrivacyPolicyPage();
 const url = findPolicyUrl();
 if(url) {
   console.log('[PrivacyLens content] Found policy URL: ' + url);
   showToast(url);
 }
}

function showToast(policyUrl){
  console.log("toasted");
  if (document.getElementById("pp-analyzer-toast")) return;

  const toast = document.createElement("div");
  toast.id = "pp-analyzer-toast";
  toast.innerHTML = `
    <span>🔍 Privacy policy detected</span>
    <button id="pp-analyze-btn">Analyze</button>
    <button id="pp-dismiss-btn">✕</button>
  `;

  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "999999",
    background: "#1e1e2e",
    color: "#fff",
    padding: "12px 16px",
    borderRadius: "10px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
  });

  document.body.appendChild(toast);

  document.getElementById("pp-analyze-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_EXTENSION", policyUrl });
    toast.remove();
  });

  document.getElementById("pp-dismiss-btn").addEventListener("click", () => {
    toast.remove();
  });

  // Auto-dismiss after 8 seconds
  setTimeout(() => toast?.remove(), 8000);
}
// ─── Policy URL Detection ─────────────────────────────────────────────────────

/**
 * Scan the DOM for the most likely privacy policy link.
 * Returns an absolute URL string, or null if none found.
 */
function findPolicyUrl() {
  console.log('[PrivacyLens content] Scanning for policy URL…');
  const anchors = Array.from(document.querySelectorAll('a[href]'));

  const HREF_KEYWORDS = ['privacy', 'legal', 'policy', 'datenschutz'];
  const TEXT_KEYWORDS = [
    'privacy policy', 'privacy notice', 'data policy',
    'privacy statement', 'data protection',
    'our privacy', 'your privacy', 
  ];

  // Pass 1 — prefer footer links that match both href AND text
  for (const anchor of anchors) {
    if (!anchor.href || anchor.href.startsWith('javascript')) continue;
    const href = anchor.href.toLowerCase();
    const text = anchor.textContent.trim().toLowerCase();

    const hrefMatch = HREF_KEYWORDS.some(kw => href.includes(kw));
    const textMatch = TEXT_KEYWORDS.some(kw => text.includes(kw));

    if (hrefMatch && textMatch && isInFooterArea(anchor)) {
      return anchor.href;
    }
  }

  // Pass 2 — any footer link with matching href or text
  for (const anchor of anchors) {
    if (!anchor.href || anchor.href.startsWith('javascript')) continue;
    const href = anchor.href.toLowerCase();
    const text = anchor.textContent.trim().toLowerCase();

    const hrefMatch = HREF_KEYWORDS.some(kw => href.includes(kw));
    const textMatch = TEXT_KEYWORDS.some(kw => text.includes(kw));

    if ((hrefMatch || textMatch) && isInFooterArea(anchor)) {
      return anchor.href;
    }
  }

  // Pass 3 — any link with text match anywhere on the page
  for (const anchor of anchors) {
    if (!anchor.href || anchor.href.startsWith('javascript')) continue;
    const text = anchor.textContent.trim().toLowerCase();
    if (TEXT_KEYWORDS.some(kw => text.includes(kw))) {
      return anchor.href;
    }
  }

  // Pass 4 — broadest fallback: any href containing 'privacy'
  for (const anchor of anchors) {
    if (!anchor.href || anchor.href.startsWith('javascript')) continue;
    if (anchor.href.toLowerCase().includes('privacy')) {
      return anchor.href;
    }
  }

  return null;
}

/**
 * Walk up the DOM tree to check if an element is inside a footer-like container.
 */
function isInFooterArea(element) {
  let el = element;
  while (el && el !== document.body) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'footer') return true;
    const id = (el.id || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    if (id.includes('footer') || cls.includes('footer')) return true;
    el = el.parentElement;
  }
  return false;
}

// ─── Policy Text Extraction ───────────────────────────────────────────────────


/**
 * Extracts and cleans text content from the current page using Mozilla's Readability library,
 */
function extractPageText() {
  const documentClone = document.cloneNode(true);
  const parsed = new Readability(documentClone).parse();
  if (!parsed || !parsed.textContent) {
    return '';
  }
  
  return "Title: " + parsed.title + "\n\n" + parsed.textContent.trim();
}

function CleanPolicyFromHtmlText(html, url){
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  const base = doc.createElement('base');
  base.href = url;
  doc.head.prepend(base);

  const parsed = new Readability(doc).parse();
  // console.log("Parsed with Readability:", parsed);
  if (!parsed || !parsed.textContent) {
    return '';
  }
  
  return "Title: " + parsed.title + "\n\n" + parsed.textContent.trim();
}
/**
 * Determine whether the current page is likely a privacy policy page itself
 * (as opposed to a page that merely links to one).
 */
function isPrivacyPolicyPage() {
  const url = window.location.href.toLowerCase();
  const title = document.title.toLowerCase();
  const POLICY_KEYWORDS = ['privacy', 'legal', 'policy', 'datenschutz', 'cookies'];
  return POLICY_KEYWORDS.some(kw => url.includes(kw) || title.includes(kw));
}
