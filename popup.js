/**
 * Midey — Gmail Lead Dispatcher (Popup & Side Panel Controller)
 * Handles JSON and CSV parsing, personalization tags, rotating signatures,
 * light/dark theme switching, storage synchronization, and Gmail automation messaging.
 */

// Global cached state
let currentLeads = [];
let currentQueueState = { isRunning: false, statusMessage: 'Ready', countdownSec: null, nextSendAt: null };
let currentSettings = {
  minDelaySec: 20,
  maxDelaySec: 40,
  autoCloseTab: true,
  enableSignature: false,
  signatures: [],
  signatureRotationMode: 'sequential',
  lastSignatureIndex: 0,
  enableBccMode: false,
  bccBatchSize: 10,
  keepAwakeDuringQueue: true,
  enableMultiContent: false,
  contentRotationTarget: 'both',
  contentRotationMode: 'sequential',
  subjectTemplates: [],
  bodyTemplates: [],
  lastSubjectIndex: 0,
  lastBodyIndex: 0,
  enableConfidentialMode: false,
  confidentialExpiration: '1w'
};
let currentTheme = 'dark';
let currentFilter = '';
let lastFocusedTemplateInput = null;
let leadsDisplayLimit = 150;
let localCountdownInterval = null;
let currentSpamCheckLeads = [];
let currentAntiSleepState = { isActive: false, reason: null, durationMinutes: null, expiresAt: null };
let antiSleepCountdownInterval = null;

// Cryptographic Security & Master Verification Parameters
// Uses PBKDF2-SHA256 with 100,000 iterations to ensure one-way verification
// that cannot be reverse-engineered or extracted by code inspection or AI analysis.
const AUTH_SALT = 'M1d3y_Gm41l_L3ad_D1sp4tch3r_S3cur1ty_S@lt_v2_99x!';
const AUTH_ITERATIONS = 100000;
const AUTH_KEY_LEN = 256;
const AUTH_HASH_HEX = 'b39d48d1e7fcd2100d5c914f97d16faf46a4a5668075f818dbc3ac92f5b10a2e';

// Activation validity duration: 30 days (1 month)
const ACTIVATION_VALIDITY_DAYS = 30;
const ACTIVATION_VALIDITY_MS = ACTIVATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

let isAppActivated = false;
let appActivatedAt = null;
let isJsonUnlocked = false;
let keepJsonUnlocked = false;
let currentAnalytics = { lifetimeSent: 0, dailyHistory: {} };
let activePasswordCallback = null;

/**
 * Verify Master Password against PBKDF2-SHA256 Hash using native WebCrypto
 */
async function verifyMasterPassword(enteredPassword) {
  if (typeof enteredPassword !== 'string') return false;
  const normalized = enteredPassword.trim();
  if (!normalized) return false;

  try {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(normalized),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(AUTH_SALT),
        iterations: AUTH_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      AUTH_KEY_LEN
    );
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const computedHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return computedHex === AUTH_HASH_HEX;
  } catch (err) {
    console.error('[Security] Cryptographic verification failure:', err);
    return false;
  }
}

/**
 * Calculate remaining validity days for the activation session
 */
function getActivationRemainingDays(activatedAt) {
  if (!activatedAt || typeof activatedAt !== 'number') return 0;
  const elapsed = Date.now() - activatedAt;
  const remainingMs = ACTIVATION_VALIDITY_MS - elapsed;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

// Collapsible Section states (persisted)
let currentCollapsed = {
  sectionAnalytics: false,
  sectionImport: false,
  sectionContent: false,
  sectionFilterPrioritize: false,
  sectionSpamCheck: false,
  sectionAntiSleep: false,
  sectionQueue: false,
  sectionLeads: false,
  delaySettings: true
};

// Homepage Layout & Minimalism settings (persisted)
let currentLayout = {
  showAnalytics: true,
  showImport: true,
  showContent: true,
  showFilterPrioritize: true,
  showSpamCheck: true,
  showAntiSleep: true,
  showQueue: true,
  showStats: true,
  showFilterBar: true,
  showLeads: true,
  enableMultiContent: false,
  showConfidentialMode: true,
  density: 'compact'
};

// Excel-Style Filter Engine state
let filterRules = [];
let filterMatchMode = 'AND';
let isFilterQueueViewActive = false;

// DOM Elements - Header & Theme
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const themeLabel = document.getElementById('themeLabel');
const lockAppBtn = document.getElementById('lockAppBtn');

// DOM Elements - DevTools Dock Controls
const dockControlGroup = document.getElementById('dockControlGroup');
const dockPopoutBtn = document.getElementById('dockPopoutBtn');
const dockLeftBtn = document.getElementById('dockLeftBtn');
const dockBottomBtn = document.getElementById('dockBottomBtn');
const dockRightBtn = document.getElementById('dockRightBtn');
const dockSidePanelBtn = document.getElementById('dockSidePanelBtn');
const dockCloseBtn = document.getElementById('dockCloseBtn');

// DOM Elements - Secret Brand Trigger & JSON Unlocking
const brandSecretTrigger = document.getElementById('brandSecretTrigger');
const tabBtnJson = document.getElementById('tabBtnJson');
const keepJsonUnlockedCheckbox = document.getElementById('keepJsonUnlockedCheckbox');
const lockJsonBtn = document.getElementById('lockJsonBtn');

// DOM Elements - Global Dispatch Analytics Board
const sectionAnalytics = document.getElementById('sectionAnalytics');
const analyticsTodayBadge = document.getElementById('analyticsTodayBadge');
const resetAnalyticsBtn = document.getElementById('resetAnalyticsBtn');
const analyticsTodayCount = document.getElementById('analyticsTodayCount');
const analyticsSevenDayCount = document.getElementById('analyticsSevenDayCount');
const analyticsLifetimeCount = document.getElementById('analyticsLifetimeCount');
const sevenDayBars = document.getElementById('sevenDayBars');
const layoutShowAnalytics = document.getElementById('layoutShowAnalytics');

// DOM Elements - Collapsible Sections & Headers
const sectionImport = document.getElementById('sectionImport');
const sectionContent = document.getElementById('sectionContent');
const sectionFilterPrioritize = document.getElementById('sectionFilterPrioritize');
const sectionSpamCheck = document.getElementById('sectionSpamCheck');
const sectionQueue = document.getElementById('sectionQueue');
const sectionStats = document.getElementById('sectionStats');
const sectionFilterBar = document.getElementById('sectionFilterBar');
const sectionLeads = document.getElementById('sectionLeads');
const importModeBadge = document.getElementById('importModeBadge');
const leadsCountBadge = document.getElementById('leadsCountBadge');
const toggleDensityBtn = document.getElementById('toggleDensityBtn');
const toggleDelaySettingsBtn = document.getElementById('toggleDelaySettingsBtn');
const delaySettingsContent = document.getElementById('delaySettingsContent');
const delaySummaryText = document.getElementById('delaySummaryText');

// DOM Elements - Content Sync
const syncContentToLeadsBtn = document.getElementById('syncContentToLeadsBtn');
const contentSyncBanner = document.getElementById('contentSyncBanner');

// DOM Elements - Excel Filter & Prioritizer
const filterMatchAndBtn = document.getElementById('filterMatchAndBtn');
const filterMatchOrBtn = document.getElementById('filterMatchOrBtn');
const addFilterRuleBtn = document.getElementById('addFilterRuleBtn');
const clearFilterRulesBtn = document.getElementById('clearFilterRulesBtn');
const filterRulesList = document.getElementById('filterRulesList');
const filterMatchCountBadge = document.getElementById('filterMatchCountBadge');
const filterMatchCountText = document.getElementById('filterMatchCountText');
const toggleFilterViewBtn = document.getElementById('toggleFilterViewBtn');
const prioritizeLeadsBtn = document.getElementById('prioritizeLeadsBtn');
const filterStatusBanner = document.getElementById('filterStatusBanner');

// DOM Elements - Layout Customizer & Minimalist Banner
const layoutSettingsBtn = document.getElementById('layoutSettingsBtn');
const layoutModal = document.getElementById('layoutModal');
const layoutModalCloseBtn = document.getElementById('layoutModalCloseBtn');
const layoutModalDoneBtn = document.getElementById('layoutModalDoneBtn');
const minimalistNotice = document.getElementById('minimalistNotice');
const quickCustomizeLayoutBtn = document.getElementById('quickCustomizeLayoutBtn');
const resetLayoutQuickBtn = document.getElementById('resetLayoutQuickBtn');

const layoutShowImport = document.getElementById('layoutShowImport');
const layoutShowContent = document.getElementById('layoutShowContent');
const layoutShowFilterPrioritize = document.getElementById('layoutShowFilterPrioritize');
const layoutShowSpamCheck = document.getElementById('layoutShowSpamCheck');
const layoutShowAntiSleep = document.getElementById('layoutShowAntiSleep');
const layoutShowQueue = document.getElementById('layoutShowQueue');
const layoutShowStats = document.getElementById('layoutShowStats');
const layoutShowFilterBar = document.getElementById('layoutShowFilterBar');
const layoutShowLeads = document.getElementById('layoutShowLeads');
const layoutEnableMultiContent = document.getElementById('layoutEnableMultiContent');
const densitySelect = document.getElementById('densitySelect');

const presetMinimalBtn = document.getElementById('presetMinimalBtn');
const presetPrepareBtn = document.getElementById('presetPrepareBtn');
const presetFullBtn = document.getElementById('presetFullBtn');

// DOM Elements - Tabs
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

// DOM Elements - JSON / Batch Leads Tab
const jsonInput = document.getElementById('jsonInput');
const jsonFileInput = document.getElementById('jsonFileInput');
const uploadJsonFileBtn = document.getElementById('uploadJsonFileBtn');
const loadLeadsBtn = document.getElementById('loadLeadsBtn');
const clearInputBtn = document.getElementById('clearInputBtn');
const statusBanner = document.getElementById('statusBanner');

// DOM Elements - CSV Tab & Content Templates
const csvDropzone = document.getElementById('csvDropzone');
const csvFileInput = document.getElementById('csvFileInput');
const csvInput = document.getElementById('csvInput');
const clearCsvBtn = document.getElementById('clearCsvBtn');
const csvUseTemplateCheckbox = document.getElementById('csvUseTemplateCheckbox');
const csvTagsList = document.getElementById('csvTagsList');
const csvSubjectTemplate = document.getElementById('csvSubjectTemplate');
const csvBodyTemplate = document.getElementById('csvBodyTemplate');
const loadCsvLeadsBtn = document.getElementById('loadCsvLeadsBtn');
const csvStatusBanner = document.getElementById('csvStatusBanner');

// DOM Elements - Multi-Content & Rotation Mode
const modeSingleBtn = document.getElementById('modeSingleBtn');
const modeMultiBtn = document.getElementById('modeMultiBtn');
const multiContentModeBadge = document.getElementById('multiContentModeBadge');
const singleContentContainer = document.getElementById('singleContentContainer');
const multiContentContainer = document.getElementById('multiContentContainer');
const rotationTargetSelect = document.getElementById('rotationTargetSelect');
const rotationModeSelect = document.getElementById('rotationModeSelect');
const rotationSummaryText = document.getElementById('rotationSummaryText');
const addSubjectBtn = document.getElementById('addSubjectBtn');
const addBodyBtn = document.getElementById('addBodyBtn');
const subjectsListContainer = document.getElementById('subjectsListContainer');
const bodiesListContainer = document.getElementById('bodiesListContainer');
const subjectCountText = document.getElementById('subjectCountText');
const bodyCountText = document.getElementById('bodyCountText');

// DOM Elements - Signatures Tab
const enableSignatureCheckbox = document.getElementById('enableSignatureCheckbox');
const signatureRotationSelect = document.getElementById('signatureRotationSelect');
const signaturesListContainer = document.getElementById('signaturesListContainer');
const addSignatureBtn = document.getElementById('addSignatureBtn');
const saveSignaturesBtn = document.getElementById('saveSignaturesBtn');
const sigStatusBanner = document.getElementById('sigStatusBanner');

// DOM Elements - Spam-Check Tab
const spamCheckEmailInput = document.getElementById('spamCheckEmailInput');
const clearSpamCheckInputBtn = document.getElementById('clearSpamCheckInputBtn');
const spamCheckUseTemplateCheckbox = document.getElementById('spamCheckUseTemplateCheckbox');
const syncTemplateBtn = document.getElementById('syncTemplateBtn');
const spamCheckSubject = document.getElementById('spamCheckSubject');
const spamCheckBody = document.getElementById('spamCheckBody');
const loadSpamCheckBtn = document.getElementById('loadSpamCheckBtn');
const spamCheckBanner = document.getElementById('spamCheckBanner');
const spamCheckCountBadge = document.getElementById('spamCheckCountBadge');
const startSpamCheckQueueBtn = document.getElementById('startSpamCheckQueueBtn');
const resetSpamCheckStatusBtn = document.getElementById('resetSpamCheckStatusBtn');
const clearAllSpamCheckBtn = document.getElementById('clearAllSpamCheckBtn');
const spamCheckQueueStatus = document.getElementById('spamCheckQueueStatus');
const spamCheckContainer = document.getElementById('spamCheckContainer');

// DOM Elements - Anti-Sleep & Keep PC Awake
const sectionAntiSleep = document.getElementById('sectionAntiSleep');
const antiSleepStatusPill = document.getElementById('antiSleepStatusPill');
const antiSleepStatusLabel = document.getElementById('antiSleepStatusLabel');
const antiSleepDurationSelect = document.getElementById('antiSleepDurationSelect');
const antiSleepCustomContainer = document.getElementById('antiSleepCustomContainer');
const antiSleepCustomMinutesInput = document.getElementById('antiSleepCustomMinutesInput');
const toggleAntiSleepBtn = document.getElementById('toggleAntiSleepBtn');
const antiSleepActiveInfo = document.getElementById('antiSleepActiveInfo');
const antiSleepCountdownText = document.getElementById('antiSleepCountdownText');
const antiSleepReasonText = document.getElementById('antiSleepReasonText');
const cancelAntiSleepQuickBtn = document.getElementById('cancelAntiSleepQuickBtn');
const autoKeepAwakeOnQueueCheckbox = document.getElementById('autoKeepAwakeOnQueueCheckbox');

// DOM Elements - Queue Monitor
const liveIndicator = document.getElementById('liveIndicator');
const liveStatusLabel = document.getElementById('liveStatusLabel');
const queueStatusMessage = document.getElementById('queueStatusMessage');
const progressBarFill = document.getElementById('progressBarFill');
const startQueueBtn = document.getElementById('startQueueBtn');
const stopQueueBtn = document.getElementById('stopQueueBtn');
const minDelayInput = document.getElementById('minDelayInput');
const maxDelayInput = document.getElementById('maxDelayInput');
const autoCloseTabInput = document.getElementById('autoCloseTabInput');
const inPageAutoSendInput = document.getElementById('inPageAutoSendInput');
const sendModeCard = document.getElementById('sendModeCard');
const sendModeBadge = document.getElementById('sendModeBadge');
const sendModeDesc = document.getElementById('sendModeDesc');

// DOM Elements - BCC Batch Mode
const enableBccModeInput = document.getElementById('enableBccModeInput');
const bccBatchSizeInput = document.getElementById('bccBatchSizeInput');
const rearrangeBccQueueBtn = document.getElementById('rearrangeBccQueueBtn');
const bccModeCard = document.getElementById('bccModeCard');
const bccModeBadge = document.getElementById('bccModeBadge');
const bccModeDesc = document.getElementById('bccModeDesc');
const bccSettingsContent = document.getElementById('bccSettingsContent');
const expandedBccBatches = new Set();

// DOM Elements - Gmail Confidential Mode
const confidentialModeCard = document.getElementById('confidentialModeCard');
const enableConfidentialModeInput = document.getElementById('enableConfidentialModeInput');
const confidentialModeBadge = document.getElementById('confidentialModeBadge');
const confidentialModeDesc = document.getElementById('confidentialModeDesc');
const confidentialSettingsContent = document.getElementById('confidentialSettingsContent');
const confidentialCoordsDetails = document.getElementById('confidentialCoordsDetails');
const coordsMode3PointBtn = document.getElementById('coordsMode3PointBtn');
const coordsMode2PointBtn = document.getElementById('coordsMode2PointBtn');
const pickConfidentialCoordsBtn = document.getElementById('pickConfidentialCoordsBtn');
const testConfidentialCoordsBtn = document.getElementById('testConfidentialCoordsBtn');
const clearConfidentialCoordsBtn = document.getElementById('clearConfidentialCoordsBtn');
const coordsGridContainer = document.getElementById('coordsGridContainer');
const coordsCardPoint1 = document.getElementById('coordsCardPoint1');
const coordsLabelPoint1 = document.getElementById('coordsLabelPoint1');
const coordsDisplayPoint1 = document.getElementById('coordsDisplayPoint1');
const coordsCardPoint2 = document.getElementById('coordsCardPoint2');
const coordsLabelPoint2 = document.getElementById('coordsLabelPoint2');
const coordsDisplayPoint2 = document.getElementById('coordsDisplayPoint2');
const coordsCardPoint3 = document.getElementById('coordsCardPoint3');
const coordsLabelPoint3 = document.getElementById('coordsLabelPoint3');
const coordsDisplayPoint3 = document.getElementById('coordsDisplayPoint3');
const confidentialCoordsDelay1Container = document.getElementById('confidentialCoordsDelay1Container');
const confidentialCoordsDelay1Label = document.getElementById('confidentialCoordsDelay1Label');
const confidentialCoordsDelay1Input = document.getElementById('confidentialCoordsDelay1Input');
const confidentialCoordsDelay2Container = document.getElementById('confidentialCoordsDelay2Container');
const confidentialCoordsDelay2Label = document.getElementById('confidentialCoordsDelay2Label');
const confidentialCoordsDelay2Input = document.getElementById('confidentialCoordsDelay2Input');
const layoutShowConfidentialMode = document.getElementById('layoutShowConfidentialMode');

// DOM Elements - Stats & Utilities
const statTotal = document.getElementById('statTotal');
const statPending = document.getElementById('statPending');
const statSent = document.getElementById('statSent');
const statError = document.getElementById('statError');
const searchInput = document.getElementById('searchInput');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportCsvQuickBtn = document.getElementById('exportCsvQuickBtn');
const resetStatusBtn = document.getElementById('resetStatusBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const moveSentToBottomBtn = document.getElementById('moveSentToBottomBtn');
const removeSentLeadsBtn = document.getElementById('removeSentLeadsBtn');
const leadsContainer = document.getElementById('leadsContainer');

// DOM Elements - Preview Modal
const previewModal = document.getElementById('previewModal');
const modalRecipient = document.getElementById('modalRecipient');
const modalSubject = document.getElementById('modalSubject');
const modalBody = document.getElementById('modalBody');
const modalCloseBtn = document.getElementById('modalCloseBtn');

// DOM Elements - Password Modal
const passwordModal = document.getElementById('passwordModal');
const passwordModalTitle = document.getElementById('passwordModalTitle');
const passwordModalPrompt = document.getElementById('passwordModalPrompt');
const passwordModalInput = document.getElementById('passwordModalInput');
const togglePasswordVisibilityBtn = document.getElementById('togglePasswordVisibilityBtn');
const passwordModalError = document.getElementById('passwordModalError');
const passwordModalCancelBtn = document.getElementById('passwordModalCancelBtn');
const passwordModalSubmitBtn = document.getElementById('passwordModalSubmitBtn');

// DOM Elements - Activation / Lock Screen
const activationScreen = document.getElementById('activationScreen');
const activationSubtitle = document.getElementById('activationSubtitle');
const activationDurationHint = document.getElementById('activationDurationHint');
const activationForm = document.getElementById('activationForm');
const activationPasswordInput = document.getElementById('activationPasswordInput');
const toggleActivationPasswordBtn = document.getElementById('toggleActivationPasswordBtn');
const activationErrorBanner = document.getElementById('activationErrorBanner');
const activateAppBtn = document.getElementById('activateAppBtn');

/**
 * Initialize on DOMContentLoaded
 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadInitialState();
  setupEventListeners();
  setupStorageListener();
});

/**
 * Load initial state from chrome.storage.local
 */
async function loadInitialState() {
  const data = await chrome.storage.local.get([
    'isAppActivated',
    'appActivatedAt',
    'leads',
    'spamCheckLeads',
    'queueState',
    'settings',
    'theme',
    'collapsedSections',
    'homepageLayout',
    'analytics',
    'jsonUnlocked',
    'keepJsonUnlocked',
    'csvTemplate',
    'filterSettings',
    'antiSleepState'
  ]);

  // 0. App Master Activation Check (30-day / 1-month validity)
  const now = Date.now();
  const storedActivatedAt = typeof data.appActivatedAt === 'number' ? data.appActivatedAt : null;
  const isExpired = storedActivatedAt ? (now - storedActivatedAt >= ACTIVATION_VALIDITY_MS) : true;

  if (data.isAppActivated === true && !isExpired) {
    isAppActivated = true;
    appActivatedAt = storedActivatedAt;
  } else {
    isAppActivated = false;
    appActivatedAt = null;
    if (data.isAppActivated === true && isExpired) {
      await chrome.storage.local.set({ isAppActivated: false });
    }
  }
  updateActivationUI(isAppActivated, storedActivatedAt);

  // 1. Theme
  if (data.theme) {
    currentTheme = data.theme;
  }
  applyTheme(currentTheme);

  // 2. Leads (Normal Campaign Leads)
  if (Array.isArray(data.leads)) {
    currentLeads = data.leads;
  }

  // 2b. Spam-Check Test Leads (Kept completely separate from campaign leads)
  if (Array.isArray(data.spamCheckLeads)) {
    currentSpamCheckLeads = data.spamCheckLeads;
  }

  // 3. Queue State
  if (data.queueState) {
    currentQueueState = data.queueState;
  }

  // 4. Settings & Signatures
  if (data.settings) {
    currentSettings = { ...currentSettings, ...data.settings };
  }
  minDelayInput.value = currentSettings.minDelaySec || 20;
  maxDelayInput.value = currentSettings.maxDelaySec || 40;
  autoCloseTabInput.checked = currentSettings.autoCloseTab !== false;
  updateSendModeUI(Boolean(currentSettings.inPageAutoSend));
  updateBccModeUI(Boolean(currentSettings.enableBccMode), currentSettings.bccBatchSize || 10);
  updateConfidentialModeUI(Boolean(currentSettings.enableConfidentialMode), currentSettings.confidentialCoordinates);

  enableSignatureCheckbox.checked = currentSettings.enableSignature === true;
  signatureRotationSelect.value = currentSettings.signatureRotationMode || 'sequential';
  renderSignaturesList();

  // 4b. Anti-Sleep State & Auto-wake
  if (data.antiSleepState) {
    currentAntiSleepState = data.antiSleepState;
  }
  if (autoKeepAwakeOnQueueCheckbox) {
    autoKeepAwakeOnQueueCheckbox.checked = currentSettings.keepAwakeDuringQueue !== false;
  }
  renderAntiSleepState(currentAntiSleepState);
  startAntiSleepCountdownTicker();

  // 5. Global Dispatch Analytics
  if (data.analytics) {
    currentAnalytics = data.analytics;
  }
  renderAnalyticsBoard(currentAnalytics);

  // 6. JSON Unlock State (Locked by default, CSV is default)
  keepJsonUnlocked = Boolean(data.keepJsonUnlocked);
  if (keepJsonUnlockedCheckbox) {
    keepJsonUnlockedCheckbox.checked = keepJsonUnlocked;
  }
  if (keepJsonUnlocked && data.jsonUnlocked) {
    unlockJsonTab(false);
  } else {
    lockJsonTab(false);
  }

  // 7. Collapsible States
  if (data.collapsedSections) {
    currentCollapsed = { ...currentCollapsed, ...data.collapsedSections };
  }
  applyCollapsedStates();

  // 8. Homepage Layout & Minimalism
  if (data.homepageLayout) {
    currentLayout = { ...currentLayout, ...data.homepageLayout };
  }
  applyLayout(currentLayout);

  // 9. Subject & Body Templates (Persisted)
  if (data.csvTemplate) {
    if (csvSubjectTemplate && data.csvTemplate.subject !== undefined) {
      csvSubjectTemplate.value = data.csvTemplate.subject;
    }
    if (csvBodyTemplate && data.csvTemplate.body !== undefined) {
      csvBodyTemplate.value = data.csvTemplate.body;
    }
  }

  // 9b. Multi-Content & Rotation Manager Setup
  if (!Array.isArray(currentSettings.subjectTemplates) || currentSettings.subjectTemplates.length === 0) {
    currentSettings.subjectTemplates = [csvSubjectTemplate ? csvSubjectTemplate.value : ''];
  }
  if (!Array.isArray(currentSettings.bodyTemplates) || currentSettings.bodyTemplates.length === 0) {
    currentSettings.bodyTemplates = [csvBodyTemplate ? csvBodyTemplate.value : ''];
  }
  if (rotationTargetSelect) {
    rotationTargetSelect.value = currentSettings.contentRotationTarget || 'both';
  }
  if (rotationModeSelect) {
    rotationModeSelect.value = currentSettings.contentRotationMode || 'sequential';
  }
  setTemplateMode(Boolean(currentSettings.enableMultiContent), false);
  renderMultiContentLists();

  // 10. Excel Filter & Prioritizer State
  if (data.filterSettings) {
    filterRules = Array.isArray(data.filterSettings.rules) ? data.filterSettings.rules : [];
    filterMatchMode = data.filterSettings.matchMode === 'OR' ? 'OR' : 'AND';
  }
  setFilterMatchMode(filterMatchMode, false);
  renderFilterRules();
  updateFilterMatchStats();
  updateDiscoveredCsvTagsFromLeads();

  renderAll();
}

/**
 * Real-time storage change listener
 */
function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.isAppActivated !== undefined || changes.appActivatedAt !== undefined) {
      const newActivated = changes.isAppActivated ? changes.isAppActivated.newValue === true : isAppActivated;
      const newActivatedAt = changes.appActivatedAt ? changes.appActivatedAt.newValue : appActivatedAt;
      const now = Date.now();
      const isExpired = newActivatedAt ? (now - newActivatedAt >= ACTIVATION_VALIDITY_MS) : true;
      isAppActivated = newActivated && !isExpired;
      appActivatedAt = isAppActivated ? newActivatedAt : null;
      updateActivationUI(isAppActivated, appActivatedAt);
    }

    if (changes.theme) {
      currentTheme = changes.theme.newValue || 'dark';
      applyTheme(currentTheme);
    }

    if (changes.leads) {
      const oldLeads = currentLeads;
      currentLeads = changes.leads.newValue || [];
      renderStats();
      updateFilterMatchStats();
      updateDiscoveredCsvTagsFromLeads();
      const isSameOrder =
        oldLeads.length === currentLeads.length &&
        oldLeads.every((l, i) => l.id === currentLeads[i]?.id);
      if (
        isSameOrder &&
        oldLeads.length > 0 &&
        leadsContainer.children.length > 0 &&
        !leadsContainer.querySelector('.empty-state')
      ) {
        updateExistingLeadRows(currentLeads);
      } else {
        renderLeadsList();
      }
    }

    if (changes.spamCheckLeads) {
      currentSpamCheckLeads = changes.spamCheckLeads.newValue || [];
      renderSpamCheckList();
    }

    if (changes.analytics) {
      currentAnalytics = changes.analytics.newValue || { lifetimeSent: 0, dailyHistory: {} };
      renderAnalyticsBoard(currentAnalytics);
    }

    if (changes.queueState) {
      currentQueueState = changes.queueState.newValue || {
        isRunning: false,
        statusMessage: 'Ready',
        countdownSec: null,
        nextSendAt: null
      };
      renderQueueStatus();
    }

    if (changes.settings) {
      currentSettings = { ...currentSettings, ...changes.settings.newValue };
      if (document.activeElement !== minDelayInput) {
        minDelayInput.value = currentSettings.minDelaySec || 20;
      }
      if (document.activeElement !== maxDelayInput) {
        maxDelayInput.value = currentSettings.maxDelaySec || 40;
      }
      if (document.activeElement !== autoCloseTabInput) {
        autoCloseTabInput.checked = currentSettings.autoCloseTab !== false;
      }
      if (document.activeElement !== inPageAutoSendInput) {
        updateSendModeUI(Boolean(currentSettings.inPageAutoSend));
      }
      if (document.activeElement !== enableBccModeInput && document.activeElement !== bccBatchSizeInput) {
        updateBccModeUI(Boolean(currentSettings.enableBccMode), currentSettings.bccBatchSize || 10);
      }
      if (document.activeElement !== enableConfidentialModeInput) {
        updateConfidentialModeUI(Boolean(currentSettings.enableConfidentialMode), currentSettings.confidentialCoordinates);
      }
      if (changes.settings.newValue?.keepAwakeDuringQueue !== undefined && autoKeepAwakeOnQueueCheckbox) {
        autoKeepAwakeOnQueueCheckbox.checked = currentSettings.keepAwakeDuringQueue !== false;
      }
      if (changes.settings.newValue?.enableMultiContent !== undefined) {
        setTemplateMode(Boolean(currentSettings.enableMultiContent), false);
      }
      if (changes.settings.newValue?.contentRotationTarget && rotationTargetSelect) {
        rotationTargetSelect.value = currentSettings.contentRotationTarget;
      }
      if (changes.settings.newValue?.contentRotationMode && rotationModeSelect) {
        rotationModeSelect.value = currentSettings.contentRotationMode;
      }
      updateRotationSummaryText();
      const isEditingMulti = document.activeElement && (
        (subjectsListContainer && subjectsListContainer.contains(document.activeElement)) ||
        (bodiesListContainer && bodiesListContainer.contains(document.activeElement))
      );
      if (!isEditingMulti) {
        renderMultiContentLists();
      }
    }

    if (changes.antiSleepState) {
      currentAntiSleepState = changes.antiSleepState.newValue || { isActive: false };
      renderAntiSleepState(currentAntiSleepState);
    }

    if (changes.collapsedSections) {
      currentCollapsed = { ...currentCollapsed, ...changes.collapsedSections.newValue };
      applyCollapsedStates();
    }

    if (changes.homepageLayout) {
      currentLayout = { ...currentLayout, ...changes.homepageLayout.newValue };
      applyLayout(currentLayout);
    }

    if (changes.csvTemplate) {
      const t = changes.csvTemplate.newValue;
      if (t) {
        if (csvSubjectTemplate && document.activeElement !== csvSubjectTemplate && t.subject !== undefined) {
          csvSubjectTemplate.value = t.subject;
        }
        if (csvBodyTemplate && document.activeElement !== csvBodyTemplate && t.body !== undefined) {
          csvBodyTemplate.value = t.body;
        }
      }
    }

    if (changes.filterSettings) {
      const fs = changes.filterSettings.newValue;
      if (fs) {
        filterRules = Array.isArray(fs.rules) ? fs.rules : [];
        filterMatchMode = fs.matchMode === 'OR' ? 'OR' : 'AND';
        setFilterMatchMode(filterMatchMode, false);
        // Do not destroy the DOM while the user is actively typing in a filter input
        const isEditingFilter = document.activeElement && filterRulesList && filterRulesList.contains(document.activeElement);
        if (!isEditingFilter) {
          renderFilterRules();
        }
        updateFilterMatchStats();
      }
    }
  });
}

/**
 * Event Listeners Setup
 */
function setupEventListeners() {
  // Master App Activation / Unlock
  if (activationForm) {
    activationForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleActivationSubmit();
    });
  }
  if (activateAppBtn) {
    activateAppBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleActivationSubmit();
    });
  }
  if (toggleActivationPasswordBtn && activationPasswordInput) {
    toggleActivationPasswordBtn.addEventListener('click', () => {
      const isPass = activationPasswordInput.type === 'password';
      activationPasswordInput.type = isPass ? 'text' : 'password';
      toggleActivationPasswordBtn.textContent = isPass ? '🔒' : '👁️';
    });
  }
  if (lockAppBtn) {
    lockAppBtn.addEventListener('click', async () => {
      isAppActivated = false;
      await chrome.storage.local.set({ isAppActivated: false });
      updateActivationUI(false, appActivatedAt);
      showBanner(statusBanner, 'Workspace locked. Master password required to re-open.', 'info');
    });
  }

  // Theme Toggle
  themeToggleBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    chrome.storage.local.set({ theme: currentTheme });
  });

  // Tab Navigation
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabPanels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const targetPanel = document.getElementById(btn.dataset.tab);
      if (targetPanel) targetPanel.classList.add('active');

      // Update badge in section header
      if (importModeBadge) {
        if (btn.dataset.tab === 'tab-json') importModeBadge.textContent = 'JSON Array';
        else if (btn.dataset.tab === 'tab-csv') importModeBadge.textContent = 'CSV Data';
      }
    });
  });

  // Initialize and apply Dock Mode from URL params or stored settings
  const dockUrlParams = new URLSearchParams(window.location.search);
  const currentDock = dockUrlParams.get('dock'); // 'window', 'inpage', etc.
  const currentPos = dockUrlParams.get('pos'); // 'left', 'bottom', 'right'

  if (currentPos === 'bottom') {
    document.body.classList.add('dock-bottom');
  }
  if (currentDock === 'inpage') {
    document.body.classList.add('dock-inpage');
    if (dockCloseBtn) dockCloseBtn.style.display = 'flex';
  } else if (currentDock === 'window') {
    if (dockCloseBtn) dockCloseBtn.style.display = 'flex';
  }

  // Update active state on dock buttons
  function updateDockButtonsActiveState() {
    [dockPopoutBtn, dockLeftBtn, dockBottomBtn, dockRightBtn, dockSidePanelBtn].forEach((btn) => {
      btn?.classList.remove('active');
    });

    if (currentDock === 'window') {
      dockPopoutBtn?.classList.add('active');
    } else if (currentDock === 'inpage') {
      if (currentPos === 'left') dockLeftBtn?.classList.add('active');
      else if (currentPos === 'bottom') dockBottomBtn?.classList.add('active');
      else dockRightBtn?.classList.add('active');
    } else {
      chrome.storage.local.get('dockMode').then(({ dockMode }) => {
        if (dockMode === 'sidepanel') dockSidePanelBtn?.classList.add('active');
      });
    }
  }
  updateDockButtonsActiveState();

  // DevTools Dock Event Listeners
  if (dockPopoutBtn) {
    dockPopoutBtn.addEventListener('click', async () => {
      showBanner(statusBanner, 'Opening in separate floating window...', 'info');
      try {
        const res = await chrome.runtime.sendMessage({ action: 'DOCK_POPOUT' });
        if (res?.success) {
          if (currentDock === 'inpage') {
            await chrome.runtime.sendMessage({ action: 'CLOSE_INPAGE_DOCK' });
          } else if (currentDock !== 'window') {
            window.close();
          }
        }
      } catch (err) {
        showBanner(statusBanner, `Error opening popout: ${err.message}`, 'error');
      }
    });
  }

  if (dockLeftBtn) {
    dockLeftBtn.addEventListener('click', async () => {
      showBanner(statusBanner, 'Docking to left of Gmail...', 'info');
      try {
        const res = await chrome.runtime.sendMessage({ action: 'DOCK_INPAGE', position: 'left' });
        if (res?.success) {
          if (currentDock !== 'inpage') window.close();
        } else {
          showBanner(statusBanner, res?.error || 'Failed to dock in-page. Open Gmail first.', 'error');
        }
      } catch (err) {
        showBanner(statusBanner, `Error docking: ${err.message}`, 'error');
      }
    });
  }

  if (dockBottomBtn) {
    dockBottomBtn.addEventListener('click', async () => {
      showBanner(statusBanner, 'Docking to bottom of Gmail...', 'info');
      try {
        const res = await chrome.runtime.sendMessage({ action: 'DOCK_INPAGE', position: 'bottom' });
        if (res?.success) {
          if (currentDock !== 'inpage') window.close();
        } else {
          showBanner(statusBanner, res?.error || 'Failed to dock in-page. Open Gmail first.', 'error');
        }
      } catch (err) {
        showBanner(statusBanner, `Error docking: ${err.message}`, 'error');
      }
    });
  }

  if (dockRightBtn) {
    dockRightBtn.addEventListener('click', async () => {
      showBanner(statusBanner, 'Docking to right of Gmail...', 'info');
      try {
        const res = await chrome.runtime.sendMessage({ action: 'DOCK_INPAGE', position: 'right' });
        if (res?.success) {
          if (currentDock !== 'inpage') window.close();
        } else {
          showBanner(statusBanner, res?.error || 'Failed to dock in-page. Open Gmail first.', 'error');
        }
      } catch (err) {
        showBanner(statusBanner, `Error docking: ${err.message}`, 'error');
      }
    });
  }

  if (dockSidePanelBtn) {
    dockSidePanelBtn.addEventListener('click', async () => {
      try {
        if (currentDock === 'inpage') {
          await chrome.runtime.sendMessage({ action: 'CLOSE_INPAGE_DOCK' });
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.windowId && chrome.sidePanel && chrome.sidePanel.open) {
          await chrome.sidePanel.open({ windowId: tab.windowId });
          await chrome.storage.local.set({ dockMode: 'sidepanel' });
          if (currentDock !== 'inpage') window.close();
        } else {
          await chrome.runtime.sendMessage({ action: 'OPEN_SIDE_PANEL' });
          if (currentDock !== 'inpage') window.close();
        }
      } catch (err) {
        console.warn('Could not open side panel:', err);
      }
    });
  }

  if (dockCloseBtn) {
    dockCloseBtn.addEventListener('click', async () => {
      if (currentDock === 'inpage') {
        await chrome.runtime.sendMessage({ action: 'CLOSE_INPAGE_DOCK' });
      } else {
        window.close();
      }
    });
  }

  // JSON & Plain Text Batch Events
  loadLeadsBtn.addEventListener('click', handleLoadJsonLeads);

  clearInputBtn.addEventListener('click', () => {
    jsonInput.value = '';
    hideBanner(statusBanner);
  });

  if (uploadJsonFileBtn && jsonFileInput) {
    uploadJsonFileBtn.addEventListener('click', () => jsonFileInput.click());
    jsonFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleBatchTextFile(e.target.files[0]);
      }
      jsonFileInput.value = '';
    });
  }

  // Drag & drop file support directly on batch input textarea
  jsonInput.addEventListener('dragover', (e) => {
    e.preventDefault();
    jsonInput.classList.add('dragover');
  });
  jsonInput.addEventListener('dragleave', () => {
    jsonInput.classList.remove('dragover');
  });
  jsonInput.addEventListener('drop', (e) => {
    e.preventDefault();
    jsonInput.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleBatchTextFile(e.dataTransfer.files[0]);
    }
  });

  // CSV Tab Events - Dropzone & File Input
  csvDropzone.addEventListener('click', () => csvFileInput.click());
  csvDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    csvDropzone.classList.add('dragover');
  });
  csvDropzone.addEventListener('dragleave', () => csvDropzone.classList.remove('dragover'));
  csvDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    csvDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleCsvFile(e.dataTransfer.files[0]);
    }
  });
  csvFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleCsvFile(e.target.files[0]);
    }
  });

  let csvInputDebounce = null;
  csvInput.addEventListener('input', () => {
    clearTimeout(csvInputDebounce);
    csvInputDebounce = setTimeout(() => {
      updateDiscoveredCsvTags(csvInput.value);
    }, 150);
  });

  clearCsvBtn.addEventListener('click', () => {
    csvInput.value = '';
    csvFileInput.value = '';
    updateDiscoveredCsvTags('');
    hideBanner(csvStatusBanner);
  });

  loadCsvLeadsBtn.addEventListener('click', handleLoadCsvLeads);

  // Template tag click helper (inserts {tag} into focused input)
  csvSubjectTemplate.addEventListener('focus', () => { lastFocusedTemplateInput = csvSubjectTemplate; });
  csvBodyTemplate.addEventListener('focus', () => { lastFocusedTemplateInput = csvBodyTemplate; });

  // Template auto-save on typing (debounced)
  let csvTemplateDebounce = null;
  const handleTemplateInputAutoSave = () => {
    clearTimeout(csvTemplateDebounce);
    csvTemplateDebounce = setTimeout(async () => {
      const subject = csvSubjectTemplate ? csvSubjectTemplate.value : '';
      const body = csvBodyTemplate ? csvBodyTemplate.value : '';
      await chrome.storage.local.set({ csvTemplate: { subject, body } });
    }, 300);
  };
  if (csvSubjectTemplate) csvSubjectTemplate.addEventListener('input', handleTemplateInputAutoSave);
  if (csvBodyTemplate) csvBodyTemplate.addEventListener('input', handleTemplateInputAutoSave);

  // Multi-Content Mode & Rotation Listeners
  if (modeSingleBtn) {
    modeSingleBtn.addEventListener('click', () => setTemplateMode(false));
  }
  if (modeMultiBtn) {
    modeMultiBtn.addEventListener('click', () => setTemplateMode(true));
  }
  if (rotationTargetSelect) {
    rotationTargetSelect.addEventListener('change', async () => {
      currentSettings.contentRotationTarget = rotationTargetSelect.value;
      updateRotationSummaryText();
      await chrome.storage.local.set({ settings: currentSettings });
    });
  }
  if (rotationModeSelect) {
    rotationModeSelect.addEventListener('change', async () => {
      currentSettings.contentRotationMode = rotationModeSelect.value;
      updateRotationSummaryText();
      await chrome.storage.local.set({ settings: currentSettings });
    });
  }
  if (addSubjectBtn) {
    addSubjectBtn.addEventListener('click', () => {
      currentSettings.subjectTemplates = currentSettings.subjectTemplates || [];
      currentSettings.subjectTemplates.push('');
      renderMultiContentLists();
      debouncedSaveMultiContent();
    });
  }
  if (addBodyBtn) {
    addBodyBtn.addEventListener('click', () => {
      currentSettings.bodyTemplates = currentSettings.bodyTemplates || [];
      currentSettings.bodyTemplates.push('');
      renderMultiContentLists();
      debouncedSaveMultiContent();
    });
  }

  // Anti-Sleep / Keep PC Awake Listeners
  if (antiSleepDurationSelect) {
    antiSleepDurationSelect.addEventListener('change', () => {
      if (antiSleepCustomContainer) {
        antiSleepCustomContainer.style.display = antiSleepDurationSelect.value === 'custom' ? 'block' : 'none';
      }
    });
  }
  if (toggleAntiSleepBtn) {
    toggleAntiSleepBtn.addEventListener('click', handleToggleAntiSleep);
  }
  if (cancelAntiSleepQuickBtn) {
    cancelAntiSleepQuickBtn.addEventListener('click', handleToggleAntiSleep);
  }
  if (autoKeepAwakeOnQueueCheckbox) {
    autoKeepAwakeOnQueueCheckbox.addEventListener('change', async () => {
      currentSettings.keepAwakeDuringQueue = autoKeepAwakeOnQueueCheckbox.checked;
      await chrome.storage.local.set({ settings: currentSettings });
    });
  }

  // Sync Content to Loaded Leads
  if (syncContentToLeadsBtn) {
    syncContentToLeadsBtn.addEventListener('click', handleSyncContentToLeads);
  }

  // Excel-Style Filter & Prioritizer Controls
  if (filterMatchAndBtn) {
    filterMatchAndBtn.addEventListener('click', () => setFilterMatchMode('AND'));
  }
  if (filterMatchOrBtn) {
    filterMatchOrBtn.addEventListener('click', () => setFilterMatchMode('OR'));
  }
  if (addFilterRuleBtn) {
    addFilterRuleBtn.addEventListener('click', () => addFilterRule());
  }
  if (clearFilterRulesBtn) {
    clearFilterRulesBtn.addEventListener('click', handleClearFilterRules);
  }
  if (toggleFilterViewBtn) {
    toggleFilterViewBtn.addEventListener('click', handleToggleFilterView);
  }
  if (prioritizeLeadsBtn) {
    prioritizeLeadsBtn.addEventListener('click', handlePrioritizeLeads);
  }
  if (filterRulesList) {
    filterRulesList.addEventListener('change', handleFilterRuleChange);
    filterRulesList.addEventListener('input', handleFilterRuleInput);
    filterRulesList.addEventListener('click', handleFilterRuleClick);
  }

  csvTagsList.addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (chip && chip.dataset.tag) {
      insertTagIntoTemplate(chip.dataset.tag);
    }
  });

  // Signatures Events
  addSignatureBtn.addEventListener('click', () => {
    currentSettings.signatures = currentSettings.signatures || [];
    currentSettings.signatures.push("Best regards,\nYour Name");
    renderSignaturesList();
  });

  saveSignaturesBtn.addEventListener('click', saveSignaturesSettings);
  enableSignatureCheckbox.addEventListener('change', saveSignaturesSettings);
  signatureRotationSelect.addEventListener('change', saveSignaturesSettings);

  // Spam-Check Event Handlers
  if (clearSpamCheckInputBtn) {
    clearSpamCheckInputBtn.addEventListener('click', () => {
      if (spamCheckEmailInput) spamCheckEmailInput.value = '';
      hideBanner(spamCheckBanner);
    });
  }

  if (syncTemplateBtn) {
    syncTemplateBtn.addEventListener('click', () => {
      syncSpamCheckTemplateFromCsv(true);
      showBanner(spamCheckBanner, 'Subject and Body synchronized from CSV template.', 'success');
    });
  }

  if (loadSpamCheckBtn) {
    loadSpamCheckBtn.addEventListener('click', handleLoadSpamCheck);
  }

  if (startSpamCheckQueueBtn) {
    startSpamCheckQueueBtn.addEventListener('click', async () => {
      hideBanner(spamCheckBanner);
      const res = await chrome.runtime.sendMessage({ action: 'START_SPAM_CHECK_QUEUE' });
      if (res && !res.success) {
        showBanner(spamCheckBanner, res.error || 'Failed to dispatch test emails.', 'error');
      } else {
        showBanner(spamCheckBanner, 'Dispatched test emails sequentially in background.', 'success');
      }
    });
  }

  if (resetSpamCheckStatusBtn) {
    resetSpamCheckStatusBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'RESET_SPAM_CHECK_STATUSES' });
      showBanner(spamCheckBanner, 'All test lead statuses reset to pending.', 'success');
    });
  }

  if (clearAllSpamCheckBtn) {
    clearAllSpamCheckBtn.addEventListener('click', async () => {
      if (confirm('Clear all loaded spam-check test emails?')) {
        await chrome.runtime.sendMessage({ action: 'CLEAR_SPAM_CHECK_ALL' });
        showBanner(spamCheckBanner, 'All spam-check test leads cleared.', 'success');
      }
    });
  }

  // Delegated click listener on spamCheckContainer (Fast, no per-row listener overhead)
  if (spamCheckContainer) {
    spamCheckContainer.addEventListener('click', (e) => {
      const badgeEl = e.target.closest('.status-toggle-badge');
      if (badgeEl && badgeEl.dataset.id) {
        handleToggleSpamCheckStatus(badgeEl.dataset.id);
        return;
      }
      const viewBtn = e.target.closest('.view-body-btn');
      if (viewBtn && viewBtn.dataset.id) {
        const lead = currentSpamCheckLeads.find((l) => l.id === viewBtn.dataset.id);
        if (lead) openPreviewModal(lead);
        return;
      }
      const composeBtn = e.target.closest('.compose-btn');
      if (composeBtn && composeBtn.dataset.id) {
        const lead = currentSpamCheckLeads.find((l) => l.id === composeBtn.dataset.id);
        if (lead) handleManualCompose(lead);
        return;
      }
      const autoSendBtn = e.target.closest('.auto-send-btn');
      if (autoSendBtn && autoSendBtn.dataset.id) {
        handleSingleAutoSend(autoSendBtn.dataset.id, true);
        return;
      }
      const deleteBtn = e.target.closest('.delete-lead-btn');
      if (deleteBtn && deleteBtn.dataset.id) {
        handleDeleteSpamCheckLead(deleteBtn.dataset.id);
        return;
      }
    });
  }

  // Queue Controls
  startQueueBtn.addEventListener('click', async () => {
    hideBanner(statusBanner);
    const response = await chrome.runtime.sendMessage({ action: 'START_QUEUE' });
    if (response && !response.success) {
      showBanner(statusBanner, response.error || 'Failed to start queue.', 'error');
    }
  });

  stopQueueBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'STOP_QUEUE' });
  });

  // Delay settings auto-save
  const saveDelaySettings = async () => {
    const minVal = Math.max(5, parseInt(minDelayInput.value, 10) || 20);
    let maxVal = Math.max(minVal, parseInt(maxDelayInput.value, 10) || 40);
    if (maxVal < minVal) maxVal = minVal;

    currentSettings = {
      ...currentSettings,
      minDelaySec: minVal,
      maxDelaySec: maxVal,
      autoCloseTab: autoCloseTabInput.checked
    };
    await chrome.storage.local.set({ settings: currentSettings });
  };

  minDelayInput.addEventListener('change', saveDelaySettings);
  maxDelayInput.addEventListener('change', saveDelaySettings);
  autoCloseTabInput.addEventListener('change', saveDelaySettings);

  // In-Page Auto-Send Switch Toggle
  if (inPageAutoSendInput) {
    inPageAutoSendInput.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      currentSettings = {
        ...currentSettings,
        inPageAutoSend: enabled
      };
      updateSendModeUI(enabled);
      await chrome.storage.local.set({ settings: currentSettings });
      showBanner(
        statusBanner,
        enabled
          ? 'Auto-Send set to In-Page mode (like manual + auto click Send).'
          : 'Auto-Send set to Original mode (standalone compose tab).',
        'success'
      );
    });
  }

  // BCC Batch Mode Switch Toggle
  if (enableBccModeInput) {
    enableBccModeInput.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      currentSettings = {
        ...currentSettings,
        enableBccMode: enabled
      };
      updateBccModeUI(enabled, currentSettings.bccBatchSize || 10);
      await chrome.storage.local.set({ settings: currentSettings });
      renderLeadsList();
      showBanner(
        statusBanner,
        enabled
          ? `BCC Batch Mode enabled (${currentSettings.bccBatchSize || 10} leads at a go).`
          : 'BCC Batch Mode disabled (1-by-1 sending).',
        'success'
      );
    });
  }

  // BCC Rearrange Queue Button
  if (rearrangeBccQueueBtn) {
    rearrangeBccQueueBtn.addEventListener('click', async () => {
      const rawVal = bccBatchSizeInput ? parseInt(bccBatchSizeInput.value, 10) : 10;
      const val = Math.max(2, Math.min(100, isNaN(rawVal) ? 10 : rawVal));
      if (bccBatchSizeInput) bccBatchSizeInput.value = val;

      currentSettings = {
        ...currentSettings,
        enableBccMode: true,
        bccBatchSize: val
      };
      if (enableBccModeInput) enableBccModeInput.checked = true;
      updateBccModeUI(true, val);
      await chrome.storage.local.set({ settings: currentSettings });
      renderLeadsList();

      const pendingCount = currentLeads.filter((l) => l.status === 'pending').length;
      const batchCount = Math.ceil(pendingCount / val);
      showBanner(
        statusBanner,
        `⚡ Queue rearranged! Compiled ${pendingCount} pending lead(s) into ${batchCount} BCC batch(es) of up to ${val} leads each.`,
        'success'
      );
    });
  }

  // BCC Batch Size Input
  if (bccBatchSizeInput) {
    bccBatchSizeInput.addEventListener('change', async (e) => {
      const val = Math.max(2, Math.min(100, parseInt(e.target.value, 10) || 10));
      e.target.value = val;
      currentSettings = {
        ...currentSettings,
        bccBatchSize: val
      };
      updateBccModeUI(Boolean(currentSettings.enableBccMode), val);
      await chrome.storage.local.set({ settings: currentSettings });
      if (currentSettings.enableBccMode) {
        renderLeadsList();
      }
    });
  }

  // Gmail Confidential Mode Switch Toggle
  if (enableConfidentialModeInput) {
    enableConfidentialModeInput.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      currentSettings = {
        ...currentSettings,
        enableConfidentialMode: enabled
      };
      updateConfidentialModeUI(enabled, currentSettings.confidentialCoordinates);
      await chrome.storage.local.set({ settings: currentSettings });
      if (enabled) {
        if (!currentSettings.confidentialCoordinates || !currentSettings.confidentialCoordinates.point1) {
          showBanner(statusBanner, '🔒 Confidential Mode enabled! Please click "🎯 Calibrate on Gmail" below to set your click points.', 'info');
        } else {
          showBanner(statusBanner, '🔒 Confidential Mode enabled (using calibrated coordinates).', 'success');
        }
      } else {
        showBanner(statusBanner, 'Gmail Confidential Mode disabled.', 'info');
      }
    });
  }

  if (coordsMode3PointBtn) {
    coordsMode3PointBtn.addEventListener('click', async () => {
      currentSettings.confidentialCoordinates = {
        ...(currentSettings.confidentialCoordinates || {}),
        mode: '3point'
      };
      updateConfidentialCoordsUI(currentSettings.confidentialCoordinates);
      await chrome.storage.local.set({ settings: currentSettings });
      showBanner(statusBanner, 'Switched to 3-Point Calibration Mode (3-Dot Menu -> Confidential Item -> Save Button).', 'info');
    });
  }

  if (coordsMode2PointBtn) {
    coordsMode2PointBtn.addEventListener('click', async () => {
      currentSettings.confidentialCoordinates = {
        ...(currentSettings.confidentialCoordinates || {}),
        mode: '2point'
      };
      updateConfidentialCoordsUI(currentSettings.confidentialCoordinates);
      await chrome.storage.local.set({ settings: currentSettings });
      showBanner(statusBanner, 'Switched to 2-Point Calibration Mode (Direct Toolbar Button -> Save Button).', 'info');
    });
  }

  if (pickConfidentialCoordsBtn) {
    pickConfidentialCoordsBtn.addEventListener('click', async () => {
      const mode = currentSettings.confidentialCoordinates?.mode || '3point';
      showBanner(statusBanner, `🎯 Opening ${mode === '3point' ? '3-Point (3-Dot)' : '2-Point'} Calibrator HUD on Gmail... Switch to your Gmail tab to calibrate.`, 'info');
      const response = await chrome.runtime.sendMessage({ 
        action: 'START_COORDINATE_PICKER',
        mode
      });
      if (!response?.success) {
        showBanner(statusBanner, response?.error || 'Failed to start coordinate calibrator.', 'error');
      }
    });
  }

  if (testConfidentialCoordsBtn) {
    testConfidentialCoordsBtn.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ action: 'TEST_CONFIDENTIAL_COORDS' });
      if (!response?.success) {
        showBanner(statusBanner, response?.error || 'Could not test coordinates.', 'error');
      } else {
        showBanner(statusBanner, '⚡ Dispatched test coordinate clicks to your Gmail window!', 'success');
      }
    });
  }

  if (clearConfidentialCoordsBtn) {
    clearConfidentialCoordsBtn.addEventListener('click', async () => {
      const mode = currentSettings.confidentialCoordinates?.mode || '3point';
      currentSettings = {
        ...currentSettings,
        confidentialCoordinates: {
          mode,
          point1: null,
          point2: null,
          point3: null,
          delayMs: 350,
          delay1Ms: 350,
          delay2Ms: 400
        }
      };
      updateConfidentialCoordsUI(currentSettings.confidentialCoordinates);
      await chrome.storage.local.set({ settings: currentSettings });
      showBanner(statusBanner, 'Custom coordinates reset.', 'info');
    });
  }

  if (confidentialCoordsDelay1Input) {
    confidentialCoordsDelay1Input.addEventListener('change', async (e) => {
      const ms = Math.max(100, Math.min(3000, parseInt(e.target.value, 10) || 350));
      currentSettings.confidentialCoordinates = {
        ...(currentSettings.confidentialCoordinates || {}),
        delay1Ms: ms,
        delayMs: ms
      };
      await chrome.storage.local.set({ settings: currentSettings });
    });
  }

  if (confidentialCoordsDelay2Input) {
    confidentialCoordsDelay2Input.addEventListener('change', async (e) => {
      const ms = Math.max(100, Math.min(3000, parseInt(e.target.value, 10) || 400));
      currentSettings.confidentialCoordinates = {
        ...(currentSettings.confidentialCoordinates || {}),
        delay2Ms: ms
      };
      await chrome.storage.local.set({ settings: currentSettings });
    });
  }

  // Search Filter (Debounced to keep UI snappy)
  let searchDebounceTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentFilter = (e.target.value || '').trim().toLowerCase();
      renderLeadsList();
    }, 120);
  });

  // Delegated click listener on leadsContainer (Ultra-fast, eliminates hundreds of per-row closures)
  leadsContainer.addEventListener('click', (e) => {
    // BCC Batch Actions
    const composeBccBtn = e.target.closest('.compose-bcc-batch-btn');
    if (composeBccBtn && composeBccBtn.dataset.batchIds) {
      const ids = composeBccBtn.dataset.batchIds.split(',').filter(Boolean);
      handleComposeBccBatch(ids);
      return;
    }

    const sendBccBtn = e.target.closest('.send-bcc-batch-btn');
    if (sendBccBtn && sendBccBtn.dataset.batchIds) {
      const ids = sendBccBtn.dataset.batchIds.split(',').filter(Boolean);
      handleSendBccBatch(ids);
      return;
    }

    const viewBccBodyBtn = e.target.closest('.view-bcc-body-btn');
    if (viewBccBodyBtn && viewBccBodyBtn.dataset.leadId) {
      const lead = currentLeads.find((l) => l.id === viewBccBodyBtn.dataset.leadId);
      if (lead) openPreviewModal(lead);
      return;
    }

    const toggleExpandBtn = e.target.closest('.toggle-bcc-expand-btn');
    if (toggleExpandBtn && toggleExpandBtn.dataset.batchIndex !== undefined) {
      const bIdx = parseInt(toggleExpandBtn.dataset.batchIndex, 10);
      if (expandedBccBatches.has(bIdx)) {
        expandedBccBatches.delete(bIdx);
      } else {
        expandedBccBatches.add(bIdx);
      }
      renderLeadsList();
      return;
    }

    const badgeEl = e.target.closest('.status-toggle-badge');
    if (badgeEl && badgeEl.dataset.id) {
      handleToggleLeadStatus(badgeEl.dataset.id);
      return;
    }
    const viewBtn = e.target.closest('.view-body-btn');
    if (viewBtn && viewBtn.dataset.id) {
      const lead = currentLeads.find((l) => l.id === viewBtn.dataset.id);
      if (lead) openPreviewModal(lead);
      return;
    }
    const composeBtn = e.target.closest('.compose-btn');
    if (composeBtn && composeBtn.dataset.id) {
      const lead = currentLeads.find((l) => l.id === composeBtn.dataset.id);
      if (lead) handleManualCompose(lead);
      return;
    }
    const autoSendBtn = e.target.closest('.auto-send-btn');
    if (autoSendBtn && autoSendBtn.dataset.id) {
      handleSingleAutoSend(autoSendBtn.dataset.id);
      return;
    }
    const deleteBtn = e.target.closest('.delete-lead-btn');
    if (deleteBtn && deleteBtn.dataset.id) {
      handleDeleteLead(deleteBtn.dataset.id);
      return;
    }
    const showAllBtn = e.target.closest('#showAllLeadsBtn');
    if (showAllBtn) {
      leadsDisplayLimit = Infinity;
      renderLeadsList();
      return;
    }
  });

  // CSV Report Export
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', handleExportReportCsv);
  if (exportCsvQuickBtn) exportCsvQuickBtn.addEventListener('click', handleExportReportCsv);

  // Reset Statuses
  resetStatusBtn.addEventListener('click', async () => {
    if (confirm('Reset all sent and error leads back to "pending"?')) {
      await chrome.runtime.sendMessage({ action: 'RESET_STATUSES' });
      showBanner(statusBanner, 'All lead statuses reset to pending.', 'success');
    }
  });

  // Clear All Leads
  clearAllBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all leads?')) {
      await chrome.runtime.sendMessage({ action: 'CLEAR_ALL' });
      showBanner(statusBanner, 'All leads cleared.', 'success');
    }
  });

  // Move Sent Leads to Bottom
  if (moveSentToBottomBtn) {
    moveSentToBottomBtn.addEventListener('click', async () => {
      const sentLeads = currentLeads.filter((l) => l.status === 'sent');
      if (sentLeads.length === 0) {
        showBanner(statusBanner, 'No sent leads in the queue to move.', 'info');
        return;
      }

      const firstSentIdx = currentLeads.findIndex((l) => l.status === 'sent');
      const lastUnsentIdx = currentLeads.reduce((acc, l, idx) => (l.status !== 'sent' ? idx : acc), -1);

      if (lastUnsentIdx === -1 || firstSentIdx > lastUnsentIdx) {
        showBanner(statusBanner, 'Sent leads are already positioned at the bottom of the queue.', 'info');
        return;
      }

      const unsent = currentLeads.filter((l) => l.status !== 'sent');
      const reordered = [...unsent, ...sentLeads];

      currentLeads = reordered;
      renderLeadsList();

      await chrome.runtime.sendMessage({ action: 'MOVE_SENT_TO_BOTTOM' });
      showBanner(
        statusBanner,
        `✓ Moved ${sentLeads.length} sent lead${sentLeads.length === 1 ? '' : 's'} to the bottom. Unsent leads are at the top.`,
        'success'
      );
    });
  }

  // Remove Sent Leads from Queue
  if (removeSentLeadsBtn) {
    removeSentLeadsBtn.addEventListener('click', async () => {
      const sentLeads = currentLeads.filter((l) => l.status === 'sent');
      if (sentLeads.length === 0) {
        showBanner(statusBanner, 'No sent leads in the queue to remove.', 'info');
        return;
      }

      const confirmMsg = `Remove ${sentLeads.length} sent lead${sentLeads.length === 1 ? '' : 's'} from the queue?\n(All pending and error leads will be preserved).`;
      if (!confirm(confirmMsg)) {
        return;
      }

      const remaining = currentLeads.filter((l) => l.status !== 'sent');
      currentLeads = remaining;
      renderStats();
      updateFilterMatchStats();
      renderLeadsList();

      await chrome.runtime.sendMessage({ action: 'REMOVE_SENT_LEADS' });
      showBanner(
        statusBanner,
        `✓ Removed ${sentLeads.length} sent lead${sentLeads.length === 1 ? '' : 's'} from the queue.`,
        'success'
      );
    });
  }

  // Modal Close
  modalCloseBtn.addEventListener('click', () => previewModal.classList.remove('open'));
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) previewModal.classList.remove('open');
  });

  // Collapsible Section Headers Click Event
  document.querySelectorAll('.section-collapse-header').forEach((hdr) => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('#toggleDensityBtn')) return;
      const targetId = hdr.getAttribute('data-collapse-target');
      if (!targetId) return;
      const targetEl = document.getElementById(targetId);
      if (!targetEl) return;
      const isNowCollapsed = !targetEl.classList.contains('collapsed');
      targetEl.classList.toggle('collapsed', isNowCollapsed);
      currentCollapsed[targetId] = isNowCollapsed;
      chrome.storage.local.set({ collapsedSections: currentCollapsed });
    });
  });

  // Sub-Collapsible for Delay Timing inside Queue
  if (toggleDelaySettingsBtn && delaySettingsContent) {
    toggleDelaySettingsBtn.addEventListener('click', () => {
      const isNowCollapsed = !delaySettingsContent.classList.contains('collapsed');
      delaySettingsContent.classList.toggle('collapsed', isNowCollapsed);
      toggleDelaySettingsBtn.classList.toggle('collapsed', isNowCollapsed);
      currentCollapsed.delaySettings = isNowCollapsed;
      chrome.storage.local.set({ collapsedSections: currentCollapsed });
    });
  }

  const updateDelaySummary = () => {
    if (delaySummaryText && minDelayInput && maxDelayInput) {
      delaySummaryText.textContent = `${minDelayInput.value}s - ${maxDelayInput.value}s`;
    }
  };
  minDelayInput.addEventListener('input', updateDelaySummary);
  maxDelayInput.addEventListener('input', updateDelaySummary);
  updateDelaySummary();

  // Density Toggle Button in Leads Header
  if (toggleDensityBtn) {
    toggleDensityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentLayout.density = currentLayout.density === 'compact' ? 'standard' : 'compact';
      applyLayout(currentLayout);
      chrome.storage.local.set({ homepageLayout: currentLayout });
    });
  }

  // Secret Developer Trigger: Clicking Midey Brand Header
  if (brandSecretTrigger) {
    brandSecretTrigger.addEventListener('click', () => {
      if (isJsonUnlocked) {
        activateTab('tab-json');
      } else {
        promptForPassword({
          title: 'Unlock JSON Array Mode',
          promptText: 'Enter developer authorization password to reveal JSON array mode:',
          onSuccess: () => {
            unlockJsonTab(true);
            showBanner(statusBanner, 'Developer JSON mode unlocked!', 'success');
          }
        });
      }
    });
  }

  // Keep JSON Unlocked Checkbox
  if (keepJsonUnlockedCheckbox) {
    keepJsonUnlockedCheckbox.addEventListener('change', async (e) => {
      keepJsonUnlocked = e.target.checked;
      await chrome.storage.local.set({ keepJsonUnlocked });
      if (!keepJsonUnlocked) {
        await chrome.storage.local.set({ jsonUnlocked: false });
      } else if (isJsonUnlocked) {
        await chrome.storage.local.set({ jsonUnlocked: true });
      }
    });
  }

  // Lock & Re-hide JSON Mode Button
  if (lockJsonBtn) {
    lockJsonBtn.addEventListener('click', () => {
      lockJsonTab(true);
      showBanner(csvStatusBanner, 'JSON mode locked and hidden.', 'success');
    });
  }

  // Reset Analytics & Counters Button (Password Protected)
  if (resetAnalyticsBtn) {
    resetAnalyticsBtn.addEventListener('click', () => {
      handleResetAnalytics();
    });
  }

  // Password Modal Event Listeners
  if (passwordModalCloseBtn) passwordModalCloseBtn.addEventListener('click', closePasswordModal);
  if (passwordModalCancelBtn) passwordModalCancelBtn.addEventListener('click', closePasswordModal);
  if (passwordModalSubmitBtn) passwordModalSubmitBtn.addEventListener('click', handlePasswordSubmit);
  if (passwordModal) {
    passwordModal.addEventListener('click', (e) => {
      if (e.target === passwordModal) closePasswordModal();
    });
  }
  if (passwordModalInput) {
    passwordModalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePasswordSubmit();
      if (e.key === 'Escape') closePasswordModal();
    });
  }
  if (togglePasswordVisibilityBtn && passwordModalInput) {
    togglePasswordVisibilityBtn.addEventListener('click', () => {
      const isPass = passwordModalInput.type === 'password';
      passwordModalInput.type = isPass ? 'text' : 'password';
      togglePasswordVisibilityBtn.textContent = isPass ? '🔒' : '👁️';
    });
  }

  // Layout Modal Events
  if (layoutSettingsBtn) layoutSettingsBtn.addEventListener('click', openLayoutModal);
  if (layoutModalCloseBtn) layoutModalCloseBtn.addEventListener('click', closeLayoutModal);
  if (layoutModalDoneBtn) layoutModalDoneBtn.addEventListener('click', closeLayoutModal);
  if (quickCustomizeLayoutBtn) quickCustomizeLayoutBtn.addEventListener('click', openLayoutModal);
  if (layoutModal) {
    layoutModal.addEventListener('click', (e) => {
      if (e.target === layoutModal) closeLayoutModal();
    });
  }

  const handleLayoutCheckboxChange = async () => {
    currentLayout.showAnalytics = layoutShowAnalytics ? layoutShowAnalytics.checked : true;
    currentLayout.showImport = layoutShowImport ? layoutShowImport.checked : true;
    currentLayout.showContent = layoutShowContent ? layoutShowContent.checked : true;
    currentLayout.showFilterPrioritize = layoutShowFilterPrioritize ? layoutShowFilterPrioritize.checked : true;
    currentLayout.showSpamCheck = layoutShowSpamCheck ? layoutShowSpamCheck.checked : true;
    currentLayout.showAntiSleep = layoutShowAntiSleep ? layoutShowAntiSleep.checked : true;
    currentLayout.showQueue = layoutShowQueue ? layoutShowQueue.checked : true;
    currentLayout.showStats = layoutShowStats ? layoutShowStats.checked : true;
    currentLayout.showFilterBar = layoutShowFilterBar ? layoutShowFilterBar.checked : true;
    currentLayout.showLeads = layoutShowLeads ? layoutShowLeads.checked : true;
    currentLayout.enableMultiContent = layoutEnableMultiContent ? layoutEnableMultiContent.checked : false;
    currentLayout.showConfidentialMode = layoutShowConfidentialMode ? layoutShowConfidentialMode.checked : true;

    currentSettings.enableMultiContent = currentLayout.enableMultiContent;
    setTemplateMode(currentLayout.enableMultiContent, false);

    applyLayout(currentLayout);
    await chrome.storage.local.set({
      homepageLayout: currentLayout,
      settings: currentSettings
    });
  };

  if (layoutShowAnalytics) layoutShowAnalytics.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowImport) layoutShowImport.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowContent) layoutShowContent.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowFilterPrioritize) layoutShowFilterPrioritize.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowSpamCheck) layoutShowSpamCheck.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowAntiSleep) layoutShowAntiSleep.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowQueue) layoutShowQueue.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowStats) layoutShowStats.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowFilterBar) layoutShowFilterBar.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowLeads) layoutShowLeads.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutEnableMultiContent) layoutEnableMultiContent.addEventListener('change', handleLayoutCheckboxChange);
  if (layoutShowConfidentialMode) layoutShowConfidentialMode.addEventListener('change', handleLayoutCheckboxChange);

  if (densitySelect) {
    densitySelect.addEventListener('change', async () => {
      currentLayout.density = densitySelect.value;
      applyLayout(currentLayout);
      await chrome.storage.local.set({ homepageLayout: currentLayout });
    });
  }

  // Layout Presets
  if (presetMinimalBtn) {
    presetMinimalBtn.addEventListener('click', async () => {
      currentLayout = {
        showAnalytics: false,
        showImport: false,
        showContent: false,
        showFilterPrioritize: false,
        showSpamCheck: false,
        showAntiSleep: false,
        showQueue: true,
        showStats: false,
        showFilterBar: true,
        showLeads: true,
        enableMultiContent: false,
        showConfidentialMode: false,
        density: 'compact'
      };
      currentSettings.enableMultiContent = false;
      setTemplateMode(false, false);
      applyLayout(currentLayout);
      await chrome.storage.local.set({ homepageLayout: currentLayout, settings: currentSettings });
    });
  }

  if (presetPrepareBtn) {
    presetPrepareBtn.addEventListener('click', async () => {
      currentLayout = {
        showAnalytics: true,
        showImport: true,
        showContent: true,
        showFilterPrioritize: true,
        showSpamCheck: false,
        showAntiSleep: false,
        showQueue: false,
        showStats: true,
        showFilterBar: true,
        showLeads: true,
        enableMultiContent: currentLayout.enableMultiContent || false,
        showConfidentialMode: false,
        density: 'standard'
      };
      applyLayout(currentLayout);
      await chrome.storage.local.set({ homepageLayout: currentLayout });
    });
  }

  if (presetFullBtn) {
    presetFullBtn.addEventListener('click', async () => {
      currentLayout = {
        showAnalytics: true,
        showImport: true,
        showContent: true,
        showFilterPrioritize: true,
        showSpamCheck: true,
        showAntiSleep: true,
        showQueue: true,
        showStats: true,
        showFilterBar: true,
        showLeads: true,
        enableMultiContent: currentLayout.enableMultiContent || false,
        showConfidentialMode: true,
        density: 'compact'
      };
      applyLayout(currentLayout);
      await chrome.storage.local.set({ homepageLayout: currentLayout });
    });
  }

  if (resetLayoutQuickBtn) {
    resetLayoutQuickBtn.addEventListener('click', async () => {
      currentLayout = {
        showAnalytics: true,
        showImport: true,
        showContent: true,
        showFilterPrioritize: true,
        showSpamCheck: true,
        showAntiSleep: true,
        showQueue: true,
        showStats: true,
        showFilterBar: true,
        showLeads: true,
        enableMultiContent: currentLayout.enableMultiContent || false,
        showConfidentialMode: true,
        density: currentLayout.density || 'compact'
      };
      applyLayout(currentLayout);
      await chrome.storage.local.set({ homepageLayout: currentLayout });
    });
  }
}

/**
 * Apply Collapsed States to DOM
 */
function applyCollapsedStates() {
  Object.entries(currentCollapsed).forEach(([key, isCollapsed]) => {
    if (key === 'delaySettings') {
      if (delaySettingsContent) delaySettingsContent.classList.toggle('collapsed', isCollapsed);
      if (toggleDelaySettingsBtn) toggleDelaySettingsBtn.classList.toggle('collapsed', isCollapsed);
    } else {
      const el = document.getElementById(key);
      if (el) el.classList.toggle('collapsed', isCollapsed);
    }
  });
}

/**
 * Update Auto-Send Method Card UI
 */
function updateSendModeUI(isInPage) {
  if (inPageAutoSendInput) inPageAutoSendInput.checked = Boolean(isInPage);
  if (sendModeBadge) {
    if (isInPage) {
      sendModeBadge.textContent = '⚡ In-Page (Like Manual + Send)';
      sendModeBadge.className = 'badge badge-sent';
    } else {
      sendModeBadge.textContent = 'Original (New Tab)';
      sendModeBadge.className = 'brand-tag';
    }
  }
  if (sendModeDesc) {
    if (isInPage) {
      sendModeDesc.textContent = 'Active Gmail tab (+ Compose → types fields → clicks Send).';
    } else {
      sendModeDesc.textContent = 'Background compose tab (?view=cm) & auto-closes.';
    }
  }
  if (sendModeCard) {
    sendModeCard.classList.toggle('is-inpage', Boolean(isInPage));
  }
}

/**
 * Update BCC Batch Mode Card UI
 */
function updateBccModeUI(isBcc, batchSize = 10) {
  if (enableBccModeInput) enableBccModeInput.checked = Boolean(isBcc);
  if (bccBatchSizeInput && document.activeElement !== bccBatchSizeInput) {
    bccBatchSizeInput.value = batchSize || 10;
  }
  if (bccSettingsContent) {
    bccSettingsContent.style.display = isBcc ? 'block' : 'none';
  }
  if (bccModeBadge) {
    if (isBcc) {
      bccModeBadge.textContent = `⚡ BCC Batch (${batchSize || 10} at a go)`;
      bccModeBadge.className = 'badge badge-sent';
    } else {
      bccModeBadge.textContent = 'Individual (1-by-1)';
      bccModeBadge.className = 'brand-tag';
    }
  }
  if (bccModeDesc) {
    if (isBcc) {
      bccModeDesc.textContent = `Groups up to ${batchSize || 10} leads into BCC per email.`;
    } else {
      bccModeDesc.textContent = 'Send each lead in its own individual email.';
    }
  }
  if (bccModeCard) {
    bccModeCard.classList.toggle('is-bcc', Boolean(isBcc));
  }
}

/**
 * Get human-readable confidential expiration label
 */
function getConfidentialExpirationLabel(expKey) {
  const map = {
    '1d': '1 day',
    '1w': '1 week',
    '1m': '1 month',
    '3m': '3 months',
    '5y': '5 years'
  };
  return map[expKey] || '1 week';
}

/**
 * Update Gmail Confidential Mode Card UI
 */
function updateConfidentialModeUI(isConfidential, coords) {
  if (enableConfidentialModeInput) enableConfidentialModeInput.checked = Boolean(isConfidential);
  if (confidentialSettingsContent) {
    confidentialSettingsContent.style.display = isConfidential ? 'block' : 'none';
  }
  const c = coords || currentSettings.confidentialCoordinates || {};
  const mode = c.mode || '3point';
  const hasCalibration = Boolean(c.point1);

  if (confidentialModeBadge) {
    if (isConfidential) {
      if (hasCalibration) {
        confidentialModeBadge.textContent = `🔒 Calibrated (${mode === '3point' ? '3-Pt' : '2-Pt'})`;
        confidentialModeBadge.className = 'badge badge-sent';
      } else {
        confidentialModeBadge.textContent = '⚠️ Calibrate Now';
        confidentialModeBadge.className = 'badge badge-pending';
      }
    } else {
      confidentialModeBadge.textContent = 'Off';
      confidentialModeBadge.className = 'brand-tag';
    }
  }
  if (confidentialModeDesc) {
    if (isConfidential) {
      if (hasCalibration) {
        confidentialModeDesc.textContent = `Active: Automates Gmail Confidential Mode via ${mode === '3point' ? '3-point' : '2-point'} click coordinates.`;
      } else {
        confidentialModeDesc.textContent = 'Active: Click "🎯 Calibrate on Gmail" below to set your click points.';
      }
    } else {
      confidentialModeDesc.textContent = 'Automates Gmail Confidential Mode using calibrated click coordinates.';
    }
  }
  if (confidentialModeCard) {
    confidentialModeCard.classList.toggle('is-confidential', Boolean(isConfidential));
  }
  updateConfidentialCoordsUI(c);
}

/**
 * Update Confidential Mode Coordinate Calibration UI
 */
function updateConfidentialCoordsUI(coords) {
  const c = coords || currentSettings.confidentialCoordinates || {};
  const mode = c.mode || '3point';

  // Toggle Mode button styling
  if (coordsMode3PointBtn && coordsMode2PointBtn) {
    if (mode === '3point') {
      coordsMode3PointBtn.className = 'btn btn-primary btn-xs';
      coordsMode2PointBtn.className = 'btn btn-secondary btn-xs';
    } else {
      coordsMode3PointBtn.className = 'btn btn-secondary btn-xs';
      coordsMode2PointBtn.className = 'btn btn-primary btn-xs';
    }
  }

  // Adjust Grid & Labels
  if (coordsGridContainer) {
    coordsGridContainer.style.gridTemplateColumns = mode === '3point' ? '1fr 1fr 1fr' : '1fr 1fr';
  }

  if (coordsLabelPoint1) {
    coordsLabelPoint1.textContent = mode === '3point' ? 'Point 1 (3-Dot):' : 'Point 1 (Confidential):';
  }
  if (coordsLabelPoint2) {
    coordsLabelPoint2.textContent = mode === '3point' ? 'Point 2 (Confidential):' : 'Point 2 (Save):';
  }
  if (coordsCardPoint3) {
    coordsCardPoint3.style.display = mode === '3point' ? 'block' : 'none';
  }

  // Point 1 Display
  if (coordsDisplayPoint1) {
    if (c.point1) {
      coordsDisplayPoint1.textContent = `X:${c.point1.x}, Y:${c.point1.y}`;
      coordsDisplayPoint1.style.color = 'var(--primary)';
    } else {
      coordsDisplayPoint1.textContent = 'Not Set';
      coordsDisplayPoint1.style.color = 'var(--text-dim)';
    }
  }

  // Point 2 Display
  if (coordsDisplayPoint2) {
    if (c.point2) {
      coordsDisplayPoint2.textContent = `X:${c.point2.x}, Y:${c.point2.y}`;
      coordsDisplayPoint2.style.color = mode === '3point' ? '#f59e0b' : 'var(--success)';
    } else {
      coordsDisplayPoint2.textContent = 'Not Set';
      coordsDisplayPoint2.style.color = 'var(--text-dim)';
    }
  }

  // Point 3 Display (3-Point mode only)
  if (coordsDisplayPoint3) {
    if (mode === '3point' && c.point3) {
      coordsDisplayPoint3.textContent = `X:${c.point3.x}, Y:${c.point3.y}`;
      coordsDisplayPoint3.style.color = 'var(--success)';
    } else {
      coordsDisplayPoint3.textContent = 'Not Set';
      coordsDisplayPoint3.style.color = 'var(--text-dim)';
    }
  }

  // Interval Delays
  if (confidentialCoordsDelay1Label) {
    confidentialCoordsDelay1Label.textContent = mode === '3point'
      ? 'Interval after Point 1 (open menu):'
      : 'Interval after Point 1 (open dialog):';
  }
  if (confidentialCoordsDelay1Input && document.activeElement !== confidentialCoordsDelay1Input) {
    confidentialCoordsDelay1Input.value = c.delay1Ms || c.delayMs || 350;
  }

  if (confidentialCoordsDelay2Container) {
    confidentialCoordsDelay2Container.style.display = mode === '3point' ? 'flex' : 'none';
  }
  if (confidentialCoordsDelay2Input && document.activeElement !== confidentialCoordsDelay2Input) {
    confidentialCoordsDelay2Input.value = c.delay2Ms || 400;
  }
}

/**
 * Programmatically switch active navigation tab
 */
function activateTab(tabId) {
  tabButtons.forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  tabPanels.forEach((p) => {
    p.classList.toggle('active', p.id === tabId);
  });
  if (importModeBadge) {
    if (tabId === 'tab-json') importModeBadge.textContent = 'JSON Array';
    else if (tabId === 'tab-csv') importModeBadge.textContent = 'CSV Import';
    else if (tabId === 'tab-signatures') importModeBadge.textContent = 'Signatures';
  }
}

/**
 * Reveal and unlock JSON array tab
 */
function unlockJsonTab(autoSwitch = false) {
  isJsonUnlocked = true;
  if (tabBtnJson) {
    tabBtnJson.style.display = 'inline-flex';
  }
  if (keepJsonUnlocked) {
    chrome.storage.local.set({ jsonUnlocked: true });
  }
  if (autoSwitch) {
    activateTab('tab-json');
  }
}

/**
 * Lock and hide JSON array tab
 */
function lockJsonTab(autoSwitchToCsv = false) {
  isJsonUnlocked = false;
  if (tabBtnJson) {
    tabBtnJson.style.display = 'none';
  }
  chrome.storage.local.set({ jsonUnlocked: false });
  if (autoSwitchToCsv) {
    activateTab('tab-csv');
  }
}

/**
 * Trigger Password Prompt Modal
 */
function promptForPassword({ title, promptText, onSuccess }) {
  if (!passwordModal) return;
  activePasswordCallback = onSuccess;
  if (passwordModalTitle) passwordModalTitle.innerHTML = `🔐 ${escapeHtml(title || 'Authorization Required')}`;
  if (passwordModalPrompt) passwordModalPrompt.textContent = promptText || 'Enter password to continue:';
  if (passwordModalInput) {
    passwordModalInput.value = '';
    passwordModalInput.type = 'password';
    passwordModalInput.classList.remove('shake-error');
  }
  if (passwordModalError) {
    passwordModalError.style.display = 'none';
  }
  if (togglePasswordVisibilityBtn) {
    togglePasswordVisibilityBtn.textContent = '👁️';
  }
  passwordModal.classList.add('open');
  setTimeout(() => {
    if (passwordModalInput) passwordModalInput.focus();
  }, 100);
}

/**
 * Close Password Prompt Modal
 */
function closePasswordModal() {
  if (passwordModal) passwordModal.classList.remove('open');
  activePasswordCallback = null;
  if (passwordModalInput) passwordModalInput.value = '';
}

/**
 * UI State Controller for Extension Activation Screen
 */
function updateActivationUI(isActivated, activatedAt) {
  if (!activationScreen) return;
  if (isActivated) {
    activationScreen.style.display = 'none';
    if (activationErrorBanner) {
      activationErrorBanner.style.display = 'none';
      activationErrorBanner.textContent = '';
    }
    if (activationPasswordInput) {
      activationPasswordInput.value = '';
    }
    if (lockAppBtn) {
      const daysLeft = getActivationRemainingDays(activatedAt || appActivatedAt);
      lockAppBtn.title = `Lock Workspace (Authorized: ~${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining)`;
    }
  } else {
    activationScreen.style.display = 'flex';
    const wasExpired = activatedAt && (Date.now() - activatedAt >= ACTIVATION_VALIDITY_MS);
    if (activationSubtitle) {
      if (wasExpired) {
        activationSubtitle.textContent = 'Your 30-day authorization has expired. Please re-enter the master security key to renew access for another month.';
      } else {
        activationSubtitle.textContent = 'Enter the authorized master security key to activate and unlock your Midey Mailer workspace. Access remains valid for 30 days without asking again.';
      }
    }
    if (activationPasswordInput) {
      activationPasswordInput.value = '';
      setTimeout(() => activationPasswordInput.focus(), 80);
    }
  }
}

/**
 * Handle Activation Form Submission & Cryptographic Verification
 */
async function handleActivationSubmit() {
  if (!activationPasswordInput) return;
  const entered = activationPasswordInput.value.trim();
  if (!entered) {
    if (activationErrorBanner) {
      activationErrorBanner.textContent = 'Please enter the master security key.';
      activationErrorBanner.style.display = 'block';
    }
    activationPasswordInput.focus();
    return;
  }

  if (activateAppBtn) {
    activateAppBtn.disabled = true;
    activateAppBtn.innerHTML = '<span>Verifying key...</span>';
  }

  const isValid = await verifyMasterPassword(entered);

  if (isValid) {
    if (activationErrorBanner) {
      activationErrorBanner.style.display = 'none';
      activationErrorBanner.textContent = '';
    }
    const now = Date.now();
    isAppActivated = true;
    appActivatedAt = now;
    await chrome.storage.local.set({ 
      isAppActivated: true,
      appActivatedAt: now
    });
    updateActivationUI(true, now);
    const expDateStr = new Date(now + ACTIVATION_VALIDITY_MS).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    showBanner(statusBanner, `System successfully unlocked! Access is authorized for 30 days (valid until ${expDateStr}).`, 'success');
  } else {
    if (activationErrorBanner) {
      activationErrorBanner.textContent = 'Invalid master security key. Access denied.';
      activationErrorBanner.style.display = 'block';
    }
    activationPasswordInput.classList.remove('shake-error');
    void activationPasswordInput.offsetWidth;
    activationPasswordInput.classList.add('shake-error');
    activationPasswordInput.focus();
    activationPasswordInput.select();
  }

  if (activateAppBtn) {
    activateAppBtn.disabled = false;
    activateAppBtn.innerHTML = '<span>Unlock &amp; Activate System</span><span class="activation-btn-arrow">→</span>';
  }
}

/**
 * Verify Master Password Submission (Password Modal)
 */
async function handlePasswordSubmit() {
  const entered = passwordModalInput ? passwordModalInput.value.trim() : '';
  if (passwordModalSubmitBtn) passwordModalSubmitBtn.disabled = true;

  const isValid = await verifyMasterPassword(entered);
  if (passwordModalSubmitBtn) passwordModalSubmitBtn.disabled = false;

  if (isValid) {
    const cb = activePasswordCallback;
    closePasswordModal();
    if (typeof cb === 'function') {
      cb();
    }
  } else {
    if (passwordModalError) {
      passwordModalError.textContent = 'Incorrect password. Access denied.';
      passwordModalError.style.display = 'block';
    }
    if (passwordModalInput) {
      passwordModalInput.classList.remove('shake-error');
      void passwordModalInput.offsetWidth; // trigger reflow
      passwordModalInput.classList.add('shake-error');
      passwordModalInput.focus();
      passwordModalInput.select();
    }
  }
}

/**
 * Render Global Dispatch Analytics Board
 */
function renderAnalyticsBoard(analytics) {
  const data = analytics || currentAnalytics || { lifetimeSent: 0, dailyHistory: {} };
  const daily = data.dailyHistory || {};
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCount = Number(daily[todayStr] || 0);

  if (analyticsTodayCount) analyticsTodayCount.textContent = todayCount;
  if (analyticsTodayBadge) analyticsTodayBadge.textContent = `${todayCount} Today`;
  if (analyticsLifetimeCount) analyticsLifetimeCount.textContent = Number(data.lifetimeSent || 0);

  // Compute 7-day rolling window
  let sevenDaySum = 0;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const chips = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const count = Number(daily[dateKey] || 0);
    sevenDaySum += count;

    const isToday = i === 0;
    const dayLabel = isToday ? 'Today' : dayNames[d.getDay()];
    const shortDate = `${d.getMonth() + 1}/${d.getDate()}`;

    chips.push(`
      <div class="day-chip ${isToday ? 'is-today' : ''}" title="${dateKey}: ${count} emails sent">
        <div class="day-chip-date">${dayLabel}</div>
        <div class="day-chip-count ${count > 0 ? 'has-sends' : ''}">${count}</div>
        <div class="day-chip-sub">${shortDate}</div>
      </div>
    `);
  }

  if (analyticsSevenDayCount) analyticsSevenDayCount.textContent = sevenDaySum;
  if (sevenDayBars) sevenDayBars.innerHTML = chips.join('');
}

/**
 * Password-protected Reset for Global Analytics
 */
function handleResetAnalytics() {
  promptForPassword({
    title: 'Reset Analytics & Counters',
    promptText: 'Enter master authorization password to wipe 7-day history and lifetime dispatched numbers:',
    onSuccess: async () => {
      currentAnalytics = {
        lifetimeSent: 0,
        dailyHistory: {}
      };
      await chrome.storage.local.set({ analytics: currentAnalytics });
      renderAnalyticsBoard(currentAnalytics);
      showBanner(statusBanner, 'Global analytics and counters have been reset to zero.', 'success');
      showBanner(csvStatusBanner, 'Global analytics reset to zero.', 'success');
    }
  });
}

/**
 * Apply Homepage Layout & Section Visibility
 */
function applyLayout(layout) {
  currentLayout = { ...currentLayout, ...layout };

  if (sectionAnalytics) sectionAnalytics.style.display = currentLayout.showAnalytics !== false ? '' : 'none';
  if (sectionImport) sectionImport.style.display = currentLayout.showImport !== false ? '' : 'none';
  if (sectionContent) sectionContent.style.display = currentLayout.showContent !== false ? '' : 'none';
  if (sectionFilterPrioritize) sectionFilterPrioritize.style.display = currentLayout.showFilterPrioritize !== false ? '' : 'none';
  if (sectionSpamCheck) sectionSpamCheck.style.display = currentLayout.showSpamCheck !== false ? '' : 'none';
  if (sectionAntiSleep) sectionAntiSleep.style.display = currentLayout.showAntiSleep !== false ? '' : 'none';
  if (sectionQueue) sectionQueue.style.display = currentLayout.showQueue !== false ? '' : 'none';
  if (sectionStats) sectionStats.style.display = currentLayout.showStats !== false ? '' : 'none';
  if (sectionFilterBar) sectionFilterBar.style.display = currentLayout.showFilterBar !== false ? '' : 'none';
  if (sectionLeads) sectionLeads.style.display = currentLayout.showLeads !== false ? '' : 'none';

  if (layoutShowAnalytics) layoutShowAnalytics.checked = currentLayout.showAnalytics !== false;
  if (layoutShowImport) layoutShowImport.checked = currentLayout.showImport !== false;
  if (layoutShowContent) layoutShowContent.checked = currentLayout.showContent !== false;
  if (layoutShowFilterPrioritize) layoutShowFilterPrioritize.checked = currentLayout.showFilterPrioritize !== false;
  if (layoutShowSpamCheck) layoutShowSpamCheck.checked = currentLayout.showSpamCheck !== false;
  if (layoutShowAntiSleep) layoutShowAntiSleep.checked = currentLayout.showAntiSleep !== false;
  if (layoutShowQueue) layoutShowQueue.checked = currentLayout.showQueue !== false;
  if (layoutShowStats) layoutShowStats.checked = currentLayout.showStats !== false;
  if (layoutShowFilterBar) layoutShowFilterBar.checked = currentLayout.showFilterBar !== false;
  if (layoutShowLeads) layoutShowLeads.checked = currentLayout.showLeads !== false;
  if (layoutEnableMultiContent) layoutEnableMultiContent.checked = currentLayout.enableMultiContent === true;
  if (layoutShowConfidentialMode) layoutShowConfidentialMode.checked = currentLayout.showConfidentialMode !== false;
  if (confidentialModeCard) confidentialModeCard.style.display = currentLayout.showConfidentialMode !== false ? '' : 'none';
  if (confidentialSettingsContent && currentLayout.showConfidentialMode === false) confidentialSettingsContent.style.display = 'none';
  if (densitySelect) densitySelect.value = currentLayout.density || 'compact';

  const isAnyHidden =
    currentLayout.showAnalytics === false ||
    currentLayout.showImport === false ||
    currentLayout.showContent === false ||
    currentLayout.showFilterPrioritize === false ||
    currentLayout.showSpamCheck === false ||
    currentLayout.showAntiSleep === false ||
    currentLayout.showQueue === false ||
    currentLayout.showStats === false ||
    currentLayout.showFilterBar === false ||
    currentLayout.showLeads === false ||
    currentLayout.showConfidentialMode === false;

  if (minimalistNotice) {
    minimalistNotice.style.display = isAnyHidden ? 'flex' : 'none';
  }

  if (toggleDensityBtn) {
    toggleDensityBtn.textContent = currentLayout.density === 'compact' ? 'Cards View' : 'Compact View';
  }

  renderLeadsList();
}

/**
 * Open Layout Settings Modal
 */
function openLayoutModal() {
  if (layoutShowAnalytics) layoutShowAnalytics.checked = currentLayout.showAnalytics !== false;
  if (layoutShowImport) layoutShowImport.checked = currentLayout.showImport !== false;
  if (layoutShowContent) layoutShowContent.checked = currentLayout.showContent !== false;
  if (layoutShowFilterPrioritize) layoutShowFilterPrioritize.checked = currentLayout.showFilterPrioritize !== false;
  if (layoutShowSpamCheck) layoutShowSpamCheck.checked = currentLayout.showSpamCheck !== false;
  if (layoutShowAntiSleep) layoutShowAntiSleep.checked = currentLayout.showAntiSleep !== false;
  if (layoutShowQueue) layoutShowQueue.checked = currentLayout.showQueue !== false;
  if (layoutShowStats) layoutShowStats.checked = currentLayout.showStats !== false;
  if (layoutShowFilterBar) layoutShowFilterBar.checked = currentLayout.showFilterBar !== false;
  if (layoutShowLeads) layoutShowLeads.checked = currentLayout.showLeads !== false;
  if (layoutEnableMultiContent) layoutEnableMultiContent.checked = currentLayout.enableMultiContent === true;
  if (layoutShowConfidentialMode) layoutShowConfidentialMode.checked = currentLayout.showConfidentialMode !== false;
  if (densitySelect) densitySelect.value = currentLayout.density || 'compact';
  if (layoutModal) layoutModal.classList.add('open');
}

/**
 * Close Layout Settings Modal
 */
function closeLayoutModal() {
  if (layoutModal) layoutModal.classList.remove('open');
}

/**
 * Apply Light/Dark Theme to DOM
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'light') {
    themeIcon.textContent = '🌙';
    themeLabel.textContent = 'Dark';
  } else {
    themeIcon.textContent = '☀️';
    themeLabel.textContent = 'Light';
  }
}

/**
 * Handle CSV File Upload via FileReader
 */
function handleCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    csvInput.value = e.target.result;
    updateDiscoveredCsvTags(csvInput.value);
    showBanner(csvStatusBanner, `Loaded file "${file.name}" (${(file.size / 1024).toFixed(1)} KB).`, 'success');
  };
  reader.onerror = () => {
    showBanner(csvStatusBanner, 'Failed to read CSV file.', 'error');
  };
  reader.readAsText(file);
}

/**
 * Parse headers and update detected tags bar (Fast: inspects only first line)
 */
function updateDiscoveredCsvTags(rawCsv) {
  if (!rawCsv || !rawCsv.trim()) {
    updateDiscoveredCsvTagsFromLeads();
    return;
  }
  // Inspect only the first line for instant tag discovery without parsing entire payload
  const firstLine = rawCsv.split(/[\r\n]+/)[0];
  if (!firstLine || !firstLine.trim()) {
    updateDiscoveredCsvTagsFromLeads();
    return;
  }

  const rows = parseCsvText(firstLine);
  if (rows.length === 0) {
    updateDiscoveredCsvTagsFromLeads();
    return;
  }

  const firstRow = rows[0];
  const tags = firstRow
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && h !== 'body');

  if (tags.length > 0) {
    csvTagsList.innerHTML = tags
      .map((t) => `<span class="tag-chip" data-tag="{${t}}">{${t}}</span>`)
      .join('');
  } else {
    updateDiscoveredCsvTagsFromLeads();
  }
}

/**
 * Fallback tag discovery from loaded leads' rowObj
 */
function updateDiscoveredCsvTagsFromLeads() {
  if (!csvTagsList) return;
  if (csvInput && csvInput.value && csvInput.value.trim()) {
    const firstLine = csvInput.value.trim().split(/[\r\n]+/)[0];
    if (firstLine) {
      const rows = parseCsvText(firstLine);
      if (rows.length > 0) {
        const tags = rows[0].map((h) => h.trim().toLowerCase()).filter((h) => h && h !== 'body');
        if (tags.length > 0) {
          csvTagsList.innerHTML = tags
            .map((t) => `<span class="tag-chip" data-tag="{${t}}">{${t}}</span>`)
            .join('');
          return;
        }
      }
    }
  }

  const tagSet = new Set();
  tagSet.add('email');
  tagSet.add('domain');

  currentLeads.forEach((lead) => {
    if (lead && lead.rowObj) {
      Object.keys(lead.rowObj).forEach((k) => {
        const lower = k.toLowerCase().trim();
        if (
          lower &&
          lower !== 'body' &&
          lower !== 'id' &&
          lower !== 'status' &&
          lower !== 'sentat' &&
          lower !== 'errormessage' &&
          lower !== 'isprioritized' &&
          lower !== 'rowobj'
        ) {
          tagSet.add(lower);
        }
      });
    }
  });

  const tags = Array.from(tagSet);
  if (tags.length > 0 && currentLeads.length > 0) {
    csvTagsList.innerHTML = tags
      .map((t) => `<span class="tag-chip" data-tag="{${t}}">{${t}}</span>`)
      .join('');
  } else {
    csvTagsList.innerHTML = '<span class="no-tags-hint" style="font-size: 11px; color: var(--text-dim);">(Tags will appear here after loading a CSV)</span>';
  }
}

/**
 * Insert clicked tag into focused template input
 */
function insertTagIntoTemplate(tag) {
  const target = lastFocusedTemplateInput || csvBodyTemplate;
  const start = target.selectionStart || target.value.length;
  const end = target.selectionEnd || target.value.length;
  const val = target.value;
  target.value = val.substring(0, start) + tag + val.substring(end);
  target.focus();
  target.selectionStart = target.selectionEnd = start + tag.length;
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Load Leads from CSV
 */
async function handleLoadCsvLeads() {
  hideBanner(csvStatusBanner);
  const rawCsv = csvInput.value.trim();

  if (!rawCsv) {
    showBanner(csvStatusBanner, 'Please upload or paste a CSV first.', 'error');
    return;
  }

  const rows = parseCsvText(rawCsv);
  if (rows.length === 0) {
    showBanner(csvStatusBanner, 'The CSV contains no rows.', 'error');
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let headers = [];
  let dataRows = [];
  let emailColIdx = -1;

  // Detect if row 0 is headers or just plain emails
  const firstRowHasEmail = rows[0].some((c) => emailRegex.test(c.trim()));
  const firstRowHeaderMatch = rows[0].findIndex((c) =>
    ['email', 'e-mail', 'mail', 'recipient'].includes(c.trim().toLowerCase())
  );

  if (firstRowHeaderMatch !== -1) {
    // Standard CSV with email header
    headers = rows[0].map((h) => h.trim().toLowerCase());
    emailColIdx = firstRowHeaderMatch;
    dataRows = rows.slice(1);
  } else if (!firstRowHasEmail) {
    // First row has non-email headers
    headers = rows[0].map((h) => h.trim().toLowerCase());
    dataRows = rows.slice(1);
    // Find which column has emails in subsequent rows
    if (dataRows.length > 0) {
      emailColIdx = dataRows[0].findIndex((c) => emailRegex.test(c.trim()));
    }
  } else {
    // Pure list of emails without header
    dataRows = rows;
    emailColIdx = rows[0].findIndex((c) => emailRegex.test(c.trim()));
    if (emailColIdx === -1) emailColIdx = 0;
  }

  if (emailColIdx === -1) {
    showBanner(csvStatusBanner, 'Could not locate an email address column in your CSV.', 'error');
    return;
  }

  const subjTemplate = (csvSubjectTemplate?.value || '').trim();
  const bodyTemplate = (csvBodyTemplate?.value || '').trim();

  // Detect subject and body columns in the CSV headers
  const subjectHeaders = ['subject', 'sub', 'title', 'headline', 'topic', 'header'];
  const bodyHeaders = ['body', 'message', 'content', 'email body', 'email_body', 'text', 'notes', 'description', 'pitch'];

  const subjectColIdx = headers.findIndex((h) => subjectHeaders.includes(h.trim().toLowerCase()));
  const bodyColIdx = headers.findIndex((h) => bodyHeaders.includes(h.trim().toLowerCase()));

  const { leads: existing = [] } = await chrome.storage.local.get('leads');

  // Map existing leads by lowercase email for fast matching
  const updatedLeads = [...existing];
  const existingEmailIndexMap = new Map();
  updatedLeads.forEach((lead, idx) => {
    if (lead && lead.email) {
      const norm = lead.email.trim().toLowerCase();
      if (!existingEmailIndexMap.has(norm)) {
        existingEmailIndexMap.set(norm, idx);
      }
    }
  });

  const newLeadsToAdd = [];
  const processedInCsv = new Set();
  let updatedCount = 0;
  let addedCount = 0;
  let alreadySentCount = 0;
  let skippedInvalid = 0;

  dataRows.forEach((row, i) => {
    const rawEmail = (row[emailColIdx] || '').trim();
    if (!emailRegex.test(rawEmail)) {
      skippedInvalid++;
      return;
    }

    const normEmail = rawEmail.toLowerCase();
    if (processedInCsv.has(normEmail)) {
      return; // Skip duplicate rows within the same CSV upload
    }
    processedInCsv.add(normEmail);

    // Build row key-value map strictly using details from CSV row
    const rowObj = {};
    headers.forEach((h, colIdx) => {
      rowObj[h] = row[colIdx] !== undefined ? row[colIdx].trim() : '';
    });
    const domain = (rawEmail.split('@')[1] || '').toLowerCase();
    const mergedRowObj = { ...rowObj, email: rawEmail, domain };

    const isMulti = Boolean(currentSettings?.enableMultiContent);
    const rotated = isMulti ? getRotatedContentForIndex(i, currentSettings) : null;

    // 1. Determine Subject strictly using CSV details first
    let subject = '';
    const csvRowSubject = subjectColIdx !== -1 && row[subjectColIdx] !== undefined ? row[subjectColIdx].trim() : '';
    if (csvRowSubject) {
      subject = csvRowSubject;
    } else if (isMulti && rotated?.subject?.trim()) {
      subject = replaceTemplateTags(rotated.subject, mergedRowObj);
    } else if (subjTemplate) {
      subject = replaceTemplateTags(subjTemplate, mergedRowObj);
    } else {
      subject = '';
    }

    // 2. Determine Body strictly using CSV details first
    let body = '';
    const csvRowBody = bodyColIdx !== -1 && row[bodyColIdx] !== undefined ? row[bodyColIdx].trim() : '';
    if (csvRowBody) {
      body = csvRowBody;
    } else if (isMulti && rotated?.body?.trim()) {
      body = replaceTemplateTags(rotated.body, mergedRowObj);
    } else if (bodyTemplate) {
      body = replaceTemplateTags(bodyTemplate, mergedRowObj);
    } else {
      body = '';
    }

    if (existingEmailIndexMap.has(normEmail)) {
      const existingIdx = existingEmailIndexMap.get(normEmail);
      const existingLead = updatedLeads[existingIdx];

      // Only update leads if they weren't sent yet
      if (existingLead.status === 'sent') {
        alreadySentCount++;
      } else {
        // Update subject, body, and stored rowObj with the CSV content, reset to pending
        updatedLeads[existingIdx] = {
          ...existingLead,
          email: rawEmail,
          subject: subject,
          body: body,
          rowObj: mergedRowObj,
          status: 'pending',
          errorMessage: null,
          sentAt: null
        };
        updatedCount++;
      }
    } else {
      newLeadsToAdd.push({
        id: 'lead_csv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7) + '_' + i,
        email: rawEmail,
        subject: subject,
        body: body,
        rowObj: mergedRowObj,
        status: 'pending',
        errorMessage: null,
        sentAt: null
      });
      addedCount++;
    }
  });

  const finalLeads = [...updatedLeads, ...newLeadsToAdd];

  if (updatedCount === 0 && addedCount === 0) {
    if (alreadySentCount > 0) {
      showBanner(
        csvStatusBanner,
        `All ${alreadySentCount} lead(s) in this CSV have already been sent and were retained unchanged.`,
        'info'
      );
    } else {
      showBanner(
        csvStatusBanner,
        `No valid leads found in CSV (${skippedInvalid} invalid rows skipped).`,
        'error'
      );
    }
    return;
  }

  const storageUpdate = { leads: finalLeads };
  if (subjTemplate || bodyTemplate) {
    storageUpdate.csvTemplate = { subject: subjTemplate, body: bodyTemplate };
  }
  await chrome.storage.local.set(storageUpdate);

  updateDiscoveredCsvTagsFromLeads();
  renderFilterRules();
  updateFilterMatchStats();

  const summaryParts = [];
  if (updatedCount > 0) summaryParts.push(`${updatedCount} updated with new content`);
  if (addedCount > 0) summaryParts.push(`${addedCount} new lead${addedCount === 1 ? '' : 's'} added`);
  if (alreadySentCount > 0) summaryParts.push(`${alreadySentCount} already sent (retained)`);
  if (skippedInvalid > 0) summaryParts.push(`${skippedInvalid} invalid skipped`);

  showBanner(
    csvStatusBanner,
    `Successfully processed CSV: ${summaryParts.join(', ')} (Total queue: ${finalLeads.length})`,
    'success'
  );
}

/**
 * Replace {tag} in templates using row data (Fast compiled single-pass regex)
 */
function replaceTemplateTags(template, rowObj) {
  if (!template) return '';
  return template.replace(/\{([\w-]+)\}/gi, (match, tag) => {
    const key = tag.toLowerCase();
    return rowObj[key] !== undefined ? rowObj[key] : match;
  });
}

/**
 * RFC-compliant CSV Parser
 */
function parseCsvText(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) {
        lines.push(row);
      }
      row = [];
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some((cell) => cell.length > 0)) {
      lines.push(row);
    }
  }
  return lines;
}

/**
 * Render Signatures Manager List
 */
function renderSignaturesList() {
  signaturesListContainer.innerHTML = '';
  const sigs = currentSettings.signatures || [];

  sigs.forEach((sig, index) => {
    const item = document.createElement('div');
    item.className = 'signature-item';
    item.innerHTML = `
      <div class="signature-header">
        <span style="font-size: 11px; font-weight: 700; color: var(--text-muted);">Signature #${index + 1}</span>
        <button class="btn btn-outline-danger btn-xs delete-sig-btn" data-index="${index}">✕</button>
      </div>
      <textarea class="signature-textarea" data-index="${index}" spellcheck="false">${escapeHtml(sig)}</textarea>
    `;

    const txtArea = item.querySelector('.signature-textarea');
    txtArea.addEventListener('input', (e) => {
      currentSettings.signatures[index] = e.target.value;
    });

    const delBtn = item.querySelector('.delete-sig-btn');
    delBtn.addEventListener('click', () => {
      currentSettings.signatures.splice(index, 1);
      renderSignaturesList();
    });

    signaturesListContainer.appendChild(item);
  });
}

/**
 * Save Signatures and Rotation Settings
 */
async function saveSignaturesSettings() {
  const textareas = signaturesListContainer.querySelectorAll('.signature-textarea');
  const updatedSigs = [];
  textareas.forEach((ta) => {
    if (ta.value.trim()) updatedSigs.push(ta.value.trim());
  });

  currentSettings = {
    ...currentSettings,
    enableSignature: enableSignatureCheckbox.checked,
    signatureRotationMode: signatureRotationSelect.value,
    signatures: updatedSigs
  };

  await chrome.storage.local.set({ settings: currentSettings });
  showBanner(sigStatusBanner, 'Signatures and rotation settings saved!', 'success');
}

/**
 * =========================================================================
 * Anti-Sleep & Keep PC Awake Controller
 * =========================================================================
 */

/**
 * Render Anti-Sleep UI state and countdown timer
 */
function renderAntiSleepState(state) {
  currentAntiSleepState = state || { isActive: false };
  const isActive = Boolean(currentAntiSleepState.isActive);

  if (antiSleepStatusPill) {
    antiSleepStatusPill.className = `anti-sleep-pill ${isActive ? 'active' : 'idle'}`;
  }

  if (antiSleepStatusLabel) {
    antiSleepStatusLabel.textContent = isActive ? 'AWAKE' : 'IDLE';
  }

  if (toggleAntiSleepBtn) {
    if (isActive) {
      toggleAntiSleepBtn.className = 'btn btn-danger btn-xs';
      toggleAntiSleepBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
        </svg>
        Stop Anti-Sleep
      `;
    } else {
      toggleAntiSleepBtn.className = 'btn btn-success btn-xs';
      toggleAntiSleepBtn.innerHTML = `☕ Keep PC Awake`;
    }
  }

  if (antiSleepActiveInfo) {
    antiSleepActiveInfo.style.display = isActive ? 'block' : 'none';
  }

  updateAntiSleepTimerDisplay();
}

/**
 * Ticking display for Anti-Sleep countdown
 */
function updateAntiSleepTimerDisplay() {
  if (!currentAntiSleepState?.isActive) {
    if (antiSleepCountdownText) antiSleepCountdownText.textContent = 'Sleep Allowed (Idle)';
    if (antiSleepReasonText) antiSleepReasonText.textContent = 'PC will follow normal OS sleep schedule.';
    return;
  }

  const { expiresAt, reason } = currentAntiSleepState;

  if (expiresAt) {
    const remainingMs = Math.max(0, expiresAt - Date.now());
    if (remainingMs <= 0) {
      if (antiSleepCountdownText) antiSleepCountdownText.textContent = 'Timer Expiring...';
      return;
    }
    const totalSec = Math.floor(remainingMs / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const formatted = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    
    if (antiSleepCountdownText) {
      antiSleepCountdownText.textContent = `Awake (${formatted} remaining)`;
    }
    if (antiSleepReasonText) {
      const endTimeStr = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      antiSleepReasonText.textContent = `Display & system stay awake until ${endTimeStr}`;
    }
    if (antiSleepStatusLabel) {
      antiSleepStatusLabel.textContent = formatted;
    }
  } else if (reason === 'queue') {
    if (antiSleepCountdownText) antiSleepCountdownText.textContent = 'Awake (While Queue is Sending)';
    if (antiSleepReasonText) antiSleepReasonText.textContent = 'Display will stay awake until all emails finish sending';
    if (antiSleepStatusLabel) antiSleepStatusLabel.textContent = 'QUEUE WAKE';
  } else {
    // Indefinite lock
    if (antiSleepCountdownText) antiSleepCountdownText.textContent = 'Awake (Indefinite Lock)';
    if (antiSleepReasonText) antiSleepReasonText.textContent = 'Screen & system kept awake until manually stopped';
    if (antiSleepStatusLabel) antiSleepStatusLabel.textContent = 'AWAKE';
  }
}

/**
 * Start 1-second interval ticker for anti-sleep countdown
 */
function startAntiSleepCountdownTicker() {
  if (antiSleepCountdownInterval) clearInterval(antiSleepCountdownInterval);
  antiSleepCountdownInterval = setInterval(() => {
    if (currentAntiSleepState?.isActive) {
      updateAntiSleepTimerDisplay();
    }
  }, 1000);
}

/**
 * Handle Start / Stop Anti-Sleep Toggle
 */
async function handleToggleAntiSleep() {
  if (currentAntiSleepState?.isActive) {
    // Stop lock
    const res = await chrome.runtime.sendMessage({ action: 'STOP_ANTI_SLEEP' });
    if (res?.antiSleepState) {
      renderAntiSleepState(res.antiSleepState);
    }
  } else {
    // Start lock
    const selected = antiSleepDurationSelect ? antiSleepDurationSelect.value : '60';
    let durationMinutes = null;
    let reason = 'timer';

    if (selected === 'queue') {
      durationMinutes = null;
      reason = 'queue';
    } else if (selected === 'indefinite') {
      durationMinutes = null;
      reason = 'indefinite';
    } else if (selected === 'custom') {
      durationMinutes = parseInt(antiSleepCustomMinutesInput?.value, 10) || 60;
      reason = 'timer';
    } else {
      durationMinutes = parseInt(selected, 10) || 60;
      reason = 'timer';
    }

    const res = await chrome.runtime.sendMessage({
      action: 'START_ANTI_SLEEP',
      durationMinutes,
      reason
    });
    if (res?.antiSleepState) {
      renderAntiSleepState(res.antiSleepState);
    }
  }
}

/**
 * =========================================================================
 * Multi-Content Variations & Rotation Manager Controller
 * =========================================================================
 */

/**
 * Switch Template Mode between Single and Multi-Content Variations
 */
async function setTemplateMode(isMulti, saveToStorage = true) {
  currentSettings.enableMultiContent = Boolean(isMulti);

  if (modeSingleBtn) modeSingleBtn.classList.toggle('active', !isMulti);
  if (modeMultiBtn) modeMultiBtn.classList.toggle('active', isMulti);
  if (multiContentModeBadge) multiContentModeBadge.style.display = isMulti ? 'inline-block' : 'none';

  if (singleContentContainer) singleContentContainer.style.display = isMulti ? 'none' : 'flex';
  if (multiContentContainer) multiContentContainer.style.display = isMulti ? 'flex' : 'none';

  if (layoutEnableMultiContent) {
    layoutEnableMultiContent.checked = Boolean(isMulti);
  }

  updateRotationSummaryText();

  if (saveToStorage) {
    await chrome.storage.local.set({ settings: currentSettings });
  }
}

/**
 * Update summary description of how rotation behaves
 */
function updateRotationSummaryText() {
  if (!rotationSummaryText) return;
  const target = currentSettings.contentRotationTarget || 'both';
  const mode = currentSettings.contentRotationMode === 'random' ? 'randomly' : 'one-by-one (sequentially)';

  const subjCount = (currentSettings.subjectTemplates || []).length || 1;
  const bodyCount = (currentSettings.bodyTemplates || []).length || 1;

  if (target === 'both') {
    rotationSummaryText.textContent = `Rotating ${subjCount} subject${subjCount === 1 ? '' : 's'} & ${bodyCount} body variation${bodyCount === 1 ? '' : 's'} ${mode} across pending leads.`;
  } else if (target === 'subject') {
    rotationSummaryText.textContent = `Rotating ${subjCount} subject variation${subjCount === 1 ? '' : 's'} ${mode}; keeping Body #1 fixed for all leads.`;
  } else {
    rotationSummaryText.textContent = `Rotating ${bodyCount} body variation${bodyCount === 1 ? '' : 's'} ${mode}; keeping Subject #1 fixed for all leads.`;
  }
}

/**
 * Render Multiple Subjects and Bodies in the Multi-Content Manager
 */
function renderMultiContentLists() {
  // Ensure array validity
  if (!Array.isArray(currentSettings.subjectTemplates) || currentSettings.subjectTemplates.length === 0) {
    currentSettings.subjectTemplates = [csvSubjectTemplate?.value || ''];
  }
  if (!Array.isArray(currentSettings.bodyTemplates) || currentSettings.bodyTemplates.length === 0) {
    currentSettings.bodyTemplates = [csvBodyTemplate?.value || ''];
  }

  // 1. Render Subjects List
  if (subjectsListContainer) {
    subjectsListContainer.innerHTML = '';
    currentSettings.subjectTemplates.forEach((subj, idx) => {
      const item = document.createElement('div');
      item.className = 'multi-template-item';
      item.innerHTML = `
        <div class="multi-template-header">
          <span class="multi-template-badge">Subject #${idx + 1}${idx === 0 ? ' (Primary)' : ''}</span>
          ${currentSettings.subjectTemplates.length > 1 ? `<button type="button" class="btn btn-outline-danger btn-xs del-subj-btn" data-index="${idx}" title="Delete this subject variation">✕</button>` : ''}
        </div>
        <input type="text" class="setting-input multi-subject-input" data-index="${idx}" value="${escapeHtml(subj)}" placeholder="Subject variation #${idx + 1}... (supports {tags})">
      `;

      const input = item.querySelector('.multi-subject-input');
      input.addEventListener('focus', () => { lastFocusedTemplateInput = input; });
      input.addEventListener('input', (e) => {
        currentSettings.subjectTemplates[idx] = e.target.value;
        if (idx === 0 && csvSubjectTemplate) {
          csvSubjectTemplate.value = e.target.value;
        }
        debouncedSaveMultiContent();
      });

      const delBtn = item.querySelector('.del-subj-btn');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          currentSettings.subjectTemplates.splice(idx, 1);
          renderMultiContentLists();
          debouncedSaveMultiContent();
        });
      }

      subjectsListContainer.appendChild(item);
    });
  }

  // 2. Render Bodies List
  if (bodiesListContainer) {
    bodiesListContainer.innerHTML = '';
    currentSettings.bodyTemplates.forEach((body, idx) => {
      const item = document.createElement('div');
      item.className = 'multi-template-item';
      item.innerHTML = `
        <div class="multi-template-header">
          <span class="multi-template-badge">Body #${idx + 1}${idx === 0 ? ' (Primary)' : ''}</span>
          ${currentSettings.bodyTemplates.length > 1 ? `<button type="button" class="btn btn-outline-danger btn-xs del-body-btn" data-index="${idx}" title="Delete this body variation">✕</button>` : ''}
        </div>
        <textarea class="code-textarea multi-body-textarea" data-index="${idx}" style="height: 75px; margin-top: 2px;" placeholder="Body variation #${idx + 1}... (supports {tags})" spellcheck="false">${escapeHtml(body)}</textarea>
      `;

      const txt = item.querySelector('.multi-body-textarea');
      txt.addEventListener('focus', () => { lastFocusedTemplateInput = txt; });
      txt.addEventListener('input', (e) => {
        currentSettings.bodyTemplates[idx] = e.target.value;
        if (idx === 0 && csvBodyTemplate) {
          csvBodyTemplate.value = e.target.value;
        }
        debouncedSaveMultiContent();
      });

      const delBtn = item.querySelector('.del-body-btn');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          currentSettings.bodyTemplates.splice(idx, 1);
          renderMultiContentLists();
          debouncedSaveMultiContent();
        });
      }

      bodiesListContainer.appendChild(item);
    });
  }

  if (subjectCountText) subjectCountText.textContent = currentSettings.subjectTemplates.length;
  if (bodyCountText) bodyCountText.textContent = currentSettings.bodyTemplates.length;
  updateRotationSummaryText();
}

/**
 * Debounced Auto-save for Multi-Content Templates
 */
let multiContentDebounce = null;
function debouncedSaveMultiContent() {
  clearTimeout(multiContentDebounce);
  multiContentDebounce = setTimeout(async () => {
    await chrome.storage.local.set({
      settings: currentSettings,
      csvTemplate: {
        subject: currentSettings.subjectTemplates[0] || '',
        body: currentSettings.bodyTemplates[0] || ''
      }
    });
  }, 350);
}

/**
 * Get rotated subject and body based on index and settings
 */
function getRotatedContentForIndex(index, settings) {
  const subjects = (settings.subjectTemplates && settings.subjectTemplates.length > 0)
    ? settings.subjectTemplates.filter((s) => s !== undefined)
    : [csvSubjectTemplate?.value || ''];
  const bodies = (settings.bodyTemplates && settings.bodyTemplates.length > 0)
    ? settings.bodyTemplates.filter((b) => b !== undefined)
    : [csvBodyTemplate?.value || ''];

  const target = settings.contentRotationTarget || 'both'; // 'both' | 'subject' | 'body'
  const mode = settings.contentRotationMode || 'sequential'; // 'sequential' | 'random'

  let chosenSubject = '';
  let chosenBody = '';

  // 1. Choose Subject
  if (target === 'body') {
    // Subject is fixed to Primary Subject #1
    chosenSubject = subjects[0] || '';
  } else {
    // Target is 'both' or 'subject' -> rotate subject!
    if (mode === 'random') {
      chosenSubject = subjects[Math.floor(Math.random() * subjects.length)] || '';
    } else {
      // Sequential
      chosenSubject = subjects[index % subjects.length] || '';
    }
  }

  // 2. Choose Body
  if (target === 'subject') {
    // Body is fixed to Primary Body #1
    chosenBody = bodies[0] || '';
  } else {
    // Target is 'both' or 'body' -> rotate body!
    if (mode === 'random') {
      chosenBody = bodies[Math.floor(Math.random() * bodies.length)] || '';
    } else {
      // Sequential
      chosenBody = bodies[index % bodies.length] || '';
    }
  }

  return { subject: chosenSubject, body: chosenBody };
}

/**
 * Handle Batch JSON / Text File Upload via FileReader
 */
function handleBatchTextFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    jsonInput.value = e.target.result;
    showBanner(statusBanner, `Loaded file "${file.name}" (${(file.size / 1024).toFixed(1)} KB). Click "Load Leads" to process.`, 'success');
  };
  reader.onerror = () => {
    showBanner(statusBanner, 'Failed to read file.', 'error');
  };
  reader.readAsText(file);
}

/**
 * Load Leads from JSON or Plain Text Key-Value Format
 */
async function handleLoadJsonLeads() {
  hideBanner(statusBanner);
  const rawText = jsonInput.value.trim();

  if (!rawText) {
    showBanner(statusBanner, 'Please paste JSON or labeled plain text leads before loading.', 'error');
    return;
  }

  let normalizedLeads;
  try {
    normalizedLeads = parseBatchEmailInput(rawText);
  } catch (parseError) {
    showBanner(statusBanner, parseError.message, 'error');
    return;
  }

  if (!Array.isArray(normalizedLeads) || normalizedLeads.length === 0) {
    showBanner(statusBanner, 'No valid email leads found to load.', 'error');
    return;
  }

  const validatedLeads = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  for (let i = 0; i < normalizedLeads.length; i++) {
    const item = normalizedLeads[i];

    if (!item || typeof item !== 'object') {
      showBanner(statusBanner, `Lead #${i + 1} is not a valid lead object.`, 'error');
      return;
    }

    if (!item.email || typeof item.email !== 'string' || !item.email.trim()) {
      showBanner(statusBanner, `Lead #${i + 1} is missing the "email" field.`, 'error');
      return;
    }

    const emailTrimmed = item.email.trim();
    if (!emailRegex.test(emailTrimmed)) {
      showBanner(statusBanner, `Lead #${i + 1} has an invalid email: "${emailTrimmed}".`, 'error');
      return;
    }

    const domain = (emailTrimmed.split('@')[1] || '').toLowerCase();
    const rowObj = {
      ...(item.rowObj || item),
      email: emailTrimmed,
      domain
    };

    const isMulti = Boolean(currentSettings?.enableMultiContent);
    const rotated = isMulti ? getRotatedContentForIndex(i, currentSettings) : null;
    const subjTemplate = (csvSubjectTemplate?.value || '').trim();
    const bodyTemplate = (csvBodyTemplate?.value || '').trim();

    let leadSubject = (item.subject || '').trim();
    if (!leadSubject) {
      if (isMulti && rotated?.subject?.trim()) {
        leadSubject = replaceTemplateTags(rotated.subject, rowObj);
      } else if (subjTemplate) {
        leadSubject = replaceTemplateTags(subjTemplate, rowObj);
      }
    }

    let leadBody = item.body || '';
    if (!leadBody) {
      if (isMulti && rotated?.body?.trim()) {
        leadBody = replaceTemplateTags(rotated.body, rowObj);
      } else if (bodyTemplate) {
        leadBody = replaceTemplateTags(bodyTemplate, rowObj);
      }
    }

    validatedLeads.push({
      id: 'lead_json_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      email: emailTrimmed,
      subject: leadSubject,
      body: leadBody,
      rowObj: rowObj,
      status: 'pending',
      errorMessage: null,
      sentAt: null
    });
  }

  const { leads: existingLeads = [] } = await chrome.storage.local.get('leads');
  const mergedLeads = [...existingLeads, ...validatedLeads];
  await chrome.storage.local.set({ leads: mergedLeads });

  updateDiscoveredCsvTagsFromLeads();
  renderFilterRules();
  updateFilterMatchStats();

  jsonInput.value = '';
  showBanner(statusBanner, `Successfully loaded ${validatedLeads.length} leads! (Total: ${mergedLeads.length})`, 'success');
}

/**
 * Dual-Format Batch Email Parser
 * Automatically detects and accepts BOTH JSON format and labeled Plain Text format.
 *
 * Requirements:
 * 1. Dual-Format Detection:
 *    - Trim leading/trailing whitespace.
 *    - If input starts with "[" or "{", parse using standard JSON parsing
 *      expecting an array of objects (or a single object) with keys: "email", "subject", "body".
 *    - Otherwise, if input contains "email:" and "subject:", parse using Plain Text Key-Value parser.
 * 2. Outputs normalized array: [{ "email": "...", "subject": "...", "body": "..." }]
 *    so existing signature-appending and email sending queue work seamlessly.
 * 3. Strips accidental markdown code fences from beginning and end before parsing.
 */
function parseBatchEmailInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Please enter email leads to load.');
  }

  // 1. Trim leading/trailing whitespace from the raw input string
  let text = rawInput.trim();
  if (!text) {
    throw new Error('Please enter email leads to load.');
  }

  // Strip any accidental markdown code fences (like ```json, ```text, or ```) from beginning and end
  text = stripMarkdownFences(text);
  if (!text) {
    throw new Error('Input is empty after removing markdown code fences.');
  }

  // 2. Dual-Format Detection: JSON format
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      throw new Error(`Invalid JSON format: ${parseError.message}`);
    }

    let array = [];
    if (Array.isArray(parsed)) {
      array = parsed;
    } else if (parsed && typeof parsed === 'object') {
      array = [parsed];
    } else {
      throw new Error('JSON input must be an array of objects or a single object.');
    }

    return array.map((item) => ({
      email: item && typeof item.email === 'string' ? item.email : (item && item.email != null ? String(item.email) : ''),
      subject: item && typeof item.subject === 'string' ? item.subject : (item && item.subject != null ? String(item.subject) : ''),
      body: item && typeof item.body === 'string' ? item.body : (item && item.body != null ? String(item.body) : '')
    }));
  }

  // 3. Dual-Format Detection: Plain Text Key-Value format
  const hasEmailLabel = /email\s*:/i.test(text);
  const hasSubjectLabel = /subject\s*:/i.test(text);

  if (hasEmailLabel && hasSubjectLabel) {
    const records = parsePlainTextLeads(text);
    if (!records || records.length === 0) {
      throw new Error('No valid email blocks found in the plain text input.');
    }
    return records;
  }

  // If neither format matches:
  throw new Error('Unrecognized input format. Please provide a JSON array/object or labeled plain text with "email:" and "subject:".');
}

/**
 * Plain Text Key-Value Parser
 *
 * Rules:
 * - Multiple email records in plain text are separated by a delimiter line of
 *   three or more equals signs (e.g., "===") or dashes ("---"), OR by the
 *   start of a new "email:" label at the beginning of a line.
 * - For each block, extract:
 *   * "email": The text on the same line after "email:" (trimmed).
 *   * "subject": The text on the same line after "subject:" (trimmed).
 *   * "body": Everything following the "body:" label (whether on the same line
 *     or subsequent lines) up until the next record delimiter ("===" / "---")
 *     or end of input. Preserve all paragraph line breaks (\n\n) inside the body.
 */
function parsePlainTextLeads(text) {
  // Normalize line endings to \n
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const blocks = [];
  let currentBlockLines = [];
  let hasEmailInBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isDelimiterLine = /^[ \t]*(={3,}|-{3,})[ \t]*$/.test(line);
    const isEmailStart = /^[ \t]*email[ \t]*:/i.test(line);

    if (isDelimiterLine) {
      if (currentBlockLines.length > 0) {
        blocks.push(currentBlockLines.join('\n'));
        currentBlockLines = [];
        hasEmailInBlock = false;
      }
      continue;
    }

    if (isEmailStart) {
      if (hasEmailInBlock) {
        // Start of a new "email:" label at the beginning of a line marks the next record
        blocks.push(currentBlockLines.join('\n'));
        currentBlockLines = [line];
        hasEmailInBlock = true;
        continue;
      } else {
        hasEmailInBlock = true;
      }
    }

    currentBlockLines.push(line);
  }

  if (currentBlockLines.length > 0) {
    blocks.push(currentBlockLines.join('\n'));
  }

  const results = [];
  for (const block of blocks) {
    if (!block.trim()) continue;

    // Locate "body:" label to separate headers from body content
    const bodyMatch = block.match(/^[ \t]*body[ \t]*:[ \t]*/im);
    let headerText = block;
    let bodyText = '';

    if (bodyMatch) {
      headerText = block.slice(0, bodyMatch.index);
      const afterBodyLabel = block.slice(bodyMatch.index + bodyMatch[0].length);
      // Strip leading blank lines directly following body: if body starts on subsequent lines
      bodyText = afterBodyLabel.replace(/^([ \t]*\r?\n)+/, '').trimEnd();
    }

    // Extract "email": text on the same line after "email:" (trimmed)
    const emailMatch = headerText.match(/^[ \t]*email[ \t]*:[ \t]*(.*)$/im) || block.match(/^[ \t]*email[ \t]*:[ \t]*(.*)$/im);
    const email = emailMatch ? emailMatch[1].trim() : '';

    // Extract "subject": text on the same line after "subject:" (trimmed)
    const subjectMatch = headerText.match(/^[ \t]*subject[ \t]*:[ \t]*(.*)$/im) || block.match(/^[ \t]*subject[ \t]*:[ \t]*(.*)$/im);
    const subject = subjectMatch ? subjectMatch[1].trim() : '';

    // Only add if at least email, subject, or body is present
    if (email || subject || bodyText) {
      results.push({
        email: email,
        subject: subject,
        body: bodyText
      });
    }
  }

  return results;
}

/**
 * Strip Markdown Fences
 * Strips accidental markdown code fences (like ```json, ```text, or ```)
 * from the beginning and end of the input before parsing.
 */
function stripMarkdownFences(str) {
  if (!str || typeof str !== 'string') return '';
  let text = str.trim();
  text = text.replace(/^(`{3,}|~{3,})[a-zA-Z0-9_-]*[^\S\r\n]*\r?\n?/i, '');
  text = text.replace(/\r?\n?[^\S\r\n]*(`{3,}|~{3,})[^\S\r\n]*$/i, '');
  return text.trim();
}

/**
 * Render All UI Sections
 */
function renderAll() {
  renderAnalyticsBoard(currentAnalytics);
  renderQueueStatus();
  renderStats();
  renderLeadsList();
  renderSpamCheckList();
}

/**
 * Render Queue Monitor Status
 */
function renderQueueStatus() {
  const isRunning = Boolean(currentQueueState.isRunning);

  if (isRunning) {
    liveIndicator.className = 'live-indicator running';
    liveStatusLabel.textContent = 'RUNNING';
    startQueueBtn.disabled = true;
    stopQueueBtn.disabled = false;
    startLocalCountdownTimer();
  } else {
    liveIndicator.className = 'live-indicator';
    liveStatusLabel.textContent = 'IDLE';
    startQueueBtn.disabled = false;
    stopQueueBtn.disabled = true;
    if (localCountdownInterval) {
      clearInterval(localCountdownInterval);
      localCountdownInterval = null;
    }
  }

  queueStatusMessage.textContent = currentQueueState.statusMessage || (isRunning ? 'Processing...' : 'Ready');

  const total = currentLeads.length;
  const sentOrError = currentLeads.filter((l) => l.status === 'sent' || l.status === 'error').length;
  const percentage = total > 0 ? Math.round((sentOrError / total) * 100) : 0;
  progressBarFill.style.width = `${percentage}%`;
}

/**
 * Local Countdown Timer for zero-lag countdowns without storage thrashing
 */
function startLocalCountdownTimer() {
  if (localCountdownInterval) clearInterval(localCountdownInterval);
  localCountdownInterval = setInterval(() => {
    if (!currentQueueState.isRunning || !currentQueueState.nextSendAt) {
      return;
    }
    const remaining = Math.max(0, Math.ceil((currentQueueState.nextSendAt - Date.now()) / 1000));
    if (remaining > 0) {
      queueStatusMessage.textContent = `Waiting ${remaining}s before next email...`;
    }
  }, 1000);
}

/**
 * Render Statistics counters
 */
function renderStats() {
  const total = currentLeads.length;
  const pending = currentLeads.filter((l) => l.status === 'pending').length;
  const sent = currentLeads.filter((l) => l.status === 'sent').length;
  const error = currentLeads.filter((l) => l.status === 'error').length;

  statTotal.textContent = total;
  statPending.textContent = pending;
  statSent.textContent = sent;
  statError.textContent = error;
}

/**
 * Update existing DOM lead cards in-place (Prevents layout thrashing & scroll jumping)
 */
function updateExistingLeadRows(leads) {
  const isQueueRunning = Boolean(currentQueueState.isRunning);
  leads.forEach((lead) => {
    const row = leadsContainer.querySelector(`[data-card-id="${lead.id}"]`);
    if (!row) return;

    const currentClasses = Array.from(row.classList);
    const oldStatus = currentClasses.find((c) => c.startsWith('status-'));
    const newStatus = `status-${lead.status}`;
    if (oldStatus !== newStatus) {
      if (oldStatus) row.classList.remove(oldStatus);
      row.classList.add(newStatus);
    }

    const badge = row.querySelector('.status-toggle-badge');
    if (badge) {
      const isCompact = row.classList.contains('compact-lead-row');
      badge.className = `badge badge-${lead.status} ${isCompact ? 'compact-badge ' : ''}status-toggle-badge`;
      const statusText =
        lead.status === 'sending'
          ? 'Sending...'
          : lead.status === 'sent'
          ? 'Sent'
          : lead.status === 'error'
          ? 'Error'
          : 'Pending';
      let sentTimeStr = '';
      if (lead.sentAt && !isCompact) {
        const d = new Date(lead.sentAt);
        sentTimeStr = ` (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
      }
      badge.textContent = statusText + sentTimeStr;
    }

    const autoSendBtn = row.querySelector('.auto-send-btn');
    if (autoSendBtn) {
      const isSending = lead.status === 'sending';
      autoSendBtn.disabled = isSending || isQueueRunning;
    }

    const composeBtn = row.querySelector('.compose-btn');
    if (composeBtn) {
      composeBtn.disabled = lead.status === 'sending';
    }

    const deleteBtn = row.querySelector('.delete-lead-btn');
    if (deleteBtn) {
      deleteBtn.disabled = lead.status === 'sending';
    }
  });
}

/**
 * Render Leads List (Ultra-fast batch HTML generation)
 */
function renderLeadsList() {
  const filtered = currentLeads.filter((lead) => {
    if (currentFilter) {
      const emailMatch = lead.email.toLowerCase().includes(currentFilter);
      const subjectMatch = (lead.subject || '').toLowerCase().includes(currentFilter);
      if (!emailMatch && !subjectMatch) return false;
    }
    if (isFilterQueueViewActive && filterRules.length > 0) {
      if (!evaluateLeadMatch(lead, filterRules, filterMatchMode)) {
        return false;
      }
    }
    return true;
  });

  if (leadsCountBadge) {
    leadsCountBadge.textContent = isFilterQueueViewActive
      ? `${filtered.length} Filtered Leads`
      : `${filtered.length} Leads`;
  }

  if (filtered.length === 0) {
    leadsContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect width="20" height="16" x="2" y="4" rx="2"/>
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
        </svg>
        <p>${currentLeads.length === 0 ? 'No leads loaded yet.' : 'No leads match your filter.'}</p>
        <p style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">
          ${currentLeads.length === 0 ? 'Upload or paste your CSV above to get started.' : 'Try a different search term or reset filter rules.'}
        </p>
      </div>
    `;
    return;
  }

  const isCompact = currentLayout.density === 'compact';
  leadsContainer.classList.toggle('compact', isCompact);

  const isQueueRunning = Boolean(currentQueueState.isRunning);

  // BCC Mode Queue Compiler: Rearranges pending leads into compiled BCC batch cards
  if (Boolean(currentSettings.enableBccMode)) {
    const rawBatchSize = parseInt(currentSettings.bccBatchSize, 10) || 10;
    const batchSize = Math.max(2, Math.min(100, rawBatchSize));
    const pendingLeads = filtered.filter((l) => l.status === 'pending');
    const otherLeads = filtered.filter((l) => l.status !== 'pending');

    const batches = [];
    for (let i = 0; i < pendingLeads.length; i += batchSize) {
      batches.push(pendingLeads.slice(i, i + batchSize));
    }

    if (leadsCountBadge) {
      leadsCountBadge.textContent = isFilterQueueViewActive
        ? `${filtered.length} Filtered Leads (${batches.length} BCC Batches)`
        : `${pendingLeads.length} Pending (${batches.length} BCC Batches)`;
    }

    const htmlChunks = [];

    // Render compiled BCC Batches
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];
      const isAnyPriority = batch.some((l) => l.isPrioritized);
      const isExpanded = expandedBccBatches.has(bIdx);
      const isSending = batch.some((l) => l.status === 'sending');
      const batchLeadIdsStr = batch.map((l) => l.id).join(',');

      // Chips for recipient emails: 1st is To, others are BCC
      const maxChips = 4;
      const chipEmails = batch.slice(0, maxChips);
      const remainingCount = batch.length - maxChips;
      const chipsHtml = chipEmails
        .map((l, cIdx) => `
          <span class="bcc-chip ${cIdx === 0 ? 'bcc-chip-to' : ''}" title="${cIdx === 0 ? 'To (Primary): ' : 'BCC: '}${escapeHtml(l.email)}">
            ${cIdx === 0 ? '<strong style="color: #a5b4fc;">To:</strong> ' : '<span style="color: var(--text-dim);">BCC:</span> '}${escapeHtml(l.email)}
          </span>
        `)
        .join('') + (remainingCount > 0 ? `<span class="bcc-chip-more">+${remainingCount} more in BCC</span>` : '');

      if (isCompact) {
        htmlChunks.push(`
          <div class="compact-bcc-batch-row ${isSending ? 'is-sending' : ''}" data-batch-index="${bIdx}">
            <div class="compact-bcc-info">
              <span class="compact-bcc-title">⚡ Batch #${bIdx + 1}</span>
              <span class="compact-bcc-leads-count">${batch.length} Leads</span>
              ${isAnyPriority ? '<span class="badge badge-priority" style="font-size: 8.5px; padding: 1px 4px;">⭐</span>' : ''}
              <span class="compact-bcc-subject" title="${escapeHtml(batch[0].subject || '')}">${escapeHtml(batch[0].subject || '(Template subject rotation)')}</span>
            </div>
            <div class="compact-actions">
              <button class="btn btn-secondary btn-xs compose-bcc-batch-btn" data-batch-ids="${batchLeadIdsStr}" title="Compose BCC batch in Gmail tab" ${isSending ? 'disabled' : ''}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
              </button>
              <button class="btn btn-primary btn-xs send-bcc-batch-btn" data-batch-ids="${batchLeadIdsStr}" title="Auto-send this BCC batch immediately" ${(isSending || isQueueRunning) ? 'disabled' : ''}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
              <button class="btn btn-secondary btn-xs view-bcc-body-btn" data-lead-id="${batch[0].id}" title="Preview Email Body">
                👁️
              </button>
              <button class="btn btn-secondary btn-xs toggle-bcc-expand-btn" data-batch-index="${bIdx}" title="${isExpanded ? 'Hide leads list' : 'View all leads'}">
                ${isExpanded ? '▲' : '▼'}
              </button>
            </div>
          </div>
          <div class="bcc-batch-leads-list" id="bccBatchLeadsList_${bIdx}" style="display: ${isExpanded ? 'flex' : 'none'}; margin-bottom: 8px;">
            ${batch.map((lead, lIdx) => `
              <div class="bcc-lead-subrow status-${lead.status}" data-card-id="${lead.id}">
                <span class="bcc-subrow-idx">#${lIdx + 1}</span>
                <span class="bcc-subrow-email" title="${escapeHtml(lead.email)}">${lIdx === 0 ? '<strong style="color: #a5b4fc;">[To]</strong> ' : ''}${escapeHtml(lead.email)}</span>
                <span class="badge badge-${lead.status} compact-badge status-toggle-badge" data-id="${lead.id}" title="Click to toggle status" style="cursor: pointer;">${lead.status}</span>
                <div class="bcc-subrow-actions">
                  <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose single lead">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                    </svg>
                  </button>
                  <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead from queue">
                    ✕
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        `);
      } else {
        htmlChunks.push(`
          <div class="bcc-batch-card ${isSending ? 'is-sending' : ''}" data-batch-index="${bIdx}">
            <div class="bcc-batch-header">
              <div class="bcc-batch-title-area">
                <span class="bcc-batch-idx">⚡ BCC Batch #${bIdx + 1}</span>
                <span class="bcc-batch-pill">${batch.length} Leads</span>
                ${isAnyPriority ? '<span class="badge badge-priority">⭐ Priority</span>' : ''}
              </div>
              <span class="badge ${isSending ? 'badge-sending' : 'badge-pending'}">${isSending ? 'Sending...' : 'Ready'}</span>
            </div>

            <div class="bcc-batch-summary">
              <div class="bcc-batch-subject" title="${escapeHtml(batch[0].subject || '')}">
                <strong>Subject:</strong> ${escapeHtml(batch[0].subject || '(Template subject rotation)')}
              </div>
              <div class="bcc-recipients-header">
                <span class="bcc-label">To: <strong style="color: var(--text-main);">${escapeHtml(batch[0].email)}</strong> ${batch.length > 1 ? `• BCC (${batch.length - 1} leads):` : ''}</span>
              </div>
              <div class="bcc-chips-container">
                ${chipsHtml}
              </div>
            </div>

            <div class="bcc-batch-actions">
              <button class="btn btn-secondary btn-xs compose-bcc-batch-btn" data-batch-ids="${batchLeadIdsStr}" title="Stage this BCC batch in Gmail" ${isSending ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
                Compose Batch
              </button>

              <button class="btn btn-primary btn-xs send-bcc-batch-btn" data-batch-ids="${batchLeadIdsStr}" title="Auto-send this BCC batch immediately" ${(isSending || isQueueRunning) ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Send Batch
              </button>

              <button class="btn btn-secondary btn-xs view-bcc-body-btn" data-lead-id="${batch[0].id}" title="Preview Body">
                👁️ Preview Body
              </button>

              <button class="btn btn-secondary btn-xs toggle-bcc-expand-btn" data-batch-index="${bIdx}">
                <span class="toggle-expand-text">${isExpanded ? 'Hide Leads ▲' : `View Leads (${batch.length}) ▼`}</span>
              </button>
            </div>

            <div class="bcc-batch-leads-list" id="bccBatchLeadsList_${bIdx}" style="display: ${isExpanded ? 'flex' : 'none'};">
              ${batch.map((lead, lIdx) => `
                <div class="bcc-lead-subrow status-${lead.status}" data-card-id="${lead.id}">
                  <span class="bcc-subrow-idx">#${lIdx + 1}</span>
                  <span class="bcc-subrow-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
                  <span class="badge badge-${lead.status} status-toggle-badge" data-id="${lead.id}" title="Click to toggle status" style="cursor: pointer;">${lead.status}</span>
                  <div class="bcc-subrow-actions">
                    <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose single lead">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 20h9"/>
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                      </svg>
                    </button>
                    <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead from queue">
                      ✕
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `);
      }
    }

    // Render otherLeads (sent or error) below compiled batches
    if (otherLeads.length > 0) {
      htmlChunks.push(`<div class="bcc-processed-section-header">Processed / Sent Leads (${otherLeads.length})</div>`);
      for (let oIdx = 0; oIdx < otherLeads.length; oIdx++) {
        const lead = otherLeads[oIdx];
        const badgeClass = `badge-${lead.status}`;
        const statusText = lead.status === 'sent' ? 'Sent' : lead.status === 'error' ? 'Error' : lead.status;
        let sentTimeStr = '';
        if (lead.sentAt) {
          const d = new Date(lead.sentAt);
          sentTimeStr = ` (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
        }
        if (isCompact) {
          htmlChunks.push(`
            <div class="compact-lead-row status-${lead.status}" data-card-id="${lead.id}">
              <span class="compact-idx">✓</span>
              <span class="compact-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
              <span class="compact-subject" title="${escapeHtml(lead.subject || '')}">${escapeHtml(lead.subject || '')}</span>
              <span class="badge ${badgeClass} compact-badge status-toggle-badge" data-id="${lead.id}" style="cursor: pointer;">${statusText}</span>
              <div class="compact-actions">
                <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose single lead">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Resend single email" ${isQueueRunning ? 'disabled' : ''}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead">✕</button>
              </div>
            </div>
          `);
        } else {
          htmlChunks.push(`
            <div class="lead-card status-${lead.status}" data-card-id="${lead.id}">
              <div class="lead-row-top">
                <div class="lead-meta">
                  <span class="lead-idx">✓</span>
                  <span class="lead-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
                </div>
                <span class="badge ${badgeClass} status-toggle-badge" data-id="${lead.id}" style="cursor: pointer;">${statusText}${sentTimeStr}</span>
              </div>
              <div class="lead-subject">${escapeHtml(lead.subject || '')}</div>
              ${lead.errorMessage ? `<div class="lead-error-msg">${escapeHtml(lead.errorMessage)}</div>` : ''}
              <div class="lead-actions">
                <button class="btn btn-secondary btn-xs view-body-btn" data-id="${lead.id}">Preview Body</button>
                <div class="lead-action-btns">
                  <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose in Gmail tab">Compose</button>
                  <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Resend single email" ${isQueueRunning ? 'disabled' : ''}>
                    Resend 1
                  </button>
                  <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead">✕</button>
                </div>
              </div>
            </div>
          `);
        }
      }
    }

    leadsContainer.innerHTML = htmlChunks.join('');
    return;
  }

  const totalToShow = Math.min(filtered.length, leadsDisplayLimit);
  const htmlChunks = [];

  for (let index = 0; index < totalToShow; index++) {
    const lead = filtered[index];
    const isPrioritized = Boolean(lead.isPrioritized);
    const badgeClass = `badge-${lead.status}`;
    const statusText =
      lead.status === 'sending'
        ? 'Sending...'
        : lead.status === 'sent'
        ? 'Sent'
        : lead.status === 'error'
        ? 'Error'
        : 'Pending';

    let sentTimeStr = '';
    if (lead.sentAt) {
      const d = new Date(lead.sentAt);
      sentTimeStr = ` (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    }

    const isSending = lead.status === 'sending';

    if (isCompact) {
      htmlChunks.push(`
        <div class="compact-lead-row status-${lead.status} ${isPrioritized ? 'is-prioritized' : ''}" data-card-id="${lead.id}">
          <span class="compact-idx">#${index + 1}</span>
          ${isPrioritized ? '<span class="badge badge-priority" title="Prioritized lead - sent first">⭐ Priority</span>' : ''}
          <span class="compact-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
          <span class="compact-subject" title="${escapeHtml(lead.subject || '')}">${escapeHtml(lead.subject || '(No subject)')}</span>
          <span class="badge ${badgeClass} compact-badge status-toggle-badge" data-id="${lead.id}" title="Click to manually toggle status" style="cursor: pointer;">${statusText}</span>
          <div class="compact-actions">
            <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose in Gmail tab" ${isSending ? 'disabled' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
            </button>
            <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Auto-send single email" ${(isSending || isQueueRunning) ? 'disabled' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </button>
            <button class="btn btn-secondary btn-xs view-body-btn" data-id="${lead.id}" title="Preview Body">
              👁️
            </button>
            <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead" ${isSending ? 'disabled' : ''}>
              ✕
            </button>
          </div>
        </div>
      `);
    } else {
      htmlChunks.push(`
        <div class="lead-card status-${lead.status} ${isPrioritized ? 'is-prioritized' : ''}" data-card-id="${lead.id}">
          <div class="lead-row-top">
            <div class="lead-meta">
              <span class="lead-idx">#${index + 1}</span>
              ${isPrioritized ? '<span class="badge badge-priority" title="Prioritized lead - sent first">⭐ Priority</span>' : ''}
              <span class="lead-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
            </div>
            <span class="badge ${badgeClass} status-toggle-badge" data-id="${lead.id}" title="Click to manually toggle status" style="cursor: pointer;">${statusText}${sentTimeStr}</span>
          </div>
          <div class="lead-subject" title="${escapeHtml(lead.subject || '')}">${escapeHtml(lead.subject || '')}</div>
          ${lead.errorMessage ? `<div class="lead-error-msg">${escapeHtml(lead.errorMessage)}</div>` : ''}
          <div class="lead-actions">
            <button class="btn btn-secondary btn-xs view-body-btn" data-id="${lead.id}">Preview Body</button>
            <div class="lead-action-btns">
              <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose in Gmail tab" ${isSending ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
                Compose
              </button>
              <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Auto-send single email" ${(isSending || isQueueRunning) ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                ${lead.status === 'sent' ? 'Resend 1' : 'Auto-Send 1'}
              </button>
              <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Remove lead" ${isSending ? 'disabled' : ''}>
                ✕
              </button>
            </div>
          </div>
        </div>
      `);
    }
  }

  if (filtered.length > totalToShow) {
    htmlChunks.push(`
      <div style="text-align: center; padding: 10px;">
        <button id="showAllLeadsBtn" class="btn btn-secondary btn-xs" style="width: 100%;">
          Showing first ${totalToShow} of ${filtered.length} leads. Click to show all.
        </button>
      </div>
    `);
  }

  leadsContainer.innerHTML = htmlChunks.join('');
}

/**
 * Toggle single lead status between pending and sent
 */
async function handleToggleLeadStatus(leadId) {
  const { leads = [], analytics = { lifetimeSent: 0, dailyHistory: {} } } = await chrome.storage.local.get(['leads', 'analytics']);
  const idx = leads.findIndex((l) => l.id === leadId);
  if (idx !== -1) {
    const isCurrentlySent = leads[idx].status === 'sent';
    leads[idx] = {
      ...leads[idx],
      status: isCurrentlySent ? 'pending' : 'sent',
      sentAt: isCurrentlySent ? null : new Date().toISOString(),
      errorMessage: null
    };

    analytics.dailyHistory = analytics.dailyHistory || {};
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!isCurrentlySent) {
      analytics.lifetimeSent = (analytics.lifetimeSent || 0) + 1;
      analytics.dailyHistory[todayStr] = (analytics.dailyHistory[todayStr] || 0) + 1;
    } else {
      if (analytics.lifetimeSent > 0) analytics.lifetimeSent--;
      if (analytics.dailyHistory[todayStr] > 0) analytics.dailyHistory[todayStr]--;
    }

    currentAnalytics = analytics;
    await chrome.storage.local.set({ leads, analytics });
  }
}

/**
 * Handle Manual Compose: in-page Gmail automation
 */
async function handleManualCompose(lead) {
  const banner = lead.isSpamCheck ? spamCheckBanner : statusBanner;
  showBanner(banner, `Connecting to Gmail to compose for ${lead.email}...`, 'success');

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'MANUAL_IN_PAGE_COMPOSE',
      lead: lead
    });

    if (res && res.success) {
      showBanner(banner, `Draft populated in Gmail for ${lead.email}! Review and click Send.`, 'success');
    } else {
      console.warn('In-page compose fallback to standalone URL:', res?.error);
      const composeUrl =
        'https://mail.google.com/mail/?view=cm&fs=1' +
        `&to=${encodeURIComponent(lead.email || '')}` +
        `&su=${encodeURIComponent(lead.subject || '')}` +
        `&body=${encodeURIComponent(lead.body || '')}`;
      chrome.tabs.create({ url: composeUrl, active: true });
      showBanner(banner, `Opened Gmail compose tab for ${lead.email}.`, 'success');
    }
  } catch (err) {
    console.error('Error invoking in-page compose:', err);
    showBanner(banner, `Error: ${err.message}`, 'error');
  }
}

/**
 * Handle Compose BCC Batch: in-page Gmail automation staging with all batch leads in BCC
 */
async function handleComposeBccBatch(leadIds) {
  showBanner(statusBanner, `Connecting to Gmail to stage BCC batch (${leadIds.length} leads)...`, 'info');
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'COMPOSE_BCC_BATCH',
      leadIds: leadIds
    });
    if (res && res.success) {
      const bccCount = Math.max(0, leadIds.length - 1);
      showBanner(statusBanner, `Draft staged in Gmail! 1 in To${bccCount > 0 ? `, ${bccCount} in BCC` : ''}. Review and click Send.`, 'success');
    } else {
      const batchLeads = currentLeads.filter((l) => leadIds.includes(l.id));
      const allEmails = batchLeads.map((l) => (l.email || '').trim()).filter(Boolean);
      const toEmail = allEmails[0] || '';
      const bccList = allEmails.slice(1);
      const subject = batchLeads[0]?.subject || '';
      const body = batchLeads[0]?.body || '';
      const composeUrl =
        'https://mail.google.com/mail/?view=cm&fs=1' +
        (toEmail ? `&to=${encodeURIComponent(toEmail)}` : '') +
        (bccList.length > 0 ? `&bcc=${encodeURIComponent(bccList.join(','))}` : '') +
        `&su=${encodeURIComponent(subject)}` +
        `&body=${encodeURIComponent(body)}`;
      chrome.tabs.create({ url: composeUrl, active: true });
      showBanner(statusBanner, `Opened Gmail compose tab with To: ${toEmail}${bccList.length ? ` and ${bccList.length} in BCC` : ''}.`, 'success');
    }
  } catch (err) {
    console.error('Error composing BCC batch:', err);
    showBanner(statusBanner, `Error staging BCC batch: ${err.message}`, 'error');
  }
}

/**
 * Handle Send BCC Batch: dispatches the entire compiled BCC batch on-demand
 */
async function handleSendBccBatch(leadIds) {
  showBanner(statusBanner, `Sending BCC batch of ${leadIds.length} leads...`, 'info');
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'SEND_BCC_BATCH',
      leadIds: leadIds
    });
    if (res && res.success) {
      showBanner(statusBanner, `BCC batch of ${leadIds.length} leads sent successfully!`, 'success');
    } else {
      showBanner(statusBanner, `BCC batch send failed: ${res?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    console.error('Error sending BCC batch:', err);
    showBanner(statusBanner, `Error sending BCC batch: ${err.message}`, 'error');
  }
}

/**
 * Handle Single Auto-Send
 */
async function handleSingleAutoSend(leadId, isSpamCheck = false) {
  const banner = isSpamCheck ? spamCheckBanner : statusBanner;
  hideBanner(banner);
  const res = await chrome.runtime.sendMessage({
    action: 'SEND_SINGLE',
    leadId: leadId,
    isSpamCheck: isSpamCheck
  });

  if (res && !res.success) {
    showBanner(banner, `Send failed: ${res.error || 'Unknown error'}`, 'error');
  }
}

/**
 * Delete a lead
 */
async function handleDeleteLead(leadId) {
  const updated = currentLeads.filter((l) => l.id !== leadId);
  await chrome.storage.local.set({ leads: updated });
}

/**
 * Delete a spam-check lead
 */
async function handleDeleteSpamCheckLead(leadId) {
  const updated = currentSpamCheckLeads.filter((l) => l.id !== leadId);
  await chrome.storage.local.set({ spamCheckLeads: updated });
}

/**
 * Toggle single spam-check lead status between pending and sent
 */
async function handleToggleSpamCheckStatus(leadId) {
  const { spamCheckLeads = [] } = await chrome.storage.local.get('spamCheckLeads');
  const idx = spamCheckLeads.findIndex((l) => l.id === leadId);
  if (idx !== -1) {
    const isCurrentlySent = spamCheckLeads[idx].status === 'sent';
    spamCheckLeads[idx] = {
      ...spamCheckLeads[idx],
      status: isCurrentlySent ? 'pending' : 'sent',
      sentAt: isCurrentlySent ? null : new Date().toISOString(),
      errorMessage: null
    };
    await chrome.storage.local.set({ spamCheckLeads });
  }
}

/**
 * Sync Spam-Check subject and body from current CSV Template
 */
function syncSpamCheckTemplateFromCsv(overwrite = true) {
  if (!spamCheckSubject || !spamCheckBody) return;
  const currentSub = csvSubjectTemplate ? csvSubjectTemplate.value.trim() : '';
  const currentBody = csvBodyTemplate ? csvBodyTemplate.value.trim() : '';

  if (overwrite || !spamCheckSubject.value.trim()) {
    if (currentSub) {
      spamCheckSubject.value = currentSub
        .replace(/\{name\}/gi, 'Friend')
        .replace(/\{company\}/gi, 'Company')
        .replace(/\{url\}/gi, 'example.com')
        .replace(/\{country\}/gi, 'United States');
    }
  }

  if (overwrite || !spamCheckBody.value.trim()) {
    if (currentBody) {
      spamCheckBody.value = currentBody
        .replace(/\{name\}/gi, 'Friend')
        .replace(/\{company\}/gi, 'Company')
        .replace(/\{url\}/gi, 'example.com')
        .replace(/\{country\}/gi, 'United States');
    }
  }
}

/**
 * Load Spam-Check Leads from email input box
 */
async function handleLoadSpamCheck() {
  hideBanner(spamCheckBanner);
  const rawInput = spamCheckEmailInput ? spamCheckEmailInput.value.trim() : '';

  if (!rawInput) {
    showBanner(spamCheckBanner, 'Please enter at least one test email address.', 'error');
    return;
  }

  // Extract all valid email addresses
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = rawInput.match(emailRegex);

  if (!matches || matches.length === 0) {
    showBanner(spamCheckBanner, 'No valid email addresses found in the input.', 'error');
    return;
  }

  // Deduplicate emails in this batch
  const uniqueEmails = Array.from(new Set(matches.map((m) => m.trim().toLowerCase())));

  // Subject and Body for test emails
  const testSub = (spamCheckSubject?.value || csvSubjectTemplate?.value || 'Spam & Deliverability Test').trim() || 'Spam & Deliverability Test';
  const testBody = spamCheckBody?.value || csvBodyTemplate?.value || 'Hi,\n\nThis is a deliverability test to verify inbox placement.\n\nBest regards';

  const newTestLeads = uniqueEmails.map((email) => ({
    id: 'spamcheck_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    email: email,
    subject: testSub,
    body: testBody,
    status: 'pending',
    errorMessage: null,
    sentAt: null,
    isSpamCheck: true
  }));

  const { spamCheckLeads: existing = [] } = await chrome.storage.local.get('spamCheckLeads');
  const merged = [...existing, ...newTestLeads];
  await chrome.storage.local.set({ spamCheckLeads: merged });

  if (spamCheckEmailInput) spamCheckEmailInput.value = '';
  showBanner(spamCheckBanner, `Successfully loaded ${newTestLeads.length} test email(s)! (Total: ${merged.length})`, 'success');
}

/**
 * Render Spam-Check Leads Queue (Completely separate from campaign leads)
 */
function renderSpamCheckList() {
  if (!spamCheckContainer) return;

  const total = currentSpamCheckLeads.length;
  if (spamCheckCountBadge) {
    spamCheckCountBadge.textContent = `${total} Tests`;
  }

  if (total === 0) {
    spamCheckContainer.innerHTML = `
      <div class="empty-state" style="padding: 16px 8px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 26px; height: 26px; color: var(--text-dim); margin: 0 auto 6px; display: block;">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <p style="font-size: 12px; font-weight: 600; color: var(--text-main);">No spam-check emails loaded yet</p>
        <p style="font-size: 11px; color: var(--text-dim); margin-top: 3px;">
          Insert test email addresses above (e.g. Gmail, Outlook, Yahoo) and click Load.
        </p>
      </div>
    `;
    if (spamCheckQueueStatus) spamCheckQueueStatus.textContent = 'Ready to test deliverability.';
    return;
  }

  const pendingCount = currentSpamCheckLeads.filter((l) => l.status === 'pending').length;
  const sentCount = currentSpamCheckLeads.filter((l) => l.status === 'sent').length;
  const errCount = currentSpamCheckLeads.filter((l) => l.status === 'error').length;
  if (spamCheckQueueStatus) {
    spamCheckQueueStatus.textContent = `${pendingCount} Pending, ${sentCount} Sent, ${errCount} Errors.`;
  }

  const isCompact = currentLayout.density === 'compact';
  const htmlChunks = [];

  for (let index = 0; index < currentSpamCheckLeads.length; index++) {
    const lead = currentSpamCheckLeads[index];
    const badgeClass = `badge-${lead.status}`;
    const statusText =
      lead.status === 'sending'
        ? 'Sending...'
        : lead.status === 'sent'
        ? 'Sent'
        : lead.status === 'error'
        ? 'Error'
        : 'Pending';

    let sentTimeStr = '';
    if (lead.sentAt) {
      const d = new Date(lead.sentAt);
      sentTimeStr = ` (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    }

    const isSending = lead.status === 'sending';

    if (isCompact) {
      htmlChunks.push(`
        <div class="compact-lead-row status-${lead.status}" data-card-id="${lead.id}">
          <span class="compact-idx">#${index + 1}</span>
          <span class="compact-email" title="${escapeHtml(lead.email)}">
            <span style="display: inline-block; font-size: 9px; padding: 1px 4px; background: rgba(79, 70, 229, 0.15); color: var(--primary); border-radius: 3px; margin-right: 4px; font-weight: 700;">TEST</span>
            ${escapeHtml(lead.email)}
          </span>
          <span class="compact-subject" title="${escapeHtml(lead.subject || '')}">${escapeHtml(lead.subject || '(No subject)')}</span>
          <span class="badge ${badgeClass} compact-badge status-toggle-badge" data-id="${lead.id}" title="Click to manually toggle status" style="cursor: pointer;">${statusText}</span>
          <div class="compact-actions">
            <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose in Gmail tab" ${isSending ? 'disabled' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
            </button>
            <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Auto-send test email" ${isSending ? 'disabled' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </button>
            <button class="btn btn-secondary btn-xs view-body-btn" data-id="${lead.id}" title="Preview Email">
              👁️
            </button>
            <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Delete test lead" ${isSending ? 'disabled' : ''}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              </svg>
            </button>
          </div>
        </div>
      `);
    } else {
      const bodySnippet = lead.body
        ? lead.body.substring(0, 90).replace(/\n/g, ' ') + (lead.body.length > 90 ? '...' : '')
        : '<em>(No body)</em>';

      htmlChunks.push(`
        <div class="lead-card status-${lead.status}" data-card-id="${lead.id}" style="border-left: 3px solid var(--primary);">
          <div class="lead-card-header">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="lead-idx">#${index + 1}</span>
              <span class="brand-tag" style="font-size: 9px; padding: 1px 4px; background: rgba(79, 70, 229, 0.15); color: var(--primary);">TEST INBOX</span>
              <span class="lead-email" title="${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</span>
            </div>
            <span class="badge ${badgeClass} status-toggle-badge" data-id="${lead.id}" title="Click to manually toggle status" style="cursor: pointer;">${statusText}${sentTimeStr}</span>
          </div>
          <div class="lead-subject"><strong>Subject:</strong> ${escapeHtml(lead.subject || '(No subject)')}</div>
          <div class="lead-body-preview">${escapeHtml(bodySnippet)}</div>
          ${lead.errorMessage ? `<div class="lead-error-msg">⚠️ ${escapeHtml(lead.errorMessage)}</div>` : ''}
          <div class="lead-card-actions">
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-xs compose-btn" data-id="${lead.id}" title="Compose in Gmail tab" ${isSending ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
                Compose
              </button>
              <button class="btn btn-primary btn-xs auto-send-btn" data-id="${lead.id}" title="Auto-send test email" ${isSending ? 'disabled' : ''}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Send Test
              </button>
              <button class="btn btn-secondary btn-xs view-body-btn" data-id="${lead.id}">
                👁️ Preview
              </button>
            </div>
            <button class="btn btn-outline-danger btn-xs delete-lead-btn" data-id="${lead.id}" title="Delete test lead" ${isSending ? 'disabled' : ''}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              </svg>
            </button>
          </div>
        </div>
      `);
    }
  }

  spamCheckContainer.innerHTML = htmlChunks.join('');
}

/**
 * Open Email Preview Modal
 */
function openPreviewModal(lead) {
  modalRecipient.textContent = `Lead: ${lead.email}`;
  modalSubject.textContent = lead.subject || '(No subject)';
  modalBody.textContent = lead.body || '(No body)';
  previewModal.classList.add('open');
}

/**
 * Export CSV Report
 */
function handleExportReportCsv() {
  if (currentLeads.length === 0) {
    showBanner(statusBanner, 'No leads to export.', 'error');
    return;
  }

  const headers = ['Email', 'Subject', 'Body', 'Status', 'Sent At', 'Error Message'];
  const rows = currentLeads.map((lead) => [
    formatCsvCell(lead.email),
    formatCsvCell(lead.subject),
    formatCsvCell(lead.body),
    formatCsvCell(lead.status),
    formatCsvCell(lead.sentAt || ''),
    formatCsvCell(lead.errorMessage || '')
  ]);

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `midey_leads_report_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showBanner(statusBanner, 'CSV report downloaded successfully.', 'success');
}

/**
 * CSV cell formatter
 */
function formatCsvCell(str) {
  if (str === null || str === undefined) return '""';
  const stringValue = String(str);
  return '"' + stringValue.replace(/"/g, '""') + '"';
}

/**
 * Show notification banner
 */
function showBanner(bannerEl, message, type = 'success') {
  if (!bannerEl) return;
  bannerEl.textContent = message;
  bannerEl.className = `banner visible banner-${type}`;
}

/**
 * Hide notification banner
 */
function hideBanner(bannerEl) {
  if (!bannerEl) return;
  bannerEl.className = 'banner';
  bannerEl.textContent = '';
}

/**
 * HTML Escaper
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * =========================================================================
 * Content Sync & Excel-Style Lead Prioritizer & Multi-Filter Engine
 * =========================================================================
 */

/**
 * Safely extract a normalized key-value row map from a lead
 */
function getLeadRowObj(lead) {
  if (!lead) return {};
  const email = (lead.email || '').trim();
  const domain = (email.split('@')[1] || '').toLowerCase();
  return {
    ...(lead.rowObj || {}),
    email,
    domain,
    subject: lead.subject || '',
    body: lead.body || ''
  };
}

/**
 * Sync Content: Re-render Subject and Body on all pending leads in queue
 */
async function handleSyncContentToLeads() {
  hideBanner(contentSyncBanner);
  const isMulti = Boolean(currentSettings?.enableMultiContent);
  const subjTemplate = csvSubjectTemplate ? csvSubjectTemplate.value : '';
  const bodyTemplate = csvBodyTemplate ? csvBodyTemplate.value : '';

  const subjects = isMulti
    ? (currentSettings.subjectTemplates || []).filter((s) => s && s.trim())
    : [];
  const bodies = isMulti
    ? (currentSettings.bodyTemplates || []).filter((b) => b && b.trim())
    : [];

  if (!isMulti && !subjTemplate && !bodyTemplate) {
    showBanner(contentSyncBanner, 'Subject and Body templates are both empty.', 'error');
    return;
  }
  if (isMulti && subjects.length === 0 && bodies.length === 0) {
    showBanner(contentSyncBanner, 'Please add at least one Subject or Body variation before syncing.', 'error');
    return;
  }

  const { leads = [] } = await chrome.storage.local.get('leads');
  if (leads.length === 0) {
    showBanner(contentSyncBanner, 'No leads loaded in queue to update.', 'error');
    return;
  }

  let updatedCount = 0;
  let pendingIdx = 0;
  const updatedLeads = leads.map((lead) => {
    // Keep already sent leads untouched as immutable history
    if (lead.status === 'sent') return lead;

    const rowObj = getLeadRowObj(lead);
    let newSubject = '';
    let newBody = '';

    if (isMulti) {
      const rotated = getRotatedContentForIndex(pendingIdx, currentSettings);
      newSubject = rotated.subject.trim() ? replaceTemplateTags(rotated.subject, rowObj) : (lead.subject || '');
      newBody = rotated.body.trim() ? replaceTemplateTags(rotated.body, rowObj) : (lead.body || '');
      pendingIdx++;
    } else {
      newSubject = subjTemplate.trim() ? replaceTemplateTags(subjTemplate, rowObj) : (lead.subject || '');
      newBody = bodyTemplate.trim() ? replaceTemplateTags(bodyTemplate, rowObj) : (lead.body || '');
    }

    updatedCount++;
    return {
      ...lead,
      subject: newSubject,
      body: newBody,
      errorMessage: null
    };
  });

  // Auto-save templates and updated leads
  currentLeads = updatedLeads;
  await chrome.storage.local.set({
    leads: updatedLeads,
    csvTemplate: { subject: subjTemplate, body: bodyTemplate },
    settings: currentSettings
  });

  renderLeadsList();

  let detailStr = '';
  if (isMulti) {
    const targetLabel =
      currentSettings.contentRotationTarget === 'both'
        ? 'Subject & Body'
        : currentSettings.contentRotationTarget === 'subject'
        ? 'Subject only'
        : 'Body only';
    const modeLabel = currentSettings.contentRotationMode === 'random' ? 'Random' : 'Sequential';
    detailStr = ` with multi-content rotation (${targetLabel}, ${modeLabel})`;
  }

  showBanner(
    contentSyncBanner,
    `Successfully synced updated templates${detailStr} to ${updatedCount} pending lead${updatedCount === 1 ? '' : 's'}!`,
    'success'
  );
}

/**
 * Collect all available column headers from current leads
 */
function getAvailableFilterColumns() {
  const colSet = new Set();

  currentLeads.forEach((lead) => {
    const rowObj = getLeadRowObj(lead);
    Object.keys(rowObj).forEach((k) => {
      const lower = k.toLowerCase().trim();
      if (
        lower &&
        lower !== 'body' &&
        lower !== 'id' &&
        lower !== 'status' &&
        lower !== 'sentat' &&
        lower !== 'errormessage' &&
        lower !== 'isprioritized' &&
        lower !== 'rowobj'
      ) {
        colSet.add(lower);
      }
    });
  });

  if (colSet.size === 0) {
    colSet.add('email');
  }

  const cols = Array.from(colSet);
  return cols.sort((a, b) => a.localeCompare(b));
}

/**
 * Get up to 50 distinct values for a given column for dropdown autocomplete
 */
function getColumnDistinctValues(col) {
  if (!col) return [];
  const targetCol = col.toLowerCase().trim();
  const valSet = new Set();

  for (const lead of currentLeads) {
    const rowObj = getLeadRowObj(lead);
    const val = rowObj[targetCol];
    if (val !== undefined && val !== null && String(val).trim()) {
      valSet.add(String(val).trim());
      if (valSet.size >= 50) break;
    }
  }
  return Array.from(valSet);
}

/**
 * Evaluate whether a single lead satisfies the filter rules
 */
function evaluateLeadMatch(lead, rules = filterRules, matchMode = filterMatchMode) {
  if (!rules || rules.length === 0) return false;
  const rowObj = getLeadRowObj(lead);

  const checkRule = (rule) => {
    if (!rule || !rule.col) return true;
    const colKey = rule.col.toLowerCase().trim();
    const cellValue = String(rowObj[colKey] !== undefined ? rowObj[colKey] : '').trim().toLowerCase();
    const filterVal = String(rule.val || '').trim().toLowerCase();
    const op = rule.op || 'contains';

    switch (op) {
      case 'contains':
        return filterVal ? cellValue.includes(filterVal) : true;
      case 'not_contains':
        return filterVal ? !cellValue.includes(filterVal) : true;
      case 'equals':
        return filterVal ? cellValue === filterVal : true;
      case 'not_equals':
        return filterVal ? cellValue !== filterVal : true;
      case 'starts_with':
        return filterVal ? cellValue.startsWith(filterVal) : true;
      case 'ends_with':
        return filterVal ? cellValue.endsWith(filterVal) : true;
      case 'is_empty':
        return cellValue === '';
      case 'is_not_empty':
        return cellValue !== '';
      default:
        return cellValue.includes(filterVal);
    }
  };

  if (matchMode === 'OR') {
    return rules.some(checkRule);
  } else {
    return rules.every(checkRule);
  }
}

/**
 * Set Filter Match Logic (AND vs OR)
 */
function setFilterMatchMode(mode, save = true) {
  filterMatchMode = mode === 'OR' ? 'OR' : 'AND';
  if (filterMatchAndBtn && filterMatchOrBtn) {
    if (filterMatchMode === 'AND') {
      filterMatchAndBtn.classList.add('active');
      filterMatchAndBtn.style.background = 'var(--primary)';
      filterMatchAndBtn.style.color = '#fff';
      filterMatchOrBtn.classList.remove('active');
      filterMatchOrBtn.style.background = 'transparent';
      filterMatchOrBtn.style.color = 'var(--text-muted)';
    } else {
      filterMatchOrBtn.classList.add('active');
      filterMatchOrBtn.style.background = 'var(--primary)';
      filterMatchOrBtn.style.color = '#fff';
      filterMatchAndBtn.classList.remove('active');
      filterMatchAndBtn.style.background = 'transparent';
      filterMatchAndBtn.style.color = 'var(--text-muted)';
    }
  }
  updateFilterMatchStats();
  if (isFilterQueueViewActive) {
    renderLeadsList();
  }
  if (save) {
    chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
  }
}

/**
 * Add a new Excel filter rule row
 */
function addFilterRule(col = '', op = 'contains', val = '') {
  const availableCols = getAvailableFilterColumns();
  const defaultCol = col || availableCols[0] || 'email';
  const newRule = {
    id: 'rule_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    col: defaultCol,
    op: op,
    val: val
  };
  filterRules.push(newRule);
  renderFilterRules();
  updateFilterMatchStats();
  chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
}

/**
 * Remove an existing filter rule
 */
function removeFilterRule(ruleId) {
  filterRules = filterRules.filter((r) => r.id !== ruleId);
  renderFilterRules();
  updateFilterMatchStats();
  if (isFilterQueueViewActive) {
    renderLeadsList();
  }
  chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
}

/**
 * Clear all filter rules
 */
function handleClearFilterRules() {
  filterRules = [];
  renderFilterRules();
  updateFilterMatchStats();
  if (isFilterQueueViewActive) {
    isFilterQueueViewActive = false;
    if (toggleFilterViewBtn) {
      toggleFilterViewBtn.classList.remove('active');
      toggleFilterViewBtn.style.background = '';
      toggleFilterViewBtn.style.color = '';
      toggleFilterViewBtn.textContent = '👁️ Filter View Only';
    }
    renderLeadsList();
  }
  hideBanner(filterStatusBanner);
  chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
}

/**
 * Render Filter Rule Rows into DOM with focus and caret retention
 */
function renderFilterRules() {
  if (!filterRulesList) return;

  // Track focused element and cursor position so focus is never lost while interacting
  const activeEl = document.activeElement;
  let activeRuleId = null;
  let activeField = null; // 'val' | 'col' | 'op'
  let selStart = null;
  let selEnd = null;

  if (activeEl && filterRulesList.contains(activeEl)) {
    activeRuleId = activeEl.dataset.ruleId;
    if (activeEl.classList.contains('filter-val-input')) {
      activeField = 'val';
      selStart = activeEl.selectionStart;
      selEnd = activeEl.selectionEnd;
    } else if (activeEl.classList.contains('filter-col-select')) {
      activeField = 'col';
    } else if (activeEl.classList.contains('filter-op-select')) {
      activeField = 'op';
    }
  }

  if (filterRules.length === 0) {
    filterRulesList.innerHTML = `
      <div style="font-size: 11px; color: var(--text-dim); padding: 8px 10px; background: var(--bg-base); border: 1px dashed var(--border-subtle); border-radius: var(--radius-sm); text-align: center;">
        No filter rules added yet. Click <strong>+ Add Rule</strong> above to filter leads by any column from your CSV file.
      </div>
    `;
    return;
  }

  const columns = getAvailableFilterColumns();
  const operatorOptions = [
    { value: 'contains', label: 'contains' },
    { value: 'equals', label: 'equals (=)' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'ends_with', label: 'ends with' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'not_equals', label: 'does not equal (!=)' },
    { value: 'is_empty', label: 'is empty' },
    { value: 'is_not_empty', label: 'is not empty' }
  ];

  const html = filterRules.map((rule, idx) => {
    const colOptionsHtml = columns
      .map((c) => {
        let label = c;
        if (c === 'domain') label = 'Email Domain (@domain.com)';
        else if (c === 'email') label = 'Email';
        else label = c.charAt(0).toUpperCase() + c.slice(1);
        return `<option value="${escapeHtml(c)}" ${rule.col.toLowerCase() === c.toLowerCase() ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      })
      .join('');

    const opOptionsHtml = operatorOptions
      .map((op) => `<option value="${op.value}" ${rule.op === op.value ? 'selected' : ''}>${op.label}</option>`)
      .join('');

    const suggestions = getColumnDistinctValues(rule.col);
    const datalistId = `datalist_${rule.id}`;
    const datalistHtml = suggestions.length > 0
      ? `<datalist id="${datalistId}">${suggestions.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('')}</datalist>`
      : '';

    const hideValInput = rule.op === 'is_empty' || rule.op === 'is_not_empty';

    return `
      <div class="filter-rule-row" data-rule-id="${rule.id}">
        <span class="filter-rule-idx" style="font-size: 10px; font-weight: 700; color: var(--text-dim); min-width: 14px;">#${idx + 1}</span>
        <select class="setting-input filter-col-select" data-rule-id="${rule.id}" title="Select column to filter">
          ${colOptionsHtml}
        </select>
        <select class="setting-input filter-op-select" data-rule-id="${rule.id}" title="Filter condition">
          ${opOptionsHtml}
        </select>
        <input type="text"
               class="setting-input filter-val-input"
               data-rule-id="${rule.id}"
               list="${datalistId}"
               value="${escapeHtml(rule.val || '')}"
               placeholder="Filter value..."
               style="${hideValInput ? 'display: none;' : ''}"
               title="Type filter value">
        ${datalistHtml}
        <button class="filter-remove-rule-btn" data-rule-id="${rule.id}" title="Delete this rule">✕</button>
      </div>
    `;
  }).join('');

  filterRulesList.innerHTML = html;

  // Restore focus and caret position if an input or select was previously active
  if (activeRuleId) {
    let elToFocus = null;
    if (activeField === 'val') {
      elToFocus = filterRulesList.querySelector(`.filter-val-input[data-rule-id="${activeRuleId}"]`);
    } else if (activeField === 'col') {
      elToFocus = filterRulesList.querySelector(`.filter-col-select[data-rule-id="${activeRuleId}"]`);
    } else if (activeField === 'op') {
      elToFocus = filterRulesList.querySelector(`.filter-op-select[data-rule-id="${activeRuleId}"]`);
    }

    if (elToFocus) {
      elToFocus.focus();
      if (activeField === 'val' && selStart !== null && selEnd !== null) {
        try {
          elToFocus.setSelectionRange(selStart, selEnd);
        } catch (_) {}
      }
    }
  }
}

/**
 * Handle changes in column or operator selects in filter rules
 */
function handleFilterRuleChange(e) {
  const colSelect = e.target.closest('.filter-col-select');
  if (colSelect) {
    const ruleId = colSelect.dataset.ruleId;
    const rule = filterRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.col = colSelect.value;
      renderFilterRules();
      updateFilterMatchStats();
      if (isFilterQueueViewActive) renderLeadsList();
      chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
    }
    return;
  }

  const opSelect = e.target.closest('.filter-op-select');
  if (opSelect) {
    const ruleId = opSelect.dataset.ruleId;
    const rule = filterRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.op = opSelect.value;
      renderFilterRules();
      updateFilterMatchStats();
      if (isFilterQueueViewActive) renderLeadsList();
      chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
    }
    return;
  }
}

/**
 * Debounced input handler for filter values (preserves typing focus)
 */
let filterInputDebounce = null;
function handleFilterRuleInput(e) {
  const valInput = e.target.closest('.filter-val-input');
  if (valInput) {
    const ruleId = valInput.dataset.ruleId;
    const rule = filterRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.val = valInput.value;
      updateFilterMatchStats();
      if (isFilterQueueViewActive) renderLeadsList();
      clearTimeout(filterInputDebounce);
      filterInputDebounce = setTimeout(() => {
        chrome.storage.local.set({ filterSettings: { rules: filterRules, matchMode: filterMatchMode } });
      }, 400);
    }
  }
}

/**
 * Click handler for filter rule removal
 */
function handleFilterRuleClick(e) {
  const delBtn = e.target.closest('.filter-remove-rule-btn');
  if (delBtn && delBtn.dataset.ruleId) {
    removeFilterRule(delBtn.dataset.ruleId);
  }
}

/**
 * Update the dynamic matching statistics label
 */
function updateFilterMatchStats() {
  if (!filterMatchCountText) return;
  if (filterRules.length === 0) {
    filterMatchCountText.textContent = `0 rules active (${currentLeads.length} leads in queue)`;
    return;
  }

  const matchingLeads = currentLeads.filter((l) => evaluateLeadMatch(l, filterRules, filterMatchMode));
  const matchingPending = matchingLeads.filter((l) => l.status === 'pending');

  filterMatchCountText.innerHTML = `<strong>${matchingPending.length}</strong> pending (${matchingLeads.length} total) match criteria`;
}

/**
 * Prioritize Matching Leads: Reorders leads array so matching pending leads are sent first
 */
async function handlePrioritizeLeads() {
  hideBanner(filterStatusBanner);
  if (filterRules.length === 0) {
    showBanner(
      filterStatusBanner,
      'Please add at least one filter rule first (e.g. Country = US or Domain = gmail.com).',
      'error'
    );
    return;
  }

  const { leads = [] } = await chrome.storage.local.get('leads');
  if (leads.length === 0) {
    showBanner(filterStatusBanner, 'No leads in queue to prioritize.', 'error');
    return;
  }

  const matchingPending = [];
  const otherPending = [];
  const otherLeads = [];

  leads.forEach((lead) => {
    if (lead.status === 'pending') {
      if (evaluateLeadMatch(lead, filterRules, filterMatchMode)) {
        matchingPending.push({ ...lead, isPrioritized: true });
      } else {
        otherPending.push({ ...lead, isPrioritized: false });
      }
    } else {
      otherLeads.push(lead);
    }
  });

  if (matchingPending.length === 0) {
    showBanner(
      filterStatusBanner,
      'No pending leads matched your current filter criteria.',
      'info'
    );
    return;
  }

  const reorderedLeads = [...matchingPending, ...otherPending, ...otherLeads];
  await chrome.storage.local.set({ leads: reorderedLeads });

  showBanner(
    filterStatusBanner,
    `🚀 Prioritized ${matchingPending.length} matching lead${matchingPending.length === 1 ? '' : 's'}! They are now at the top of the queue and will be sent first.`,
    'success'
  );
}

/**
 * Toggle Filter-Only View of Queue
 */
function handleToggleFilterView() {
  if (filterRules.length === 0 && !isFilterQueueViewActive) {
    showBanner(filterStatusBanner, 'Add at least one rule to filter queue view.', 'info');
    return;
  }
  isFilterQueueViewActive = !isFilterQueueViewActive;
  if (toggleFilterViewBtn) {
    if (isFilterQueueViewActive) {
      toggleFilterViewBtn.classList.add('active');
      toggleFilterViewBtn.style.background = 'var(--primary)';
      toggleFilterViewBtn.style.color = '#fff';
      toggleFilterViewBtn.textContent = '👁️ Showing Filtered Only';
    } else {
      toggleFilterViewBtn.classList.remove('active');
      toggleFilterViewBtn.style.background = '';
      toggleFilterViewBtn.style.color = '';
      toggleFilterViewBtn.textContent = '👁️ Filter View Only';
    }
  }
  renderLeadsList();
}
