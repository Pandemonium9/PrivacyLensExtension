/**
 * PrivacyLens Popup Script — popup/popup.js
 *
 * Controls all 6 UI states:
 *   loading → (result | not-analyzed | error | unsupported)
 *   not-analyzed → analyzing → (result | error)
 *   error → (retry)
 *   result → analyzing (re-analyze)
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

/** Global context captured once on DOMContentLoaded */
let _tab = null;
let _domain = null;
let _detectedPolicyUrl = null;
let _lastErrorCode = null;

// ─── Entry Point ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('[PrivacyLens popup] Initializing…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    _tab = tab;
    initLensTilt();

    // Read pending state set by the OPEN_EXTENSION message handler
    const { pendingPolicyUrl, pendingTabId, pendingTabUrl } = await chrome.storage.session.get([
      'pendingPolicyUrl',
      'pendingTabId',
      'pendingTabUrl',
    ]);

    // Determine the URL to use for domain extraction.
    // When the popup is opened programmatically (via chrome.action.openPopup()),
    // activeTab permission may not grant tab.url — use pendingTabUrl as fallback.
    const effectiveUrl = tab?.url || pendingTabUrl || null;
    _domain = extractDomain(effectiveUrl);

    // If we still don't have a domain, fall back to the pendingTabId tab
    if (!_domain && pendingTabId) {
      try {
        const pendingTab = await chrome.tabs.get(pendingTabId);
        _domain = extractDomain(pendingTab?.url);
        if (!_tab) _tab = pendingTab;
      } catch (_) { /* tab may have closed */ }
    }

    if (!_domain) {
      showState('unsupported');
      return;
    }

    // Show domain in header
    document.getElementById('domain-label').textContent = _domain;

    // Begin loading
    showState('loading');

    // Pass the pending policy URL (if any) to GET_SUMMARY so the worker
    // can return it as a hint on DOMAIN_NOT_FOUND without a content-script round-trip.
    const tabIdToUse = _tab?.id ?? pendingTabId;
    chrome.runtime.sendMessage(
      { type: 'GET_SUMMARY', domain: _domain, tabId: tabIdToUse, policy_url: pendingPolicyUrl || null },
      (response) => {
        if (chrome.runtime.lastError) {
          showState('error', 'NETWORK_ERROR');
          return;
        }
        handleSummaryResponse(response);
      }
    );

    if (pendingPolicyUrl || pendingTabUrl) {
      // Clear pending keys so they don't bleed into the next popup open
      chrome.storage.session.remove(['pendingPolicyUrl', 'pendingTabId', 'pendingTabUrl']);
    }
  } catch (err) {
    console.error('[PrivacyLens popup] Init error:', err);
    showState('error', 'NETWORK_ERROR');
  }
});


// ─── Response Handler ────────────────────────────────────────────────────────

function handleSummaryResponse(response) {
  if (!response) {
    showState('error', 'NETWORK_ERROR');
    return;
  }
  if (!response.success) {
    if (response.errorCode === 'DOMAIN_NOT_FOUND') {
      _detectedPolicyUrl = response.policy_url || null;
      showState('not-analyzed');
    } else {
      showState('error', response.errorCode);
    }
    return;
  }

  // Indicate whether this was a local cache hit vs. fresh backend fetch
  const fromCache = response.fromCache === true;
  showState('result', response.data, fromCache);
}

// ─── Analyze Flow ────────────────────────────────────────────────────────────

function triggerAnalyze() {
  // Resolve policy URL: auto-detected or manually typed
  let policyUrl = _detectedPolicyUrl;
  
  const manualInput = document.getElementById('manual-policy-url');
  if (manualInput && manualInput.value.trim()) {
    policyUrl = manualInput.value.trim();
  }

  _lastErrorCode = null;
  showState('analyzing');
  animateAnalyzingSteps();

  chrome.runtime.sendMessage(
    {
      type: 'TRIGGER_ANALYZE',
      domain: _domain,
      tabId: _tab.id,
      policy_url: policyUrl,
      url: _tab.url,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        showState('error', 'NETWORK_ERROR');
        return;
      }
      if (!response?.success) {
        showState('error', response?.errorCode || 'NETWORK_ERROR');
      } else {
        showState('result', response.data, false);
      }
    }
  );
}

// ─── State Machine ────────────────────────────────────────────────────────────

const ALL_STATES = ['loading', 'not-analyzed', 'analyzing', 'result', 'error', 'unsupported'];

/**
 * Transition to a named state, optionally passing context data.
 * @param {'loading'|'not-analyzed'|'analyzing'|'result'|'error'|'unsupported'} state
 * @param {object|string|null} data  - Result payload, error code, etc.
 * @param {boolean} fromCache        - Used for result state status indicator
 */
function showState(state, data = null, fromCache = false) {
  // Hide all states
  ALL_STATES.forEach(s => {
    const el = document.getElementById(`state-${s}`);
    if (el) el.style.display = 'none';
  });

  // Progress bar
  document.getElementById('progress-bar').classList.toggle('active', state === 'analyzing');

  // Spinner & dot
  const spinner = document.getElementById('header-spinner');
  const dot = document.getElementById('status-dot');
  spinner.className = 'spinner' + (state === 'loading' ? ' visible' : '');
  dot.className = 'status-dot';

  // Footer disclaimer
  const footer = document.getElementById('footer-disclaimer');
  footer.classList.toggle('visible', state === 'result');

  // Show target state
  const target = document.getElementById(`state-${state}`);
  if (target) target.style.display = 'block';

  // State-specific setup
  switch (state) {
    case 'not-analyzed':
      setupNotAnalyzed();
      break;
    case 'result':
      setupResult(data, fromCache);
      dot.classList.add('visible');
      dot.classList.add(fromCache ? 'dot-cached' : 'dot-fresh');
      break;
    case 'error':
      setupError(typeof data === 'string' ? data : (data?.errorCode || 'NETWORK_ERROR'));
      break;
    case 'analyzing':
      // Progress bar already shown; step animation triggered separately
      break;
    default:
      break;
  }
}

// ─── State: Not Analyzed Setup ────────────────────────────────────────────────

function setupNotAnalyzed() {
  const hintEl = document.getElementById('policy-url-hint');
  const hintVal = document.getElementById('policy-url-hint-value');
  const manualGroup = document.getElementById('manual-url-group');

  if (_detectedPolicyUrl) {
    hintEl.style.display = 'flex';
    // Truncate long URLs for display
    const display = _detectedPolicyUrl.replace(/^https?:\/\//, '').substring(0, 48);
    hintVal.textContent = display + (_detectedPolicyUrl.length > 48 ? '…' : '');
    hintVal.title = _detectedPolicyUrl;
    manualGroup.style.display = 'none';
  } else {
    hintEl.style.display = 'none';
    manualGroup.style.display = 'flex';
  }

  // Bind Analyze button
  const btn = document.getElementById('btn-analyze');
  btn.onclick = null;
  btn.onclick = triggerAnalyze;
}

// ─── State: Analyzing — Step Animation ───────────────────────────────────────

function animateAnalyzingSteps() {
  const steps = ['step-1', 'step-2', 'step-3'];
  const DELAYS = [0, 2200, 10000]; // ms

  steps.forEach(id => {
    const el = document.getElementById(id);
    el.className = 'step-item';
  });

  steps.forEach((id, i) => {
    setTimeout(() => {
      // Mark previous as done
      if (i > 0) {
        document.getElementById(steps[i - 1]).className = 'step-item done';
      }
      document.getElementById(id).className = 'step-item active';
    }, DELAYS[i]);
  });
}

// ─── State: Result Setup ──────────────────────────────────────────────────────

function setupResult(data, fromCache) {
  if (!data) return;

  // Summary
  document.getElementById('summary-text').textContent = data.summary || 'No summary available.';

  // Confidence
  const pill = document.getElementById('confidence-pill');
  const pct = Math.round((data.confidence ?? 0) * 100);
  pill.textContent = `${pct}%`;
  pill.className = 'confidence-pill';
  if (pct >= 80) pill.classList.add('high');
  else if (pct >= 50) pill.classList.add('medium');
  else pill.classList.add('low');

  // Grade
  document.getElementById('grade-value').textContent = data.grade || 'N/A';
  applyGradeTier(data.grade);

  // Red flags
  const redList = document.getElementById('red-flags-list');
  const redNoFlags = document.getElementById('red-no-flags');
  const redFlags = data.red_flags || [];
  redList.innerHTML = '';
  if (redFlags.length === 0) {
    redNoFlags.style.display = 'block';
  } else {
    redNoFlags.style.display = 'none';
    redFlags.forEach(flag => {
      redList.appendChild(buildFlagItem(flag, 'red'));
    });
  }
  document.getElementById('red-count').textContent = redFlags.length;

  // Green flags
  const greenList = document.getElementById('green-flags-list');
  const greenNoFlags = document.getElementById('green-no-flags');
  const greenFlags = data.green_flags || [];
  greenList.innerHTML = '';
  if (greenFlags.length === 0) {
    greenNoFlags.style.display = 'block';
  } else {
    greenNoFlags.style.display = 'none';
    greenFlags.forEach(flag => {
      greenList.appendChild(buildFlagItem(flag, 'green'));
    });
  }
  document.getElementById('green-count').textContent = greenFlags.length;

  // Default to red tab
  setActiveTab('red');

  // Metadata
  const statusMap = {
    ai: 'AI generated',
    human_approved: 'Human reviewed',
    human_rejected: 'Rejected',
    stale: 'Stale',
  };
  document.getElementById('review-status-label').textContent =
    statusMap[data.review_status] || data.review_status || '—';

  if (data.updated_at) {
    const d = new Date(data.updated_at);
    document.getElementById('updated-at-label').textContent =
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } else {
    document.getElementById('updated-at-label').textContent = '—';
  }

  // Re-analyze button
  const btnRe = document.getElementById('btn-reanalyze');
  btnRe.onclick = null;
  btnRe.onclick = () => {
    showState('not-analyzed');
  };

  // Tab button listeners
  document.getElementById('tab-red').onclick = () => setActiveTab('red');
  document.getElementById('tab-green').onclick = () => setActiveTab('green');
}

function buildFlagItem(text, type) {
  const li = document.createElement('li');
  li.className = `flag-item ${type}`;

  const dot = document.createElement('div');
  dot.className = 'flag-dot';

  const span = document.createElement('span');
  span.textContent = text;

  li.appendChild(dot);
  li.appendChild(span);
  return li;
}

function setActiveTab(which) {
  const tabRed   = document.getElementById('tab-red');
  const tabGreen = document.getElementById('tab-green');
  const panelRed   = document.getElementById('panel-red');
  const panelGreen = document.getElementById('panel-green');

  if (which === 'red') {
    tabRed.className = 'tab-btn active-red';
    tabGreen.className = 'tab-btn';
    panelRed.className = 'tab-panel visible';
    panelGreen.className = 'tab-panel';
  } else {
    tabGreen.className = 'tab-btn active-green';
    tabRed.className = 'tab-btn';
    panelGreen.className = 'tab-panel visible';
    panelRed.className = 'tab-panel';
  }
}

// ─── State: Error Setup ───────────────────────────────────────────────────────

const ERROR_MESSAGES = {
  DOMAIN_NOT_FOUND:          'No analysis available for this domain.',
  POLICY_TEXT_TOO_SHORT:     'Could not find a readable privacy policy on this page.',
  AI_SERVICE_UNAVAILABLE:    'Analysis service is temporarily unavailable. Try again shortly.',
  AI_RESPONSE_PARSE_FAILURE: 'Analysis failed due to an unexpected response. Please try again.',
  RATE_LIMIT_EXCEEDED:       'Too many requests — please wait a moment before retrying.',
  NETWORK_ERROR:             'Could not reach PrivacyLens servers. Check your connection.',
  SERVER_ERROR:              'An unexpected server error occurred. Please try again.',
};

function setupError(errorCode) {
  _lastErrorCode = errorCode;
  const msg = ERROR_MESSAGES[errorCode] || 'An unexpected error occurred.';
  document.getElementById('error-message').textContent = msg;

  const btnRetry = document.getElementById('btn-retry');
  btnRetry.onclick = null;
  btnRetry.onclick = () => {
    // If the last operation was an analysis request, re-show not-analyzed
    // so the user can click Analyze again; otherwise redo GET_SUMMARY
    if (errorCode === 'POLICY_TEXT_TOO_SHORT' || errorCode === 'AI_SERVICE_UNAVAILABLE'
        || errorCode === 'AI_RESPONSE_PARSE_FAILURE') {
      showState('not-analyzed');
    } else {
      showState('loading');
      chrome.runtime.sendMessage(
        { type: 'GET_SUMMARY', domain: _domain, tabId: _tab?.id },
        (response) => {
          if (chrome.runtime.lastError) { showState('error', 'NETWORK_ERROR'); return; }
          handleSummaryResponse(response);
        }
      );
    }
  };
}

// ─── Domain Extraction ────────────────────────────────────────────────────────

/**
 * Extract the eTLD+1 registrable domain from a URL using the vendored tldts library.
 * Returns null for unsupported schemes (chrome://, about:, file://, etc.).
 */
function extractDomain(url) {
  if (!url) return null;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  try {
    // tldts is loaded as a UMD global via content_scripts / the lib/ include
    // In popup.js we use the URL API for eTLD+1 because tldts isn't loaded here.
    // We replicate the same normalization logic: lowercase hostname sans 'www.'
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Use tldts if available (injected via manifest content_scripts in the
    // extension context — not guaranteed in popup). Fall back to URL hostname.
    if (typeof tldts !== 'undefined') {
      const result = tldts.parse(url);
      return result.domain ? result.domain.toLowerCase() : null;
    }

    // Simple fallback: strip leading 'www.' only
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ─── Glassmorphism: Header Lens Hover Tilt ────────────────────────────────────

/**
 * Adds a mousemove listener to the header that tilts the logo-mark lens
 * toward the cursor. Resets on mouseleave.
 * No effect when prefers-reduced-motion is set — CSS handles that via
 * transition:none and transform being read back as 0deg.
 */
function initLensTilt() {
  const header = document.querySelector('.header');
  const logo   = document.querySelector('.logo-mark');
  if (!header || !logo) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  header.addEventListener('mousemove', (e) => {
    const rect = logo.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top  + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width  || 1);
    const dy = (e.clientY - cy) / (rect.height || 1);
    logo.style.setProperty('--rx', `${(dx *  8).toFixed(1)}deg`);
    logo.style.setProperty('--ry', `${(-dy * 8).toFixed(1)}deg`);
  });

  header.addEventListener('mouseleave', () => {
    logo.style.setProperty('--rx', '0deg');
    logo.style.setProperty('--ry', '0deg');
  });
}

// ─── Glassmorphism: Grade Lens Tier + Focus-Pull ──────────────────────────────

/**
 * Sets the data-tier attribute on #grade-lens so CSS drives the correct
 * ring/glow color, then retriggers the lensFocusPull entrance animation.
 * Called from setupResult() every time a result renders.
 *
 * @param {string|null|undefined} grade — e.g. "A+", "B-", "F"
 */
function applyGradeTier(grade) {
  const lens = document.getElementById('grade-lens');
  if (!lens) return;

  const letter = (grade || '').trim().charAt(0).toUpperCase();
  const TIERS  = { A: 'excellent', B: 'good', C: 'fair', D: 'poor', F: 'bad' };
  lens.dataset.tier = TIERS[letter] || 'fair';

  // Retrigger entrance animation on every result (covers re-analyze too).
  // Remove class → force reflow → add class so the @keyframes restarts.
  lens.classList.remove('is-revealing');
  // eslint-disable-next-line no-unused-expressions
  void lens.offsetWidth; // force reflow
  lens.classList.add('is-revealing');
}

