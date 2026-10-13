/**
 * PrivacyLens Background Service Worker — background/worker.js
 *
 * Responsibilities:
 *  - Receive GET_SUMMARY and TRIGGER_ANALYZE messages from the popup.
 *  - Coordinate with the content script to detect policy URLs and extract text.
 *  - Make fetch requests to the PrivacyLens API backend.
 *  - Cache results in chrome.storage.session (cleared on browser close).
 *  - Reply to the popup with structured success/error responses.
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

// For local development the backend runs on localhost:8000.
// Replace api.example.com with your own backend URL (here and in manifest.json host_permissions).
const IS_DEV = !('update_url' in chrome.runtime.getManifest());

const API_BASE = IS_DEV 
  ? 'http://localhost:8000/api/v1' 
  : 'https://api.example.com/api/v1';

const MIN_POLICY_TEXT_LENGTH = 200;


// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SUMMARY') {
    handleGetSummary(message, sendResponse);
    return true; // keeps the message channel open for async response
  }
  if (message.type === 'TRIGGER_ANALYZE') {
    handleTriggerAnalyze(message, sendResponse);
    return true;
  }
  if (message.type === 'OPEN_EXTENSION') {
    // Store the policy URL so the popup can read it immediately
    chrome.storage.session.set({
      pendingPolicyUrl: message.policyUrl,
      pendingTabId: sender.tab.id,
      pendingTabUrl: sender.tab.url,
    });

    
    chrome.action.openPopup();
  }
  // Unknown message — ignore
});

// ─── Handler: GET_SUMMARY ─────────────────────────────────────────────────────

/**
 * Attempt to load a cached summary for the given domain.
 * 1. Check chrome.storage.session for a local in-session cache hit.
 * 2. Ask the content script to find the policy URL on the current page.
 * 3. Query the backend GET /summary endpoint.
 * 4. On 404 → tell the popup the domain is not yet analyzed (with policy URL hint).
 */
async function handleGetSummary({ domain, tabId, policy_url }, sendResponse) {
  try {
    // 1. Local session cache check
    const cacheKey = `summary:${domain}`;
    const cached = await chrome.storage.session.get(cacheKey);
    if (cached[cacheKey]) {
      sendResponse({ success: true, data: cached[cacheKey], fromCache: true });
      return;
    }

    // 2. Ask the content script for a policy URL hint
    
    try {
      if(!policy_url){
        const csResult = await sendToContentScript(tabId, { type: 'FIND_POLICY_URL' });
        console.log('[PrivacyLens worker] Content script policy URL hint:', csResult?.policy_url);
        if (csResult?.policy_url) policy_url = csResult.policy_url;
      }
    } catch (_) {
      // Non-fatal — content script may not be available on all frames
    }

    // 3. Query the backend
    const response = await fetch(
      `${API_BASE}/summary?domain=${encodeURIComponent(domain)}`
    );

    if (response.status === 404) {
      sendResponse({ success: false, errorCode: 'DOMAIN_NOT_FOUND', policy_url });
      return;
    }
    if (response.status === 429) {
      sendResponse({ success: false, errorCode: 'RATE_LIMIT_EXCEEDED' });
      return;
    }
    if (!response.ok) {
      sendResponse({ success: false, errorCode: 'SERVER_ERROR' });
      return;
    }

    const data = await response.json();

    // 4. Populate session cache and respond
    await chrome.storage.session.set({ [cacheKey]: data });
    sendResponse({ success: true, data, policy_url, fromCache: false });

  } catch (e) {
    console.error('[PrivacyLens worker] GET_SUMMARY error:', e);
    sendResponse({ success: false, errorCode: 'NETWORK_ERROR' });
  }
}

// ─── Handler: TRIGGER_ANALYZE ─────────────────────────────────────────────────

/**
 * Perform a full analysis pipeline:
 * 1. Try extracting policy text from content script (if on the policy page).
 * 2. If not enough text, fetch the policy URL directly and strip HTML.
 * 3. POST to backend /analyze.
 * 4. Cache the result and respond.
 */
async function handleTriggerAnalyze({ domain, tabId, policy_url, url }, sendResponse) {
  try {
    let policy_text = '';

    // 1. Try content script extraction from current page (only if we're on the policy page)
    try {
      const csResult = await sendToContentScript(tabId, { type: 'EXTRACT_POLICY_TEXT' });
      //const cleanedResult = await sendToContentScript(tabId, { type: 'CLEAN_POLICY_TEXT' });
      if(csResult.is_policy_page) {
        console.log('[PrivacyLens worker] result from content script:', csResult.policy_text);
      }
      if (
        csResult?.is_policy_page &&
        csResult?.policy_text &&
        csResult.policy_text.length >= MIN_POLICY_TEXT_LENGTH
      ) {
        console.log('[PrivacyLens worker] Extracted policy text from content script.');
        policy_text = csResult.policy_text;
      }
    } catch (_) { /* non-fatal */ }

    // 2. Fallback: fetch the policy URL directly
    if (policy_text.length < MIN_POLICY_TEXT_LENGTH && policy_url) {
      try {
        const fetchRes = await fetch(policy_url);
        const html = await fetchRes.text();
        // policy_text = stripHtml(html);
        let fetched_text = await sendToContentScript(tabId, { type: 'CLEAN_HTML_TEXT', html: html, url: policy_url });
        if(fetched_text === null){
          console.warn('[PrivacyLens worker] fetchedText is null');
        }
        let clean_text = normalizeWhitespace(fetched_text.cleaned_text);
        
        console.log('[PrivacyLens worker] Fetched and stripped policy URL content.');
        // console.log('[PrivacyLens worker] cleanedResult from HTML content:', fetched_text.cleaned_text);

        // console.log('[PrivacyLens worker] Normal Strip html result length:', policy_text.length);
        console.log('[PrivacyLens worker] Cleaned policy text length:', fetched_text.cleaned_text.length);
        console.log('[PrivacyLens worker] Cleaned policy text with both methods:', clean_text.length);

        console.log('[PrivacyLens worker] Final cleaned policy text:', clean_text);
        if(clean_text && clean_text.length >= MIN_POLICY_TEXT_LENGTH) {
          console.log('[PrivacyLens worker] Using cleaned policy text from readability pipeline.');
          policy_text = clean_text;
        }else{
          console.warn('[PrivacyLens worker] Cleaned text is too short, falling back to original stripped text.');
          policy_text = stripHtml(html);
          console.log('[PrivacyLens worker] Fallback to original stripped text:', policy_text.length);
        }
        //console.log("policy_text:", policy_text);
      } catch (fetchErr) {
        console.warn('[PrivacyLens worker] Failed to fetch policy URL:', fetchErr);
      }
    }

    if (!policy_text || policy_text.length < MIN_POLICY_TEXT_LENGTH) {
      sendResponse({ success: false, errorCode: 'POLICY_TEXT_TOO_SHORT' });
      return;
    }
    //policy_text = "Toggle navigation Privacy Policy Help Center Setup 404 - Resource Not Found. The server encountered an internal error or misconfiguration and was unable to complete your request. Please contact the server administrator at webmaster@domain-local-backup.internal to inform them of the time this error occurred, and the actions you performed just before this error. Technical Details: Exception in thread \"main\" java.lang.NullPointerException: Cannot invoke \"String.length()\" because \"localHtmlSource\" is null at com.fetcher.parser.StaticRenderer.main(StaticRenderer.java:42) {{ user.session_expired_message || 'Loading dynamic content... Please enable JavaScript and refresh the page.' }} Site Map | Terms of Service | Cookie Preferences © 2026 Legacy Web Archives. All rights reserved. Tracking pixel loaded: 0x8839201. Optimizing layout for mobile viewports... Warning: Failed prop type: The prop `auth` is marked as required in `Header`, but its value is `undefined`. End of transmission.'";
    // 3. POST to backend /analyze
    const response = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain,
        url: url || policy_url || '',
        policy_url: policy_url || url || '',
        policy_text,
      }),
    });

    if (response.status === 429) {
      sendResponse({ success: false, errorCode: 'RATE_LIMIT_EXCEEDED' });
      return;
    }
    if (response.status === 503) {
      sendResponse({ success: false, errorCode: 'AI_SERVICE_UNAVAILABLE' });
      return;
    }
    if (!response.ok) {
      let errorCode = 'SERVER_ERROR';
      try {
        const errBody = await response.json();
        if (errBody?.error_code) errorCode = errBody.error_code;
      } catch (_) {}
      sendResponse({ success: false, errorCode });
      return;
    }

    const data = await response.json();

    // 4. Update session cache and respond
    const cacheKey = `summary:${domain}`;
    await chrome.storage.session.set({ [cacheKey]: data });
    sendResponse({ success: true, data });

  } catch (e) {
    console.error('[PrivacyLens worker] TRIGGER_ANALYZE error:', e);
    sendResponse({ success: false, errorCode: 'NETWORK_ERROR' });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Send a message to the content script in the specified tab.
 * Returns a Promise that resolves to the response object, or null on error.
 */
function sendToContentScript(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Parse an HTML string and return its inner text, with collapsed whitespace.
 * Uses the service worker's DOMParser for safe sandboxed parsing.
 */
function stripHtml(html) {
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    // Remove boilerplate elements
    [
      'script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript',
      'iframe', 'img', 'svg', 'figure', 'picture', 'video', 'audio',
      'button', 'input', 'select', 'textarea', 'form',
      '[aria-hidden="true"]', '.cookie-banner', '.cookie-notice',
      '.popup', '.modal', '.banner', '.ad', '.advertisement'
    ].forEach(tag => {
      parsed.querySelectorAll(tag).forEach(el => el.remove());
    });

    const raw = parsed.body?.innerText || parsed.body?.textContent || '';

    return raw
      // Normalize unicode whitespace and zero-width chars
      .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
      // Collapse whitespace
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')
      // Collapse 3+ newlines into 2 (preserve paragraph breaks)
      .replace(/\n{3,}/g, '\n\n')
      // Remove lines that are just symbols/punctuation with no real words
      .replace(/^[^a-zA-Z0-9]+$/gm, '')
      // Remove common cookie/GDPR banner remnant phrases
      .replace(/\b(accept all cookies?|reject all|cookie settings?|manage preferences?|privacy preferences?)\b/gi, '')
      // Remove URLs
      .replace(/https?:\/\/\S+/g, '')
      // Remove email addresses
      .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, '')
      // Remove lines shorter than 20 chars (usually nav links, labels, stray text)
      .split('\n')
      .filter(line => line.trim().length >= 20 || line.trim() === '')
      .join('\n')
      .trim();

  } catch (_) {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function normalizeWhitespace(text) {
  return text
    // Normalize non-breaking spaces and other unicode spaces to regular spaces
    .replace(/[\u00A0\u200B-\u200D\uFEFF\u00AD]/g, ' ')
    // Collapse multiple spaces/tabs on a single line into one space
    .replace(/[ \t]+/g, ' ')
    // Trim trailing/leading spaces on each line
    .split('\n')
    .map(line => line.trim())
    // Collapse 3+ consecutive newlines into 2 (preserves paragraph breaks)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

