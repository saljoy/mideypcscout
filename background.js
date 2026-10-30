/**
 * Gmail JSON Sender - Background Service Worker (Manifest V3)
 * Manages the automated queue, single-lead sending, Gmail tab lifecycle,
 * and reliable content script injection for sending emails.
 */

// Track active processing in current worker instance to avoid duplicate loops
let isQueueProcessing = false;
let currentActiveTabId = null;

// Synchronous top-level event listeners (MV3 requirement)
chrome.runtime.onInstalled.addListener(async (details) => {
  await initializeDefaults();
  console.log('Gmail JSON Sender installed successfully. Defaults initialized.');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'queue_watchdog') {
    const data = await chrome.storage.local.get(['queueState', 'leads']);
    if (data.queueState?.isRunning && !isQueueProcessing) {
      console.log('Watchdog detected active queue, resuming processing...');
      runQueueLoop();
    }
  } else if (alarm.name === 'anti_sleep_timer') {
    console.log('[Anti-Sleep] Keep-awake timer expired, releasing power lock...');
    await releaseAntiSleepLock('Timer expired');
  }
});

// Activation validity duration: 30 days (1 month)
const ACTIVATION_VALIDITY_DAYS = 30;
const ACTIVATION_VALIDITY_MS = ACTIVATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async operations cleanly
  handleRuntimeMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('Error in message listener:', err);
    sendResponse({ success: false, error: err.message });
  });
  return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages from popup or side panel
 */
async function handleRuntimeMessage(message, sender) {
  const { action, leadId, settings, windowId } = message || {};

  // Security gate: Ensure workspace is activated and within valid 30-day window before executing dispatches
  const dispatchActions = [
    'START_QUEUE',
    'SEND_SINGLE',
    'START_SPAM_CHECK_QUEUE',
    'MANUAL_IN_PAGE_COMPOSE',
    'COMPOSE_BCC_BATCH',
    'SEND_BCC_BATCH'
  ];
  if (dispatchActions.includes(action)) {
    const { isAppActivated, appActivatedAt } = await chrome.storage.local.get(['isAppActivated', 'appActivatedAt']);
    const now = Date.now();
    const isExpired = !appActivatedAt || (now - appActivatedAt >= ACTIVATION_VALIDITY_MS);
    if (isAppActivated === false || isExpired) {
      if (isAppActivated && isExpired) {
        await chrome.storage.local.set({ isAppActivated: false });
      }
      return { success: false, error: 'Extension authorization has expired (valid for 30 days). Please re-enter the master key in the popup.' };
    }
  }

  switch (action) {
    case 'START_QUEUE': {
      const data = await chrome.storage.local.get(['leads', 'queueState', 'settings', 'antiSleepState']);
      const leads = data.leads || [];
      const hasPending = leads.some((l) => l.status === 'pending');

      if (!hasPending) {
        return { success: false, error: 'No pending leads found to send.' };
      }

      // Auto-acquire anti-sleep keep-awake lock if enabled
      const settings = data.settings || {};
      if (settings.keepAwakeDuringQueue !== false) {
        const antiSleepState = data.antiSleepState;
        if (!antiSleepState?.isActive || antiSleepState?.reason === 'queue') {
          await acquireAntiSleepLock('queue', null);
        }
      }

      await chrome.storage.local.set({
        queueState: {
          isRunning: true,
          currentLeadId: null,
          statusMessage: 'Starting queue...',
          countdownSec: null,
          updatedAt: Date.now()
        }
      });

      chrome.alarms.create('queue_watchdog', { periodInMinutes: 1 });

      if (!isQueueProcessing) {
        // Fire-and-forget loop in background
        runQueueLoop();
      }
      return { success: true };
    }

    case 'STOP_QUEUE': {
      await stopQueue('Queue stopped by user.');
      return { success: true };
    }

    case 'SEND_SINGLE': {
      if (!leadId) {
        return { success: false, error: 'Missing leadId parameter.' };
      }
      const storageKey = message.isSpamCheck ? 'spamCheckLeads' : 'leads';
      const result = await executeAutoSendForLead(leadId, storageKey);
      return result;
    }

    case 'START_SPAM_CHECK_QUEUE': {
      const { spamCheckLeads = [] } = await chrome.storage.local.get('spamCheckLeads');
      const hasPending = spamCheckLeads.some((l) => l.status === 'pending');
      if (!hasPending) {
        return { success: false, error: 'No pending spam-check leads found to send.' };
      }
      runSpamCheckQueueLoop();
      return { success: true };
    }

    case 'STOP_SPAM_CHECK_QUEUE': {
      isSpamCheckQueueProcessing = false;
      return { success: true };
    }

    case 'RESET_SPAM_CHECK_STATUSES': {
      const { spamCheckLeads = [] } = await chrome.storage.local.get('spamCheckLeads');
      const resetLeads = spamCheckLeads.map((lead) => ({
        ...lead,
        status: 'pending',
        errorMessage: null,
        sentAt: null
      }));
      await chrome.storage.local.set({ spamCheckLeads: resetLeads });
      return { success: true };
    }

    case 'CLEAR_SPAM_CHECK_ALL': {
      isSpamCheckQueueProcessing = false;
      await chrome.storage.local.set({ spamCheckLeads: [] });
      return { success: true };
    }

    case 'RESET_STATUSES': {
      const { leads = [] } = await chrome.storage.local.get('leads');
      const resetLeads = leads.map((lead) => ({
        ...lead,
        status: 'pending',
        errorMessage: null,
        sentAt: null
      }));
      await chrome.storage.local.set({
        leads: resetLeads,
        queueState: {
          isRunning: false,
          currentLeadId: null,
          statusMessage: 'Lead statuses reset to pending.',
          countdownSec: null,
          updatedAt: Date.now()
        }
      });
      return { success: true };
    }

    case 'CLEAR_ALL': {
      await stopQueue('Queue cleared.');
      await chrome.storage.local.set({
        leads: [],
        queueState: {
          isRunning: false,
          currentLeadId: null,
          statusMessage: 'All leads cleared.',
          countdownSec: null,
          updatedAt: Date.now()
        }
      });
      return { success: true };
    }

    case 'MANUAL_IN_PAGE_COMPOSE': {
      const { lead } = message || {};
      if (!lead) {
        return { success: false, error: 'Missing lead object.' };
      }
      return await handleInPageCompose(lead);
    }

    case 'COMPOSE_BCC_BATCH': {
      const { leadIds } = message || {};
      if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return { success: false, error: 'No lead IDs provided for BCC batch.' };
      }
      const { leads = [], settings = {} } = await chrome.storage.local.get(['leads', 'settings']);
      const batchLeads = leads.filter((l) => leadIds.includes(l.id));
      if (batchLeads.length === 0) {
        return { success: false, error: 'None of the batch leads were found in queue.' };
      }

      let resolvedSubject = batchLeads[0].subject || '';
      let resolvedBody = batchLeads[0].body || '';
      if (settings.enableMultiContent && settings.enableContentRotation) {
        const nextRot = await getNextRotatedContent(settings);
        if (nextRot) {
          if (nextRot.subject) resolvedSubject = nextRot.subject;
          if (nextRot.body) resolvedBody = nextRot.body;
        }
      }

      const allEmails = batchLeads.map((l) => (l.email || '').trim()).filter(Boolean);
      const toEmail = allEmails[0] || null;
      const bccEmails = allEmails.slice(1);
      return await handleInPageCompose({
        email: toEmail,
        bccEmails: bccEmails,
        subject: resolvedSubject,
        body: resolvedBody
      });
    }

    case 'SEND_BCC_BATCH': {
      const { leadIds } = message || {};
      if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return { success: false, error: 'No lead IDs provided for BCC batch.' };
      }
      const { leads = [], settings = {} } = await chrome.storage.local.get(['leads', 'settings']);
      const batchLeads = leads.filter((l) => leadIds.includes(l.id));
      if (batchLeads.length === 0) {
        return { success: false, error: 'None of the batch leads were found in queue.' };
      }
      return await executeAutoSendForBccBatch(batchLeads, settings, 'leads');
    }

    case 'START_ANTI_SLEEP': {
      const durationMinutes = message.durationMinutes !== undefined ? message.durationMinutes : 60;
      const state = await acquireAntiSleepLock(message.reason || 'timer', durationMinutes);
      return { success: true, antiSleepState: state };
    }

    case 'STOP_ANTI_SLEEP': {
      const state = await releaseAntiSleepLock(message.reason || 'Stopped by user');
      return { success: true, antiSleepState: state };
    }

    case 'GET_ANTI_SLEEP_STATUS': {
      const { antiSleepState } = await chrome.storage.local.get('antiSleepState');
      return { success: true, antiSleepState: antiSleepState || { isActive: false } };
    }

    case 'OPEN_SIDE_PANEL': {
      await removeInPageDockFromAllTabs();
      if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
        const targetWindowId = windowId || (await getCurrentWindowId());
        if (targetWindowId) {
          await chrome.sidePanel.open({ windowId: targetWindowId });
          await chrome.storage.local.set({ dockMode: 'sidepanel' });
          return { success: true };
        }
      }
      return { success: false, error: 'Side panel API unavailable or window not found.' };
    }

    case 'DOCK_POPOUT': {
      await removeInPageDockFromAllTabs();
      const width = 480;
      const height = 760;
      let left = 100;
      let top = 80;
      try {
        const curWin = await chrome.windows.getCurrent();
        if (curWin) {
          left = Math.max(0, (curWin.left || 0) + (curWin.width || 1200) - width - 20);
          top = Math.max(0, (curWin.top || 0) + 40);
        }
      } catch (_) {}

      const newWin = await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?dock=window'),
        type: 'popup',
        width,
        height,
        left,
        top,
        focused: true
      });
      await chrome.storage.local.set({ dockMode: 'popout' });
      return { success: true, windowId: newWin.id };
    }

    case 'DOCK_INPAGE': {
      const position = message.position === 'left' || message.position === 'bottom' ? message.position : 'right';
      let targetTab = null;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
        targetTab = activeTab;
      } else {
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        if (tabs.length > 0) {
          targetTab = tabs[0];
          await chrome.tabs.update(targetTab.id, { active: true });
          if (targetTab.windowId) {
            await chrome.windows.update(targetTab.windowId, { focused: true });
          }
        }
      }

      if (!targetTab) {
        return { success: false, error: 'Please open Gmail (mail.google.com) to dock Midey in-page.' };
      }

      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: injectedInPageDockScript,
        args: [position, chrome.runtime.getURL('popup.html?dock=inpage&pos=' + position)]
      });

      await chrome.storage.local.set({ dockMode: position });
      return { success: true, tabId: targetTab.id };
    }

    case 'CLOSE_INPAGE_DOCK': {
      await removeInPageDockFromAllTabs();
      await chrome.storage.local.set({ dockMode: 'default' });
      return { success: true };
    }

    case 'GET_DOCK_MODE': {
      const { dockMode = 'default' } = await chrome.storage.local.get('dockMode');
      return { success: true, dockMode };
    }

    case 'START_COORDINATE_PICKER': {
      let targetTab = null;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
        targetTab = activeTab;
      } else {
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        if (tabs.length > 0) {
          targetTab = tabs[0];
          await chrome.tabs.update(targetTab.id, { active: true });
          if (targetTab.windowId) {
            await chrome.windows.update(targetTab.windowId, { focused: true });
          }
        }
      }

      if (!targetTab) {
        return { success: false, error: 'Please open Gmail (mail.google.com) in your browser before calibrating coordinates.' };
      }

      const { settings = {} } = await chrome.storage.local.get('settings');
      const targetMode = message?.mode || settings.confidentialCoordinates?.mode || '3point';

      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: injectedCoordinatePickerScript,
        args: [targetMode]
      });

      return { success: true };
    }

    case 'SAVE_CONFIDENTIAL_COORDS': {
      const { coords } = message || {};
      if (coords) {
        const { settings = {} } = await chrome.storage.local.get('settings');
        const existing = settings.confidentialCoordinates || {};
        const updatedCoords = {
          mode: coords.mode || existing.mode || '3point',
          point1: coords.point1 !== undefined ? coords.point1 : (existing.point1 || null),
          point2: coords.point2 !== undefined ? coords.point2 : (existing.point2 || null),
          point3: coords.point3 !== undefined ? coords.point3 : (existing.point3 || null),
          delayMs: coords.delay1Ms || coords.delayMs || existing.delay1Ms || existing.delayMs || 350,
          delay1Ms: coords.delay1Ms || coords.delayMs || existing.delay1Ms || 350,
          delay2Ms: coords.delay2Ms || existing.delay2Ms || 400
        };
        const updatedSettings = {
          ...settings,
          enableConfidentialCoordsOverride: true,
          confidentialCoordinates: updatedCoords
        };
        await chrome.storage.local.set({ settings: updatedSettings });
        return { success: true, settings: updatedSettings };
      }
      return { success: false, error: 'Missing coordinates data.' };
    }

    case 'TEST_CONFIDENTIAL_COORDS': {
      const { settings = {} } = await chrome.storage.local.get('settings');
      const coords = settings.confidentialCoordinates;
      if (!coords || !coords.point1) {
        return { success: false, error: 'No coordinates saved yet. Click "🎯 Calibrate on Gmail" first.' };
      }

      let targetTab = null;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
        targetTab = activeTab;
      } else {
        const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
        if (tabs.length > 0) targetTab = tabs[0];
      }

      if (!targetTab) {
        return { success: false, error: 'Please open Gmail (mail.google.com) to test the coordinates.' };
      }

      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: injectedCoordinateTestScript,
        args: [coords]
      });

      return { success: true };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

/**
 * Initialize default settings in storage
 */
async function initializeDefaults() {
  const current = await chrome.storage.local.get(['settings', 'leads', 'queueState', 'antiSleepState', 'isAppActivated', 'appActivatedAt']);
  const updates = {};

  if (current.isAppActivated === undefined) {
    updates.isAppActivated = false;
  } else if (current.isAppActivated === true) {
    const now = Date.now();
    if (!current.appActivatedAt || (now - current.appActivatedAt >= ACTIVATION_VALIDITY_MS)) {
      updates.isAppActivated = false;
    }
  }

  if (!current.settings) {
    updates.settings = {
      minDelaySec: 20,
      maxDelaySec: 40,
      autoCloseTab: true,
      inPageAutoSend: false,
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
      enableConfidentialMode: false,
      confidentialExpiration: '1w',
      enableConfidentialCoordsOverride: false,
      confidentialCoordinates: { mode: '3point', point1: null, point2: null, point3: null, delayMs: 350, delay1Ms: 350, delay2Ms: 400 }
    };
  } else {
    // Ensure new settings exist if settings were already initialized previously
    const existingSettings = { ...current.settings };
    let settingsChanged = false;
    if (existingSettings.inPageAutoSend === undefined) {
      existingSettings.inPageAutoSend = false;
      settingsChanged = true;
    }
    if (existingSettings.enableSignature === undefined) {
      existingSettings.enableSignature = false;
      settingsChanged = true;
    }
    if (!Array.isArray(existingSettings.signatures)) {
      existingSettings.signatures = [];
      settingsChanged = true;
    }
    if (!existingSettings.signatureRotationMode) {
      existingSettings.signatureRotationMode = 'sequential';
      settingsChanged = true;
    }
    if (existingSettings.enableBccMode === undefined) {
      existingSettings.enableBccMode = false;
      settingsChanged = true;
    }
    if (existingSettings.bccBatchSize === undefined) {
      existingSettings.bccBatchSize = 10;
      settingsChanged = true;
    }
    if (existingSettings.keepAwakeDuringQueue === undefined) {
      existingSettings.keepAwakeDuringQueue = true;
      settingsChanged = true;
    }
    if (existingSettings.enableMultiContent === undefined) {
      existingSettings.enableMultiContent = false;
      settingsChanged = true;
    }
    if (!existingSettings.contentRotationTarget) {
      existingSettings.contentRotationTarget = 'both';
      settingsChanged = true;
    }
    if (!existingSettings.contentRotationMode) {
      existingSettings.contentRotationMode = 'sequential';
      settingsChanged = true;
    }
    if (!Array.isArray(existingSettings.subjectTemplates)) {
      existingSettings.subjectTemplates = [];
      settingsChanged = true;
    }
    if (!Array.isArray(existingSettings.bodyTemplates)) {
      existingSettings.bodyTemplates = [];
      settingsChanged = true;
    }
    if (existingSettings.enableConfidentialMode === undefined) {
      existingSettings.enableConfidentialMode = false;
      settingsChanged = true;
    }
    if (!existingSettings.confidentialExpiration) {
      existingSettings.confidentialExpiration = '1w';
      settingsChanged = true;
    }
    if (existingSettings.enableConfidentialCoordsOverride === undefined) {
      existingSettings.enableConfidentialCoordsOverride = false;
      settingsChanged = true;
    }
    if (!existingSettings.confidentialCoordinates) {
      existingSettings.confidentialCoordinates = { mode: '3point', point1: null, point2: null, point3: null, delayMs: 350, delay1Ms: 350, delay2Ms: 400 };
      settingsChanged = true;
    } else {
      if (!existingSettings.confidentialCoordinates.mode) {
        existingSettings.confidentialCoordinates.mode = '3point';
        settingsChanged = true;
      }
      if (existingSettings.confidentialCoordinates.delay1Ms === undefined) {
        existingSettings.confidentialCoordinates.delay1Ms = existingSettings.confidentialCoordinates.delayMs || 350;
        settingsChanged = true;
      }
      if (existingSettings.confidentialCoordinates.delay2Ms === undefined) {
        existingSettings.confidentialCoordinates.delay2Ms = 400;
        settingsChanged = true;
      }
    }
    if (settingsChanged) {
      updates.settings = existingSettings;
    }
  }

  if (!current.antiSleepState) {
    updates.antiSleepState = {
      isActive: false,
      reason: null,
      durationMinutes: null,
      expiresAt: null,
      startedAt: null
    };
  }

  if (!Array.isArray(current.leads)) {
    updates.leads = [];
  }

  if (!Array.isArray(current.spamCheckLeads)) {
    updates.spamCheckLeads = [];
  }

  if (!current.queueState) {
    updates.queueState = {
      isRunning: false,
      currentLeadId: null,
      statusMessage: 'Ready',
      countdownSec: null,
      updatedAt: Date.now()
    };
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

/**
 * Acquire Power keep-awake lock to prevent PC / OS / Display from sleeping
 */
async function acquireAntiSleepLock(reason = 'manual', durationMinutes = null) {
  try {
    if (chrome.power && typeof chrome.power.requestKeepAwake === 'function') {
      chrome.power.requestKeepAwake('display');
      console.log(`[Anti-Sleep] Acquired display keep-awake lock. Reason: ${reason}`);
    }
  } catch (err) {
    console.warn('[Anti-Sleep] chrome.power.requestKeepAwake error:', err);
  }

  let expiresAt = null;
  const numMin = parseInt(durationMinutes, 10);
  if (!isNaN(numMin) && numMin > 0) {
    expiresAt = Date.now() + numMin * 60 * 1000;
    chrome.alarms.create('anti_sleep_timer', { when: expiresAt });
  } else {
    chrome.alarms.clear('anti_sleep_timer');
  }

  const state = {
    isActive: true,
    reason,
    durationMinutes: numMin > 0 ? numMin : null,
    expiresAt,
    startedAt: Date.now()
  };

  await chrome.storage.local.set({ antiSleepState: state });
  return state;
}

/**
 * Release Power keep-awake lock
 */
async function releaseAntiSleepLock(reason = 'stopped') {
  try {
    if (chrome.power && typeof chrome.power.releaseKeepAwake === 'function') {
      chrome.power.releaseKeepAwake();
      console.log(`[Anti-Sleep] Released display keep-awake lock. Reason: ${reason}`);
    }
  } catch (err) {
    console.warn('[Anti-Sleep] chrome.power.releaseKeepAwake error:', err);
  }

  chrome.alarms.clear('anti_sleep_timer');

  const state = {
    isActive: false,
    reason,
    durationMinutes: null,
    expiresAt: null,
    startedAt: null
  };

  await chrome.storage.local.set({ antiSleepState: state });
  return state;
}

/**
 * Stop the active queue
 */
async function stopQueue(reason = 'Queue stopped.') {
  chrome.alarms.clear('queue_watchdog');
  isQueueProcessing = false;

  const { queueState, antiSleepState } = await chrome.storage.local.get(['queueState', 'antiSleepState']);
  if (antiSleepState?.isActive && antiSleepState?.reason === 'queue') {
    await releaseAntiSleepLock('Queue stopped');
  }

  await chrome.storage.local.set({
    queueState: {
      ...(queueState || {}),
      isRunning: false,
      countdownSec: null,
      statusMessage: reason,
      updatedAt: Date.now()
    }
  });
}

/**
 * Main queue processing loop
 */
async function runQueueLoop() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  try {
    while (true) {
      // 1. Read fresh state
      const { queueState, leads = [], settings = {} } = await chrome.storage.local.get([
        'queueState',
        'leads',
        'settings'
      ]);

      // Check if queue was stopped
      if (!queueState?.isRunning) {
        break;
      }

      // Check if BCC mode is enabled
      const isBccMode = Boolean(settings.enableBccMode);
      const pendingLeads = leads.filter((l) => l.status === 'pending');

      // 2. Check if any pending leads remain
      if (pendingLeads.length === 0) {
        const { antiSleepState } = await chrome.storage.local.get('antiSleepState');
        if (antiSleepState?.isActive && antiSleepState?.reason === 'queue') {
          await releaseAntiSleepLock('Queue complete');
        }
        await chrome.storage.local.set({
          queueState: {
            isRunning: false,
            currentLeadId: null,
            statusMessage: 'Queue complete! All pending emails have been processed.',
            countdownSec: null,
            updatedAt: Date.now()
          }
        });
        chrome.alarms.clear('queue_watchdog');
        break;
      }

      // 3. Dispatch lead(s) depending on mode
      let sendResult;
      if (isBccMode) {
        const batchSize = Math.max(2, Math.min(100, parseInt(settings.bccBatchSize, 10) || 10));
        const currentBatch = pendingLeads.slice(0, batchSize);

        await chrome.storage.local.set({
          queueState: {
            ...queueState,
            currentLeadId: currentBatch.map((l) => l.id).join(','),
            statusMessage: `Processing BCC batch of ${currentBatch.length} leads...`,
            countdownSec: null,
            updatedAt: Date.now()
          }
        });

        sendResult = await executeAutoSendForBccBatch(currentBatch, settings, 'leads');
      } else {
        const nextLead = pendingLeads[0];

        await chrome.storage.local.set({
          queueState: {
            ...queueState,
            currentLeadId: nextLead.id,
            statusMessage: `Processing email to ${nextLead.email}...`,
            countdownSec: null,
            updatedAt: Date.now()
          }
        });

        sendResult = await executeAutoSendForLead(nextLead.id, 'leads');
      }

      // 5. Check if user stopped queue during sending
      const postSendState = await chrome.storage.local.get('queueState');
      if (!postSendState.queueState?.isRunning) {
        break;
      }

      // 6. Check if more pending leads remain
      const updatedData = await chrome.storage.local.get('leads');
      const remainingPending = (updatedData.leads || []).some((l) => l.status === 'pending');

      if (!remainingPending) {
        const { antiSleepState } = await chrome.storage.local.get('antiSleepState');
        if (antiSleepState?.isActive && antiSleepState?.reason === 'queue') {
          await releaseAntiSleepLock('Queue complete');
        }
        await chrome.storage.local.set({
          queueState: {
            isRunning: false,
            currentLeadId: null,
            statusMessage: 'Queue complete! All emails have been processed.',
            countdownSec: null,
            updatedAt: Date.now()
          }
        });
        chrome.alarms.clear('queue_watchdog');
        break;
      }

      // 7. Calculate randomized delay
      const minSec = Math.max(5, parseInt(settings.minDelaySec, 10) || 20);
      const maxSec = Math.max(minSec, parseInt(settings.maxDelaySec, 10) || 40);
      const delaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
      const nextSendAt = Date.now() + delaySec * 1000;

      // 8. Countdown timer loop
      const currQState = await chrome.storage.local.get('queueState');
      if (currQState.queueState?.isRunning) {
        await chrome.storage.local.set({
          queueState: {
            ...currQState.queueState,
            countdownSec: delaySec,
            nextSendAt: nextSendAt,
            statusMessage: isBccMode
              ? `Waiting ${delaySec}s before next BCC batch (random delay ${minSec}-${maxSec}s)...`
              : `Waiting ${delaySec}s before next email (random delay ${minSec}-${maxSec}s)...`,
            updatedAt: Date.now()
          }
        });
      }

      for (let remaining = delaySec; remaining > 0; remaining--) {
        await sleep(1000);
        const checkState = await chrome.storage.local.get('queueState');
        if (!checkState.queueState?.isRunning) {
          break;
        }

        // Heartbeat storage write only every 5 seconds or final 2 seconds
        if (remaining % 5 === 0 || remaining <= 2) {
          await chrome.storage.local.set({
            queueState: {
              ...checkState.queueState,
              countdownSec: remaining,
              nextSendAt: nextSendAt,
              statusMessage: isBccMode
                ? `Waiting ${remaining}s before next BCC batch (random delay ${minSec}-${maxSec}s)...`
                : `Waiting ${remaining}s before next email (random delay ${minSec}-${maxSec}s)...`,
              updatedAt: Date.now()
            }
          });
        }
      }

      // Check once more after countdown
      const afterWaitState = await chrome.storage.local.get('queueState');
      if (!afterWaitState.queueState?.isRunning) {
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in queue loop:', error);
    await stopQueue(`Queue error: ${error.message}`);
  } finally {
    isQueueProcessing = false;
  }
}

/**
 * Execute auto-send routine for a single lead (campaign lead or spam-check lead)
 */
async function executeAutoSendForLead(leadId, storageKey = 'leads') {
  // Read latest leads and settings
  const data = await chrome.storage.local.get([storageKey, 'settings']);
  const leads = data[storageKey] || [];
  const leadIndex = leads.findIndex((l) => l.id === leadId);

  if (leadIndex === -1) {
    return { success: false, error: 'Lead not found.' };
  }

  const targetLead = leads[leadIndex];
  const settings = data.settings || {};

  // Mark lead as sending
  leads[leadIndex] = {
    ...targetLead,
    status: 'sending',
    errorMessage: null
  };
  await chrome.storage.local.set({ [storageKey]: leads });

  // Route depending on inPageAutoSend toggle
  if (settings.inPageAutoSend) {
    return await executeInPageAutoSend(leadId, targetLead, settings, storageKey);
  } else {
    return await executeStandaloneAutoSend(leadId, targetLead, settings, storageKey);
  }
}

/**
 * In-Page Auto-Send (Steps through open Gmail window like manual compose, then clicks Send)
 */
async function executeInPageAutoSend(leadId, targetLead, settings, storageKey = 'leads') {
  try {
    let targetTab = null;

    // 1. Check if the active tab in current window is Gmail
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
      targetTab = activeTab;
    } else {
      // 2. Search for open Gmail tab in current window
      const tabsInWindow = await chrome.tabs.query({ currentWindow: true });
      const gmailInWindow = tabsInWindow.find((t) => t.url && t.url.includes('mail.google.com'));

      if (gmailInWindow) {
        targetTab = gmailInWindow;
        await chrome.tabs.update(targetTab.id, { active: true });
      } else {
        // 3. Search across all browser windows
        const allTabs = await chrome.tabs.query({});
        const anyGmailTab = allTabs.find((t) => t.url && t.url.includes('mail.google.com'));

        if (anyGmailTab) {
          targetTab = anyGmailTab;
          await chrome.tabs.update(targetTab.id, { active: true });
          if (anyGmailTab.windowId) {
            await chrome.windows.update(anyGmailTab.windowId, { focused: true });
          }
        }
      }
    }

    // 4. If no Gmail tab is open at all, open a new one
    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
      await waitForTabComplete(targetTab.id, 25000);
      await sleep(2500);
    } else {
      if (targetTab.status !== 'complete') {
        await waitForTabComplete(targetTab.id, 15000);
      }
      await sleep(400);
    }

    // 5. Compute body with rotating signature if enabled
    const finalBody = await getLeadBodyWithSignature(targetLead.body);

    // 6. Inject in-page compose script with autoSend: true
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: injectedInPageComposeScript,
      args: [
        {
          email: targetLead.email,
          subject: targetLead.subject,
          body: finalBody,
          autoSend: true,
          confidentialMode: Boolean(settings.enableConfidentialMode),
          confidentialCoords: settings.enableConfidentialMode ? (settings.confidentialCoordinates || null) : null
        }
      ]
    });

    const executionResult = results?.[0]?.result;

    if (!executionResult) {
      throw new Error('No response from in-page Gmail script.');
    }

    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Failed to compose and send in-page.');
    }

    // 7. Update lead status to sent & increment global analytics (only if storageKey === 'leads')
    const freshData = await chrome.storage.local.get([storageKey, 'analytics']);
    const freshLeads = freshData[storageKey] || [];
    const idx = freshLeads.findIndex((l) => l.id === leadId);
    if (idx !== -1) {
      freshLeads[idx] = {
        ...freshLeads[idx],
        status: 'sent',
        sentAt: new Date().toISOString(),
        errorMessage: null
      };

      const storagePayload = { [storageKey]: freshLeads };

      // Record in Global Dispatch Analytics only for normal campaign leads
      if (storageKey === 'leads') {
        const todayStr = new Date().toISOString().slice(0, 10);
        const analytics = freshData.analytics || { lifetimeSent: 0, dailyHistory: {} };
        analytics.lifetimeSent = (analytics.lifetimeSent || 0) + 1;
        analytics.dailyHistory = analytics.dailyHistory || {};
        analytics.dailyHistory[todayStr] = (analytics.dailyHistory[todayStr] || 0) + 1;
        storagePayload.analytics = analytics;
      }

      await chrome.storage.local.set(storagePayload);
    }

    return { success: true };
  } catch (error) {
    console.error(`In-page auto-send error for lead ${targetLead.email}:`, error);

    // Update lead status to error
    const freshData = await chrome.storage.local.get(storageKey);
    const freshLeads = freshData[storageKey] || [];
    const idx = freshLeads.findIndex((l) => l.id === leadId);
    if (idx !== -1) {
      freshLeads[idx] = {
        ...freshLeads[idx],
        status: 'error',
        errorMessage: error.message || 'Unknown in-page send error'
      };
      await chrome.storage.local.set({ [storageKey]: freshLeads });
    }

    return { success: false, error: error.message };
  }
}

/**
 * Original auto-send routine (standalone compose tab in background)
 */
async function executeStandaloneAutoSend(leadId, targetLead, settings, storageKey = 'leads') {
  let tab = null;
  const autoClose = settings.autoCloseTab !== false;

  try {
    // 0. Compute body with rotating signature if enabled
    const finalBody = await getLeadBodyWithSignature(targetLead.body);

    // 1. Build prefilled Gmail compose URL
    const composeUrl =
      'https://mail.google.com/mail/?view=cm&fs=1' +
      `&to=${encodeURIComponent(targetLead.email || '')}` +
      `&su=${encodeURIComponent(targetLead.subject || '')}` +
      `&body=${encodeURIComponent(finalBody || '')}`;

    // 2. Open new tab (active: true ensures no background tab throttling by Chrome)
    tab = await chrome.tabs.create({ url: composeUrl, active: true });
    currentActiveTabId = tab.id;

    // 3. Wait for tab navigation to complete
    await waitForTabComplete(tab.id, 25000);

    // 4. Brief yield before injection (injected script active-polls every 100ms)
    await sleep(200);

    // 5. Inject and run auto-send script inside the Gmail tab
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedGmailSendScript,
      args: [
        {
          expectedEmail: targetLead.email,
          expectedSubject: targetLead.subject,
          expectedBody: finalBody,
          confidentialMode: Boolean(settings.enableConfidentialMode),
          confidentialCoords: settings.enableConfidentialMode ? (settings.confidentialCoordinates || null) : null
        }
      ]
    });

    const executionResult = injectionResults?.[0]?.result;

    if (!executionResult) {
      throw new Error('No response from Gmail injected script.');
    }

    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Failed to send email via Gmail.');
    }

    // 6. Update lead status to sent & increment global analytics (only if storageKey === 'leads')
    const freshData = await chrome.storage.local.get([storageKey, 'analytics']);
    const freshLeads = freshData[storageKey] || [];
    const idx = freshLeads.findIndex((l) => l.id === leadId);
    if (idx !== -1) {
      freshLeads[idx] = {
        ...freshLeads[idx],
        status: 'sent',
        sentAt: new Date().toISOString(),
        errorMessage: null
      };

      const storagePayload = { [storageKey]: freshLeads };

      // Record in Global Dispatch Analytics only for normal campaign leads
      if (storageKey === 'leads') {
        const todayStr = new Date().toISOString().slice(0, 10);
        const analytics = freshData.analytics || { lifetimeSent: 0, dailyHistory: {} };
        analytics.lifetimeSent = (analytics.lifetimeSent || 0) + 1;
        analytics.dailyHistory = analytics.dailyHistory || {};
        analytics.dailyHistory[todayStr] = (analytics.dailyHistory[todayStr] || 0) + 1;
        storagePayload.analytics = analytics;
      }

      await chrome.storage.local.set(storagePayload);
    }

    // 7. Auto close tab if configured (Fast cleanup)
    if (autoClose && tab?.id) {
      await sleep(200);
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab might have been manually closed by user
      }
    }

    return { success: true };
  } catch (error) {
    console.error(`Send error for lead ${targetLead.email}:`, error);

    // Update lead status to error
    const freshData = await chrome.storage.local.get(storageKey);
    const freshLeads = freshData[storageKey] || [];
    const idx = freshLeads.findIndex((l) => l.id === leadId);
    if (idx !== -1) {
      freshLeads[idx] = {
        ...freshLeads[idx],
        status: 'error',
        errorMessage: error.message || 'Unknown send error'
      };
      await chrome.storage.local.set({ [storageKey]: freshLeads });
    }

    // Close tab if configured even on error, or leave open if user wants to inspect
    if (autoClose && tab?.id) {
      await sleep(300);
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab already closed
      }
    }

    return { success: false, error: error.message };
  } finally {
    currentActiveTabId = null;
  }
}

/**
 * Execute auto-send routine for a BCC batch of leads
 */
async function executeAutoSendForBccBatch(batch, settings, storageKey = 'leads') {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { success: false, error: 'Empty BCC batch provided.' };
  }

  const batchIdSet = new Set(batch.map((l) => l.id));

  // 1. Mark all leads in the batch as sending
  const data = await chrome.storage.local.get([storageKey, 'settings']);
  const allLeads = data[storageKey] || [];
  const sendingLeads = allLeads.map((l) =>
    batchIdSet.has(l.id) ? { ...l, status: 'sending', errorMessage: null } : l
  );
  await chrome.storage.local.set({ [storageKey]: sendingLeads });

  const allEmails = batch.map((l) => (l.email || '').trim()).filter(Boolean);
  const toEmail = allEmails[0] || null;
  const bccEmails = allEmails.slice(1);
  const subject = batch[0].subject || '';
  const rawBody = batch[0].body || '';
  const finalBody = await getLeadBodyWithSignature(rawBody);

  if (settings.inPageAutoSend) {
    return await executeInPageAutoSendBcc(batch, toEmail, bccEmails, subject, finalBody, settings, storageKey);
  } else {
    return await executeStandaloneAutoSendBcc(batch, toEmail, bccEmails, subject, finalBody, settings, storageKey);
  }
}

/**
 * In-Page Auto-Send for BCC batch
 */
async function executeInPageAutoSendBcc(batch, toEmail, bccEmails, subject, finalBody, settings, storageKey = 'leads') {
  const batchIdSet = new Set(batch.map((l) => l.id));

  try {
    let targetTab = null;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
      targetTab = activeTab;
    } else {
      const tabsInWindow = await chrome.tabs.query({ currentWindow: true });
      const gmailInWindow = tabsInWindow.find((t) => t.url && t.url.includes('mail.google.com'));

      if (gmailInWindow) {
        targetTab = gmailInWindow;
        await chrome.tabs.update(targetTab.id, { active: true });
      } else {
        const allTabs = await chrome.tabs.query({});
        const anyGmailTab = allTabs.find((t) => t.url && t.url.includes('mail.google.com'));

        if (anyGmailTab) {
          targetTab = anyGmailTab;
          await chrome.tabs.update(targetTab.id, { active: true });
          if (anyGmailTab.windowId) {
            await chrome.windows.update(anyGmailTab.windowId, { focused: true });
          }
        }
      }
    }

    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
      await waitForTabComplete(targetTab.id, 25000);
      await sleep(2500);
    } else {
      if (targetTab.status !== 'complete') {
        await waitForTabComplete(targetTab.id, 15000);
      }
      await sleep(400);
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: injectedInPageComposeScript,
      args: [
        {
          email: toEmail,
          bccEmails: bccEmails,
          subject: subject,
          body: finalBody,
          autoSend: true,
          confidentialMode: Boolean(settings.enableConfidentialMode),
          confidentialCoords: settings.enableConfidentialMode ? (settings.confidentialCoordinates || null) : null
        }
      ]
    });

    const executionResult = results?.[0]?.result;
    if (!executionResult) {
      throw new Error('No response from in-page Gmail script for BCC batch.');
    }
    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Failed to compose and send BCC batch in-page.');
    }

    const freshData = await chrome.storage.local.get([storageKey, 'analytics']);
    const freshLeads = freshData[storageKey] || [];
    const nowIso = new Date().toISOString();

    const updatedLeads = freshLeads.map((l) =>
      batchIdSet.has(l.id)
        ? { ...l, status: 'sent', sentAt: nowIso, errorMessage: null }
        : l
    );

    const storagePayload = { [storageKey]: updatedLeads };

    if (storageKey === 'leads') {
      const todayStr = nowIso.slice(0, 10);
      const analytics = freshData.analytics || { lifetimeSent: 0, dailyHistory: {} };
      analytics.lifetimeSent = (analytics.lifetimeSent || 0) + batch.length;
      analytics.dailyHistory = analytics.dailyHistory || {};
      analytics.dailyHistory[todayStr] = (analytics.dailyHistory[todayStr] || 0) + batch.length;
      storagePayload.analytics = analytics;
    }

    await chrome.storage.local.set(storagePayload);
    return { success: true };
  } catch (error) {
    console.error('In-page BCC auto-send error:', error);
    const freshData = await chrome.storage.local.get(storageKey);
    const freshLeads = freshData[storageKey] || [];
    const updatedLeads = freshLeads.map((l) =>
      batchIdSet.has(l.id)
        ? { ...l, status: 'error', errorMessage: error.message || 'Unknown in-page BCC send error' }
        : l
    );
    await chrome.storage.local.set({ [storageKey]: updatedLeads });
    return { success: false, error: error.message };
  }
}

/**
 * Standalone compose tab Auto-Send for BCC batch
 */
async function executeStandaloneAutoSendBcc(batch, toEmail, bccEmails, subject, finalBody, settings, storageKey = 'leads') {
  let tab = null;
  const autoClose = settings.autoCloseTab !== false;
  const batchIdSet = new Set(batch.map((l) => l.id));

  try {
    let composeUrl =
      'https://mail.google.com/mail/?view=cm&fs=1' +
      (toEmail ? `&to=${encodeURIComponent(toEmail)}` : '') +
      (bccEmails.length > 0 ? `&bcc=${encodeURIComponent(bccEmails.join(','))}` : '') +
      `&su=${encodeURIComponent(subject || '')}` +
      `&body=${encodeURIComponent(finalBody || '')}`;

    tab = await chrome.tabs.create({ url: composeUrl, active: true });
    currentActiveTabId = tab.id;

    await waitForTabComplete(tab.id, 25000);
    await sleep(200);

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedGmailSendScript,
      args: [
        {
          expectedEmail: toEmail,
          expectedBccEmails: bccEmails,
          expectedSubject: subject,
          expectedBody: finalBody,
          confidentialMode: Boolean(settings.enableConfidentialMode),
          confidentialCoords: settings.enableConfidentialMode ? (settings.confidentialCoordinates || null) : null
        }
      ]
    });

    const executionResult = injectionResults?.[0]?.result;

    if (!executionResult) {
      throw new Error('No response from Gmail injected script for BCC batch.');
    }

    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Failed to send BCC batch email via Gmail.');
    }

    const freshData = await chrome.storage.local.get([storageKey, 'analytics']);
    const freshLeads = freshData[storageKey] || [];
    const nowIso = new Date().toISOString();

    const updatedLeads = freshLeads.map((l) =>
      batchIdSet.has(l.id)
        ? { ...l, status: 'sent', sentAt: nowIso, errorMessage: null }
        : l
    );

    const storagePayload = { [storageKey]: updatedLeads };

    if (storageKey === 'leads') {
      const todayStr = nowIso.slice(0, 10);
      const analytics = freshData.analytics || { lifetimeSent: 0, dailyHistory: {} };
      analytics.lifetimeSent = (analytics.lifetimeSent || 0) + batch.length;
      analytics.dailyHistory = analytics.dailyHistory || {};
      analytics.dailyHistory[todayStr] = (analytics.dailyHistory[todayStr] || 0) + batch.length;
      storagePayload.analytics = analytics;
    }

    await chrome.storage.local.set(storagePayload);

    if (autoClose && tab?.id) {
      await sleep(200);
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {}
    }

    return { success: true };
  } catch (error) {
    console.error('BCC batch standalone send error:', error);

    const freshData = await chrome.storage.local.get(storageKey);
    const freshLeads = freshData[storageKey] || [];
    const updatedLeads = freshLeads.map((l) =>
      batchIdSet.has(l.id)
        ? { ...l, status: 'error', errorMessage: error.message || 'Unknown BCC send error' }
        : l
    );
    await chrome.storage.local.set({ [storageKey]: updatedLeads });

    if (autoClose && tab?.id) {
      await sleep(300);
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {}
    }

    return { success: false, error: error.message };
  } finally {
    currentActiveTabId = null;
  }
}

/**
 * Spam-Check Queue processing loop (Dispatches test leads sequentially without affecting campaign analytics)
 */
let isSpamCheckQueueProcessing = false;

async function runSpamCheckQueueLoop() {
  if (isSpamCheckQueueProcessing) return;
  isSpamCheckQueueProcessing = true;

  try {
    while (isSpamCheckQueueProcessing) {
      const { spamCheckLeads = [] } = await chrome.storage.local.get('spamCheckLeads');
      const nextPending = spamCheckLeads.find((l) => l.status === 'pending');

      if (!nextPending) {
        break; // All pending test leads sent
      }

      await executeAutoSendForLead(nextPending.id, 'spamCheckLeads');

      // Check if user stopped it
      if (!isSpamCheckQueueProcessing) break;

      // Small 3-second breathing room between test emails
      await sleep(3000);
    }
  } catch (err) {
    console.error('Error running spam check queue:', err);
  } finally {
    isSpamCheckQueueProcessing = false;
  }
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Initial check in case it's already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') {
        cleanup();
        resolve();
      }
    }).catch(() => {});

    timer = setTimeout(() => {
      cleanup();
      // Resolve anyway to attempt injection even if onUpdated missed complete event
      resolve();
    }, timeoutMs);
  });
}

/**
 * Self-contained injected function executed inside the Gmail Compose Tab
 */
async function injectedGmailSendScript(params) {
  const { expectedEmail, expectedBccEmails, expectedSubject, expectedBody, confidentialMode, confidentialExpiration, confidentialCoords } = params || {};
  const maxWaitMs = 20000;
  const pollIntervalMs = 100; // Ultra-responsive active polling
  const startTime = Date.now();

  function localSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function dispatchRealisticClick(element) {
    if (!element) return;
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    element.dispatchEvent(new PointerEvent('pointerover', opts));
    element.dispatchEvent(new MouseEvent('mouseover', opts));
    element.dispatchEvent(new PointerEvent('pointerdown', opts));
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.dispatchEvent(new MouseEvent('click', opts));
  }

  async function applyConfidentialMode(coordsConfig) {
    try {
      if (!coordsConfig || !coordsConfig.point1) {
        console.warn('[Confidential] Confidential mode enabled, but click coordinates are not calibrated.');
        return false;
      }

      console.log('[Confidential] Executing calibrated coordinate automation:', coordsConfig);
      function clickAtPoint(x, y) {
        const el = document.elementFromPoint(x, y) || document.body;
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: 1
        };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }

      const is3Point = coordsConfig.mode === '3point' || Boolean(coordsConfig.point3);
      const delay1 = coordsConfig.delay1Ms || coordsConfig.delayMs || 350;
      const delay2 = coordsConfig.delay2Ms || 400;

      if (is3Point) {
        // 3-Point Mode: Point 1 (3-Dot) -> Point 2 (Confidential) -> Point 3 (Save)
        clickAtPoint(coordsConfig.point1.x, coordsConfig.point1.y);
        await localSleep(delay1);

        if (coordsConfig.point2) {
          clickAtPoint(coordsConfig.point2.x, coordsConfig.point2.y);
          await localSleep(delay2);
        }

        if (coordsConfig.point3) {
          clickAtPoint(coordsConfig.point3.x, coordsConfig.point3.y);
          await localSleep(300);
        }
      } else {
        // 2-Point Mode: Point 1 (Direct Lock Icon) -> Point 2 (Save)
        clickAtPoint(coordsConfig.point1.x, coordsConfig.point1.y);
        await localSleep(delay1);

        if (coordsConfig.point2) {
          clickAtPoint(coordsConfig.point2.x, coordsConfig.point2.y);
          await localSleep(300);
        }
      }

      return true;
    } catch (err) {
      console.warn('[Confidential] Error executing coordinate confidential mode:', err);
      return false;
    }
  }

  // 1. Helper to find Send button using multiple robust selectors
  function findSendButton() {
    // Candidate 1: data-tooltip containing Send (case-insensitive)
    const tooltipBtn = document.querySelector(
      'div[role="button"][data-tooltip*="Send"], div[role="button"][data-tooltip*="send"], div[role="button"][data-tooltip*="Envoyer"], div[role="button"][data-tooltip*="Senden"]'
    );
    if (tooltipBtn) return tooltipBtn;

    // Candidate 2: aria-label containing Send
    const ariaBtn = document.querySelector(
      'div[role="button"][aria-label*="Send"], div[role="button"][aria-label*="send"], div[role="button"][aria-label*="Envoyer"], div[role="button"][aria-label*="Senden"]'
    );
    if (ariaBtn) return ariaBtn;

    // Candidate 3: Standard Gmail compose send button classes
    const classBtn = document.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3, .T-I.J-J5-Ji.aoO.T-I-atl.L3');
    if (classBtn) return classBtn;

    // Candidate 4: Iterate all buttons for aria-label or tooltip or text
    const buttons = document.querySelectorAll('div[role="button"]');
    for (const btn of buttons) {
      const label = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('data-tooltip') ||
        btn.textContent ||
        ''
      ).trim();
      if (/^send\b/i.test(label) || label.toLowerCase().includes('send (ctrl-enter)')) {
        return btn;
      }
    }

    return null;
  }

  // 2. Helper to find the compose message body
  function findMessageBody() {
    return document.querySelector(
      'div[aria-label="Message Body"], div[role="textbox"][aria-label*="Body"], div[role="textbox"], div.Am.Al.editable, div[g_editable="true"]'
    );
  }

  // 3. Poll until compose interface is ready
  let sendButton = null;
  let messageBody = null;

  while (Date.now() - startTime < maxWaitMs) {
    sendButton = findSendButton();
    messageBody = findMessageBody();

    if (sendButton) {
      const rect = sendButton.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        break; // Send button is visible in DOM
      }
    }

    await localSleep(pollIntervalMs);
  }

  if (!sendButton && !messageBody) {
    return {
      success: false,
      error: 'Timed out waiting for Gmail compose window to load (20s). Please verify you are logged into Gmail.'
    };
  }

  // Brief yield for parameter hydration
  await localSleep(80);

  // 4. Verify/populate recipient, subject, and body if Gmail UI didn't auto-populate from URL
  try {
    // Helper to type/commit an email address into a Gmail PeopleKit recipient input
    async function fillEmailIntoInput(inputEl, emailAddress) {
      if (!inputEl || !emailAddress) return;
      inputEl.focus();
      await localSleep(30);

      let inserted = false;
      try {
        inputEl.value = '';
        inserted = document.execCommand('insertText', false, emailAddress);
      } catch (_) {
        inserted = false;
      }

      if (!inserted || inputEl.value !== emailAddress) {
        inputEl.value = emailAddress;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await localSleep(40);

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await localSleep(40);

      if (inputEl.value) {
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', keyCode: 188, which: 188, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: ',', code: 'Comma', keyCode: 188, which: 188, bubbles: true }));
        await localSleep(30);
      }
    }

    // Check 'To' recipient field if expectedEmail was provided
    if (expectedEmail) {
      const recipientInput = document.querySelector(
        'input[aria-label*="To" i], input.agP.aFw, div[name="to"] input, input[peoplekit-id]'
      );
      const toContainer = document.querySelector('div[name="to"], div[aria-label*="To" i]');
      const hasRecipient = toContainer
        ? (toContainer.innerText || '').includes('@')
        : recipientInput
        ? (recipientInput.value || '').includes('@')
        : false;

      if (!hasRecipient && recipientInput) {
        await fillEmailIntoInput(recipientInput, expectedEmail);
        await localSleep(50);
      }
    }

    // Check 'Bcc' recipient field if expectedBccEmails were provided
    if (Array.isArray(expectedBccEmails) && expectedBccEmails.length > 0) {
      function findBccInputEl() {
        const direct = document.querySelector(
          'input[name="bcc"], input[aria-label*="bcc" i], input[aria-label*="cco" i], input[aria-label*="cci" i], div[name="bcc"] input, tr[name="bcc"] input'
        );
        if (direct) return direct;

        const containers = document.querySelectorAll(
          'div[name="bcc"], tr[name="bcc"], div[aria-label*="bcc" i], tr[aria-label*="bcc" i], div[aria-label*="cco" i], div[aria-label*="cci" i]'
        );
        for (const c of containers) {
          const inp = c.querySelector('input.agP.aFw, input[peoplekit-id], input[role="combobox"], input');
          if (inp) return inp;
        }

        const inputs = document.querySelectorAll('input.agP.aFw, input[peoplekit-id]');
        if (inputs.length >= 2) {
          for (let i = inputs.length - 1; i >= 0; i--) {
            const row = inputs[i].closest('tr, div[name], div[role="row"], div.aoD');
            const rowText = (row?.innerText || row?.getAttribute('aria-label') || '').toLowerCase();
            if (rowText.includes('bcc') || rowText.includes('cco') || rowText.includes('cci')) {
              return inputs[i];
            }
          }
        }
        return null;
      }

      const bccContainer = document.querySelector('div[name="bcc"], div[aria-label*="bcc" i]');
      let bccInputEl = findBccInputEl();
      const hasBcc = bccContainer
        ? (bccContainer.innerText || '').includes('@')
        : bccInputEl
        ? (bccInputEl.value || '').includes('@')
        : false;

      if (!hasBcc) {
        if (!bccInputEl) {
          const toTarget = document.querySelector('input[peoplekit-id], input.agP.aFw, div[name="to"]') || document.body;
          toTarget.focus?.();
          await localSleep(50);

          const keyOpts = { key: 'B', code: 'KeyB', keyCode: 66, which: 66, ctrlKey: true, shiftKey: true, bubbles: true };
          toTarget.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
          toTarget.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
          toTarget.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
          await localSleep(100);

          bccInputEl = findBccInputEl();

          if (!bccInputEl) {
            const bccCandidates = document.querySelectorAll(
              'span[role="link"], span[data-tooltip], span[aria-label], div[role="button"], span.aB.gQ.pE, span.aB'
            );
            for (const el of bccCandidates) {
              const tip = (el.getAttribute('data-tooltip') || '').toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const text = (el.textContent || '').replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').trim().toLowerCase();
              if (
                tip.includes('bcc') || tip.includes('cco') || tip.includes('cci') ||
                aria.includes('bcc') || aria.includes('cco') || aria.includes('cci') ||
                text === 'bcc' || text === 'cco' || text === 'cci'
              ) {
                el.click();
                await localSleep(150);
                break;
              }
            }
          }

          const waitBccStart = Date.now();
          while (!bccInputEl && Date.now() - waitBccStart < 2000) {
            await localSleep(60);
            bccInputEl = findBccInputEl();
          }
        }

        if (bccInputEl) {
          for (const bccAddr of expectedBccEmails) {
            if (!bccAddr) continue;
            await fillEmailIntoInput(bccInputEl, bccAddr);
            await localSleep(35);
          }
        }
      }
    }

    // Check subject field
    const subjectInput = document.querySelector(
      'input[name="subjectbox"], input[aria-label*="Subject"]'
    );
    if (subjectInput && expectedSubject && !subjectInput.value?.trim()) {
      subjectInput.focus();
      subjectInput.value = expectedSubject;
      subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
      await localSleep(50);
    }

    // Check body field
    if (messageBody && expectedBody) {
      const currentText = messageBody.innerText || messageBody.textContent || '';
      if (!currentText.trim()) {
        messageBody.focus();
        messageBody.innerText = expectedBody;
        messageBody.dispatchEvent(new Event('input', { bubbles: true }));
        await localSleep(50);
      }
    }
  } catch (fieldCheckErr) {
    console.warn('Field fallback check warning:', fieldCheckErr);
  }

  // 4.5. If Confidential Mode is enabled, toggle confidential mode via calibrated coordinates before sending
  if (confidentialMode) {
    try {
      await applyConfidentialMode(confidentialCoords);
      sendButton = findSendButton() || sendButton;
    } catch (confErr) {
      console.warn('Confidential mode toggle warning:', confErr);
    }
  }

  // 5. Trigger realistic mouse click sequence on the Send button
  let clickDispatched = false;
  if (sendButton) {
    try {
      sendButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await localSleep(40);

      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      sendButton.dispatchEvent(new PointerEvent('pointerover', opts));
      sendButton.dispatchEvent(new MouseEvent('mouseover', opts));
      sendButton.dispatchEvent(new PointerEvent('pointerdown', opts));
      sendButton.dispatchEvent(new MouseEvent('mousedown', opts));
      sendButton.focus();
      await localSleep(20);
      sendButton.dispatchEvent(new PointerEvent('pointerup', opts));
      sendButton.dispatchEvent(new MouseEvent('mouseup', opts));
      sendButton.dispatchEvent(new MouseEvent('click', opts));
      clickDispatched = true;
    } catch (e) {
      console.warn('Mouse click event failed:', e);
    }
  }

  // 6. Fallback: Dispatch Ctrl+Enter / Meta+Enter keyboard shortcut
  if (!clickDispatched || !sendButton) {
    const targetElement = messageBody || document.activeElement || document.body;
    targetElement.focus();
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const keyOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true,
      view: window
    };
    targetElement.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    targetElement.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    targetElement.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
  }

  // 7. Wait up to 4.5 seconds for confirmation (toast or message sent status)
  const waitConfirmStart = Date.now();
  let confirmationDetected = false;

  while (Date.now() - waitConfirmStart < 4500) {
    // Check for standard Gmail toast alerts
    const alerts = document.querySelectorAll(
      'div[role="alert"], span[role="alert"], .bHp, .vh, .aT, .J-J5-Ji'
    );
    for (const alert of alerts) {
      const text = (alert.textContent || '').toLowerCase();
      if (
        text.includes('message sent') ||
        text.includes('your message has been sent') ||
        text.includes('sending...')
      ) {
        confirmationDetected = true;
        break;
      }
    }

    if (confirmationDetected) break;

    // In full-screen view (fs=1), after send, Gmail page body often displays sent status
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (
      bodyText.includes('your message has been sent') ||
      bodyText.includes('message sent')
    ) {
      confirmationDetected = true;
      break;
    }

    // Check for error modal dialogs (e.g. "Please specify at least one recipient")
    const errorDialog = document.querySelector('div[role="alertdialog"], .Kj-JD');
    if (errorDialog && errorDialog.offsetParent !== null) {
      const dialogText = errorDialog.innerText || 'Gmail displayed an error dialog';
      return {
        success: false,
        error: `Gmail alert: ${dialogText.slice(0, 120)}`
      };
    }

    await localSleep(100);
  }

  return {
    success: true,
    confirmedToast: confirmationDetected
  };
}

/**
 * Handle in-page step-by-step Gmail composition:
 * Detects open Gmail tab (or activates/opens one), clicks "+ Compose",
 * and inserts recipient, subject, and body step-by-step without sending.
 */
async function handleInPageCompose(lead) {
  try {
    let targetTab = null;

    // 1. Check if the active tab in the current window is Gmail
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url && activeTab.url.includes('mail.google.com')) {
      targetTab = activeTab;
    } else {
      // 2. Search for any open Gmail tab in the current window
      const tabsInWindow = await chrome.tabs.query({ currentWindow: true });
      const gmailInWindow = tabsInWindow.find((t) => t.url && t.url.includes('mail.google.com'));

      if (gmailInWindow) {
        targetTab = gmailInWindow;
        await chrome.tabs.update(targetTab.id, { active: true });
      } else {
        // 3. Search across all browser windows for an open Gmail tab
        const allTabs = await chrome.tabs.query({});
        const anyGmailTab = allTabs.find((t) => t.url && t.url.includes('mail.google.com'));

        if (anyGmailTab) {
          targetTab = anyGmailTab;
          await chrome.tabs.update(targetTab.id, { active: true });
          if (anyGmailTab.windowId) {
            await chrome.windows.update(anyGmailTab.windowId, { focused: true });
          }
        }
      }
    }

    // 4. If no Gmail tab is open at all, open a new one
    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
      await waitForTabComplete(targetTab.id, 25000);
      await sleep(2500); // Give Gmail SPA time to render sidebar
    } else {
      if (targetTab.status !== 'complete') {
        await waitForTabComplete(targetTab.id, 15000);
      }
      await sleep(400);
    }

    // 4.5. Compute body with rotating signature if enabled
    const finalBody = await getLeadBodyWithSignature(lead.body);
    const { settings = {} } = await chrome.storage.local.get('settings');

    // 5. Inject and run the step-by-step in-page compose automation
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: injectedInPageComposeScript,
      args: [
        {
          email: lead.email || null,
          bccEmails: Array.isArray(lead.bccEmails) ? lead.bccEmails : null,
          subject: lead.subject,
          body: finalBody,
          autoSend: false,
          confidentialMode: Boolean(settings.enableConfidentialMode),
          confidentialCoords: settings.enableConfidentialMode ? (settings.confidentialCoordinates || null) : null
        }
      ]
    });

    const executionResult = results?.[0]?.result;

    if (!executionResult) {
      throw new Error('No response from in-page Gmail script.');
    }

    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Failed to populate in-page Gmail compose.');
    }

    return { success: true, tabId: targetTab.id };
  } catch (error) {
    console.error('In-page compose error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Helper to get lead body with rotated signature if enabled
 */
async function getLeadBodyWithSignature(leadBody) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const enableSig = settings.enableSignature === true;
  const sigs = Array.isArray(settings.signatures) ? settings.signatures.filter((s) => s && s.trim()) : [];

  if (!enableSig || sigs.length === 0) {
    return leadBody || '';
  }

  let selectedSig = '';
  if (settings.signatureRotationMode === 'random') {
    selectedSig = sigs[Math.floor(Math.random() * sigs.length)];
  } else {
    // Sequential
    const currentIdx = parseInt(settings.lastSignatureIndex, 10) || 0;
    const safeIdx = currentIdx % sigs.length;
    selectedSig = sigs[safeIdx];
    const nextIdx = (safeIdx + 1) % sigs.length;
    await chrome.storage.local.set({
      settings: {
        ...settings,
        lastSignatureIndex: nextIdx
      }
    });
  }

  const trimmedBody = (leadBody || '').trim();
  const trimmedSig = (selectedSig || '').trim();

  if (!trimmedSig) return leadBody || '';
  if (trimmedBody.endsWith(trimmedSig)) return leadBody || '';

  return trimmedBody ? `${trimmedBody}\n\n${trimmedSig}` : trimmedSig;
}

/**
 * Self-contained function injected into Gmail tab to click Compose and populate fields step-by-step
 */
async function injectedInPageComposeScript(leadData) {
  const { email, bccEmails, subject, body, autoSend, confidentialMode, confidentialExpiration, confidentialCoords } = leadData || {};

  function localSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function dispatchRealisticClick(element) {
    if (!element) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new PointerEvent('pointerdown', opts));
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.dispatchEvent(new MouseEvent('click', opts));
  }

  async function applyConfidentialMode(coordsConfig) {
    try {
      if (!coordsConfig || !coordsConfig.point1) {
        console.warn('[Confidential] Confidential mode enabled, but click coordinates are not calibrated.');
        return false;
      }

      console.log('[Confidential] Executing calibrated coordinate automation:', coordsConfig);
      function clickAtPoint(x, y) {
        const el = document.elementFromPoint(x, y) || document.body;
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: 1
        };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }

      const is3Point = coordsConfig.mode === '3point' || Boolean(coordsConfig.point3);
      const delay1 = coordsConfig.delay1Ms || coordsConfig.delayMs || 350;
      const delay2 = coordsConfig.delay2Ms || 400;

      if (is3Point) {
        // 3-Point Mode: Point 1 (3-Dot) -> Point 2 (Confidential) -> Point 3 (Save)
        clickAtPoint(coordsConfig.point1.x, coordsConfig.point1.y);
        await localSleep(delay1);

        if (coordsConfig.point2) {
          clickAtPoint(coordsConfig.point2.x, coordsConfig.point2.y);
          await localSleep(delay2);
        }

        if (coordsConfig.point3) {
          clickAtPoint(coordsConfig.point3.x, coordsConfig.point3.y);
          await localSleep(300);
        }
      } else {
        // 2-Point Mode: Point 1 (Direct Lock Icon) -> Point 2 (Save)
        clickAtPoint(coordsConfig.point1.x, coordsConfig.point1.y);
        await localSleep(delay1);

        if (coordsConfig.point2) {
          clickAtPoint(coordsConfig.point2.x, coordsConfig.point2.y);
          await localSleep(300);
        }
      }

      return true;
    } catch (err) {
      console.warn('[Confidential] Error executing coordinate confidential mode:', err);
      return false;
    }
  }

  // 1. Look for an existing empty compose box or click "+ Compose"
  let composeBox = findEmptyComposeDialog();

  if (!composeBox) {
    // Locate Gmail's main "+ Compose" button on the left sidebar
    const composeBtn = document.querySelector(
      'div[gh="cm"], .T-I.T-I-KE.L3, div[role="button"][data-tooltip*="Compose"], div[role="button"][aria-label*="Compose"], div.aic .z0 div[role="button"]'
    );

    if (composeBtn) {
      dispatchRealisticClick(composeBtn);
    } else {
      // Fallback: Dispatch 'c' key in case shortcuts are active
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', keyCode: 67, code: 'KeyC', bubbles: true }));
    }

    // Wait up to 8 seconds for the compose box to appear in the DOM
    const startWait = Date.now();
    while (Date.now() - startWait < 8000) {
      await localSleep(80);
      composeBox = findLatestComposeDialog();
      if (composeBox) break;
    }
  }

  if (!composeBox) {
    return {
      success: false,
      error: 'Could not open or locate the Gmail Compose window. Please make sure Gmail is fully loaded.'
    };
  }

  // Bring compose box into view and focus
  composeBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  await localSleep(80);

  // Helper to type/commit an email address into a Gmail PeopleKit recipient input
  async function fillEmailIntoInput(inputEl, emailAddress) {
    if (!inputEl || !emailAddress) return;
    inputEl.focus();
    await localSleep(30);

    let inserted = false;
    try {
      inputEl.value = '';
      inserted = document.execCommand('insertText', false, emailAddress);
    } catch (_) {
      inserted = false;
    }

    if (!inserted || inputEl.value !== emailAddress) {
      inputEl.value = emailAddress;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await localSleep(40);

    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await localSleep(40);

    if (inputEl.value) {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', keyCode: 188, which: 188, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: ',', code: 'Comma', keyCode: 188, which: 188, bubbles: true }));
      await localSleep(30);
    }
  }

  // 2. Step 1: Insert "To" Recipient Email
  try {
    if (email) {
      const toClickArea = composeBox.querySelector(
        'div[name="to"], div[aria-label*="To" i], span[name="to"], tr.fA, div.aoD.hl'
      );
      if (toClickArea) {
        dispatchRealisticClick(toClickArea);
        await localSleep(60);
      }

      const recipientInput = composeBox.querySelector(
        'input[peoplekit-id], input.agP.aFw, div[name="to"] input, input[aria-label*="To" i], input[role="combobox"]'
      ) || document.querySelector('div[name="to"] input, input.agP.aFw');

      if (recipientInput) {
        await fillEmailIntoInput(recipientInput, email);
      }
    }
  } catch (err) {
    console.warn('Error filling "To" recipient:', err);
  }

  // 2b. Step 1b: Insert BCC Recipients if present
  try {
    if (Array.isArray(bccEmails) && bccEmails.length > 0) {
      function findBccInputEl() {
        const direct = composeBox.querySelector(
          'input[name="bcc"], input[aria-label*="bcc" i], input[aria-label*="cco" i], input[aria-label*="cci" i], div[name="bcc"] input, tr[name="bcc"] input'
        );
        if (direct) return direct;

        const containers = composeBox.querySelectorAll(
          'div[name="bcc"], tr[name="bcc"], div[aria-label*="bcc" i], tr[aria-label*="bcc" i], div[aria-label*="cco" i], div[aria-label*="cci" i]'
        );
        for (const c of containers) {
          const inp = c.querySelector('input.agP.aFw, input[peoplekit-id], input[role="combobox"], input');
          if (inp) return inp;
        }

        const inputs = composeBox.querySelectorAll('input.agP.aFw, input[peoplekit-id]');
        if (inputs.length >= 2) {
          for (let i = inputs.length - 1; i >= 0; i--) {
            const row = inputs[i].closest('tr, div[name], div[role="row"], div.aoD');
            const rowText = (row?.innerText || row?.getAttribute('aria-label') || '').toLowerCase();
            if (rowText.includes('bcc') || rowText.includes('cco') || rowText.includes('cci')) {
              return inputs[i];
            }
          }
        }
        return null;
      }

      let bccInput = findBccInputEl();

      if (!bccInput) {
        const toFocusTarget = composeBox.querySelector('input[peoplekit-id], input.agP.aFw, div[name="to"]') || composeBox;
        toFocusTarget.focus?.();
        await localSleep(50);

        const keyOpts = { key: 'B', code: 'KeyB', keyCode: 66, which: 66, ctrlKey: true, shiftKey: true, bubbles: true };
        toFocusTarget.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
        toFocusTarget.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
        toFocusTarget.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
        await localSleep(100);

        bccInput = findBccInputEl();

        if (!bccInput) {
          const links = composeBox.querySelectorAll(
            'span[role="link"], span[data-tooltip], span[aria-label], div[role="button"], span.aB.gQ.pE, span.aB'
          );
          for (const l of links) {
            const tip = (l.getAttribute('data-tooltip') || '').toLowerCase();
            const aria = (l.getAttribute('aria-label') || '').toLowerCase();
            const text = (l.textContent || '').replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').trim().toLowerCase();
            if (
              tip.includes('bcc') || tip.includes('cco') || tip.includes('cci') ||
              aria.includes('bcc') || aria.includes('cco') || aria.includes('cci') ||
              text === 'bcc' || text === 'cco' || text === 'cci'
            ) {
              dispatchRealisticClick(l);
              await localSleep(150);
              break;
            }
          }
        }

        const startWaitBcc = Date.now();
        while (!bccInput && Date.now() - startWaitBcc < 2000) {
          await localSleep(60);
          bccInput = findBccInputEl();
        }
      }

      if (!bccInput) {
        bccInput = document.querySelector(
          'input[aria-label*="bcc" i], input[aria-label*="cco" i], input[aria-label*="cci" i], div[name="bcc"] input, tr[name="bcc"] input'
        );
      }

      if (bccInput) {
        for (const addr of bccEmails) {
          if (!addr) continue;
          await fillEmailIntoInput(bccInput, addr);
          await localSleep(35);
        }
      } else {
        console.warn('Could not locate BCC input in Gmail compose.');
      }
    }
  } catch (err) {
    console.warn('Error filling BCC recipients:', err);
  }

  // 3. Step 2: Insert Subject
  try {
    const subjectInput = composeBox.querySelector(
      'input[name="subjectbox"], input[aria-label*="Subject"], input[placeholder*="Subject"]'
    ) || document.querySelector('input[name="subjectbox"]');

    if (subjectInput && subject) {
      subjectInput.focus();
      subjectInput.value = subject;
      subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
      subjectInput.dispatchEvent(new Event('change', { bubbles: true }));
      await localSleep(50);
    }
  } catch (err) {
    console.warn('Error filling subject:', err);
  }

  // 4. Step 3: Insert Message Body (Preserving \n\n line breaks)
  try {
    const messageBody = composeBox.querySelector(
      'div[aria-label="Message Body"], div[role="textbox"][aria-label*="Body"], div[role="textbox"], div.Am.Al.editable, div[g_editable="true"]'
    ) || document.querySelector('div[aria-label="Message Body"], div.Am.Al.editable');

    if (messageBody && body) {
      messageBody.focus();
      await localSleep(40);

      // Attempt native execCommand first (best integration with Gmail's undo/draft stack)
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, body);
      } catch (e) {
        inserted = false;
      }

      // If execCommand was ignored or body remained empty, insert formatted HTML paragraphs
      const bodyContent = messageBody.innerText || messageBody.textContent || '';
      if (!inserted || !bodyContent.trim()) {
        const paragraphs = body.split('\n\n');
        const formattedHtml = paragraphs
          .map((p) => `<div>${escapeHtml(p).replace(/\n/g, '<br>')}</div>`)
          .join('<div><br></div>');

        messageBody.innerHTML = formattedHtml;
        messageBody.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Keep focus in the message body so the user is directly looking at the draft
      messageBody.focus();
    }
  } catch (err) {
    console.warn('Error filling body:', err);
  }

  // 4.5. Step 3b: If Confidential Mode is enabled, toggle confidential mode via calibrated coordinates
  if (confidentialMode) {
    try {
      await applyConfidentialMode(confidentialCoords);
    } catch (confErr) {
      console.warn('Confidential mode toggle warning:', confErr);
    }
  }

  // 5. Step 4 (If Auto-Send is Enabled): Click Send and wait for confirmation
  if (autoSend) {
    await localSleep(150); // Allow Gmail to finish saving draft

    function findDialogSendBtn(dialog) {
      if (!dialog) return null;
      // Selector 1: data-tooltip containing Send
      const tooltipBtn = dialog.querySelector(
        'div[role="button"][data-tooltip*="Send"], div[role="button"][data-tooltip*="send"], div[role="button"][data-tooltip*="Envoyer"], div[role="button"][data-tooltip*="Senden"]'
      );
      if (tooltipBtn) return tooltipBtn;

      // Selector 2: aria-label containing Send
      const ariaBtn = dialog.querySelector(
        'div[role="button"][aria-label*="Send"], div[role="button"][aria-label*="send"], div[role="button"][aria-label*="Envoyer"], div[role="button"][aria-label*="Senden"]'
      );
      if (ariaBtn) return ariaBtn;

      // Selector 3: Standard Gmail compose send button classes
      const classBtn = dialog.querySelector(
        '.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3, .T-I.J-J5-Ji.aoO.T-I-atl.L3, div.T-I.J-J5-Ji.aoO[role="button"]'
      );
      if (classBtn) return classBtn;

      // Selector 4: Any button with "Send" text
      const buttons = dialog.querySelectorAll('div[role="button"]');
      for (const btn of buttons) {
        const label = (
          btn.getAttribute('aria-label') ||
          btn.getAttribute('data-tooltip') ||
          btn.textContent ||
          ''
        ).trim();
        if (/^send\b/i.test(label) || label.toLowerCase().includes('send (ctrl-enter)')) {
          return btn;
        }
      }

      return null;
    }

    let sendBtn = findDialogSendBtn(composeBox);

    // Fallback search across document
    if (!sendBtn) {
      sendBtn = document.querySelector(
        'div[role="button"][data-tooltip*="Send"], div[role="button"][aria-label*="Send"], .T-I.J-J5-Ji.aoO.v7.T-I-atl.L3'
      );
    }

    if (!sendBtn) {
      return {
        success: false,
        error: 'Could not locate the Send button in the Gmail compose window.'
      };
    }

    // Click the Send button
    dispatchRealisticClick(sendBtn);

    // Also dispatch Ctrl+Enter on message body as native fallback
    try {
      const msgBodyEl = composeBox.querySelector(
        'div[aria-label="Message Body"], div[role="textbox"], div.Am.Al.editable'
      );
      if (msgBodyEl) {
        msgBodyEl.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            ctrlKey: true,
            bubbles: true
          })
        );
      }
    } catch (e) {}

    // Wait for compose dialog to dismiss or confirmation toast to appear
    const startWaitSend = Date.now();
    let sentSuccess = false;
    let sendError = null;

    while (Date.now() - startWaitSend < 12000) {
      await localSleep(100);

      // Check if an error/warning dialog appeared
      const alertDialog = document.querySelector('div[role="alertdialog"], div.Kj-JD');
      if (alertDialog && alertDialog.offsetWidth > 0) {
        sendError = alertDialog.innerText || 'Gmail prompt prevented sending.';
        break;
      }

      // Check if compose box closed or disappeared
      if (!document.contains(composeBox) || composeBox.offsetWidth === 0 || composeBox.offsetHeight === 0) {
        sentSuccess = true;
        break;
      }

      // Check for Gmail toast: "Message sent.", "Sending...", "Undo"
      const toasts = document.querySelectorAll('div.b8.UC, span.bAq, div[role="alert"]');
      for (const t of toasts) {
        const txt = (t.textContent || '').toLowerCase();
        if (txt.includes('message sent') || txt.includes('sending') || txt.includes('undo')) {
          sentSuccess = true;
          break;
        }
      }
      if (sentSuccess) break;
    }

    if (sendError) {
      return { success: false, error: sendError };
    }

    if (!sentSuccess) {
      // Final fallback check: if compose box is still open, try re-clicking send once
      const retryBtn = findDialogSendBtn(composeBox);
      if (retryBtn) {
        dispatchRealisticClick(retryBtn);
        await localSleep(1500);
        if (!document.contains(composeBox) || composeBox.offsetWidth === 0) {
          sentSuccess = true;
        }
      }
    }

    if (!sentSuccess) {
      return {
        success: false,
        error: 'Send button clicked, but Gmail compose box did not close within 12 seconds.'
      };
    }

    return { success: true, sent: true };
  }

  return { success: true };

  // Helper functions:
  function findLatestComposeDialog() {
    const dialogs = document.querySelectorAll('div[role="dialog"], div.AD, table.Ao.WL');
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const d = dialogs[i];
      if (
        d.querySelector(
          'div[aria-label="Message Body"], input[name="subjectbox"], div[name="to"]'
        )
      ) {
        return d;
      }
    }
    return null;
  }

  function findEmptyComposeDialog() {
    const dialogs = document.querySelectorAll('div[role="dialog"], div.AD');
    for (const d of dialogs) {
      const bodyEl = d.querySelector('div[aria-label="Message Body"]');
      const subjEl = d.querySelector('input[name="subjectbox"]');
      const toEl = d.querySelector('div[name="to"]');
      if (bodyEl && subjEl) {
        const hasText =
          (bodyEl.innerText || '').trim() ||
          (subjEl.value || '').trim() ||
          (toEl?.innerText || '').includes('@');
        if (!hasText) return d;
      }
    }
    return null;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

/**
 * Utility: Sleep for ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Utility: Get current window ID
 */
async function getCurrentWindowId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.windowId || null;
}

/**
 * Injected script: Interactive Coordinate Calibrator & Picker HUD
 * Allows point-and-click coordinate capturing on Gmail window for Side Panel (3-point) & full screen (2-point) setups.
 */
function injectedCoordinatePickerScript(targetMode) {
  const existing = document.getElementById('midey-calibrator-overlay');
  if (existing) existing.remove();

  const mode = targetMode === '2point' ? '2point' : '3point';
  const totalSteps = mode === '3point' ? 3 : 2;

  let currentStep = 1;
  let point1 = null;
  let point2 = null;
  let point3 = null;
  let isProcessingClick = false;
  let autoCloseTimer = null;

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'midey-calibrator-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(15, 23, 42, 0.28);
    backdrop-filter: blur(1.5px);
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // HUD banner
  const hud = document.createElement('div');
  hud.id = 'midey-calibrator-hud';
  hud.style.cssText = `
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: #111827;
    border: 2px solid #6366f1;
    border-radius: 12px;
    box-shadow: 0 12px 35px rgba(0,0,0,0.7);
    padding: 12px 20px;
    color: #f9fafb;
    display: flex;
    align-items: center;
    gap: 16px;
    z-index: 2147483647;
    pointer-events: auto;
    max-width: 90vw;
  `;

  hud.innerHTML = `
    <div style="width: 40px; height: 40px; border-radius: 10px; background: #4f46e5; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">
      🎯
    </div>
    <div style="flex: 1; min-width: 280px;">
      <div id="midey-hud-title" style="font-size: 13.5px; font-weight: 700; color: #ffffff;">
        ${mode === '3point' ? 'Step 1 of 3: Click the 3-Dot ("More options") Menu' : 'Step 1 of 2: Click the Confidential Button'}
      </div>
      <div id="midey-hud-desc" style="font-size: 11px; color: #9ca3af; margin-top: 2px;">
        ${mode === '3point' ? 'Click directly on the 3-dot button in your compose toolbar. Press ESC to cancel.' : 'Click the lock icon on your Gmail toolbar to open the dialog. Press ESC to cancel.'}
      </div>
    </div>
    <div id="midey-hud-actions" style="display: flex; gap: 8px; align-items: center; flex-shrink: 0;">
      <button id="midey-calibrator-cancel-btn" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; font-size: 11px; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer;">
        Cancel
      </button>
    </div>
  `;

  overlay.appendChild(hud);
  document.body.appendChild(overlay);

  const cancelBtn = hud.querySelector('#midey-calibrator-cancel-btn');
  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup('Calibration cancelled.');
  });

  function addMarker(x, y, num, color) {
    const marker = document.createElement('div');
    marker.className = 'midey-calibrator-marker';
    marker.style.cssText = `
      position: fixed;
      left: ${x - 14}px;
      top: ${y - 14}px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: ${color};
      color: #fff;
      font-size: 13px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 14px ${color}, 0 4px 8px rgba(0,0,0,0.5);
      border: 2px solid #ffffff;
      z-index: 2147483647;
      pointer-events: none;
    `;
    marker.textContent = num;
    overlay.appendChild(marker);
  }

  function handleDocumentClick(e) {
    // CRITICAL BUG FIX: Ignore synthetic clicks dispatched via element.dispatchEvent!
    if (!e.isTrusted) return;

    // Ignore clicks inside the HUD banner itself
    if (hud.contains(e.target)) return;

    // Prevent re-entry if debounce in progress
    if (isProcessingClick) return;

    e.preventDefault();
    e.stopPropagation();
    isProcessingClick = true;

    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);

    // Pass click through to underlying element so Gmail's 3-dot menu or dialog actually opens
    overlay.style.pointerEvents = 'none';
    const underlying = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = 'auto';

    if (underlying) {
      try {
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        underlying.dispatchEvent(new MouseEvent('mousedown', opts));
        underlying.dispatchEvent(new MouseEvent('mouseup', opts));
        underlying.dispatchEvent(new MouseEvent('click', opts));
      } catch (_) {}
    }

    if (currentStep === 1) {
      point1 = { x, y };
      addMarker(x, y, '1', '#6366f1');
      currentStep = 2;

      const titleEl = hud.querySelector('#midey-hud-title');
      const descEl = hud.querySelector('#midey-hud-desc');
      if (mode === '3point') {
        if (titleEl) titleEl.textContent = 'Step 2 of 3: Click "Confidential mode" in the Menu';
        if (descEl) descEl.textContent = 'Click on "Confidential mode" in the opened popup menu.';
      } else {
        if (titleEl) titleEl.textContent = 'Step 2 of 2: Click the "Save" Button in the Dialog';
        if (descEl) descEl.textContent = 'Click the "Save" button inside the Confidential Mode dialog box.';
      }
      setTimeout(() => { isProcessingClick = false; }, 350);

    } else if (currentStep === 2) {
      point2 = { x, y };
      addMarker(x, y, '2', mode === '3point' ? '#f59e0b' : '#10b981');

      if (mode === '3point') {
        currentStep = 3;
        const titleEl = hud.querySelector('#midey-hud-title');
        const descEl = hud.querySelector('#midey-hud-desc');
        if (titleEl) titleEl.textContent = 'Step 3 of 3: Click the "Save" Button in the Dialog';
        if (descEl) descEl.textContent = 'Click the "Save" button inside the Confidential Mode dialog box.';
        setTimeout(() => { isProcessingClick = false; }, 350);
      } else {
        finishCalibration();
      }

    } else if (currentStep === 3 && mode === '3point') {
      point3 = { x, y };
      addMarker(x, y, '3', '#10b981');
      finishCalibration();
    }
  }

  function finishCalibration() {
    isProcessingClick = true;

    // Immediately save coordinates to extension storage
    chrome.runtime.sendMessage({
      action: 'SAVE_CONFIDENTIAL_COORDS',
      coords: {
        mode,
        point1,
        point2,
        point3: mode === '3point' ? point3 : null
      }
    });

    const titleEl = hud.querySelector('#midey-hud-title');
    const descEl = hud.querySelector('#midey-hud-desc');
    const actionsEl = hud.querySelector('#midey-hud-actions');

    if (titleEl) {
      titleEl.textContent = `✅ All ${totalSteps} Points Calibrated & Saved!`;
      titleEl.style.color = '#34d399';
    }

    if (descEl) {
      if (mode === '3point') {
        descEl.textContent = `Pt 1 (3-Dot): (${point1.x}, ${point1.y}) • Pt 2 (Menu): (${point2.x}, ${point2.y}) • Pt 3 (Save): (${point3.x}, ${point3.y})`;
      } else {
        descEl.textContent = `Pt 1 (Toolbar): (${point1.x}, ${point1.y}) • Pt 2 (Save): (${point2.x}, ${point2.y})`;
      }
    }

    if (actionsEl) {
      actionsEl.innerHTML = `
        <button id="midey-calibrator-done-btn" style="background: #10b981; border: none; color: #ffffff; font-size: 11.5px; font-weight: 700; padding: 6px 14px; border-radius: 6px; cursor: pointer;">
          Done
        </button>
        <button id="midey-calibrator-retry-btn" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #f3f4f6; font-size: 11px; padding: 6px 10px; border-radius: 6px; cursor: pointer;">
          🔄 Retry
        </button>
      `;

      const doneBtn = actionsEl.querySelector('#midey-calibrator-done-btn');
      doneBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cleanup('Saved and closed by user.');
      });

      const retryBtn = actionsEl.querySelector('#midey-calibrator-retry-btn');
      retryBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        resetCalibration();
      });
    }

    // Auto-close overlay after 7 seconds if user does not click Done
    autoCloseTimer = setTimeout(() => {
      cleanup('Auto-closing after calibration.');
    }, 7000);
  }

  function resetCalibration() {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    currentStep = 1;
    point1 = null;
    point2 = null;
    point3 = null;
    isProcessingClick = false;

    // Remove placed markers
    overlay.querySelectorAll('.midey-calibrator-marker').forEach((m) => m.remove());

    // Reset HUD text
    const titleEl = hud.querySelector('#midey-hud-title');
    const descEl = hud.querySelector('#midey-hud-desc');
    const actionsEl = hud.querySelector('#midey-hud-actions');

    if (titleEl) {
      titleEl.textContent = mode === '3point' ? 'Step 1 of 3: Click the 3-Dot ("More options") Menu' : 'Step 1 of 2: Click the Confidential Button';
      titleEl.style.color = '#ffffff';
    }
    if (descEl) {
      descEl.textContent = mode === '3point' ? 'Click directly on the 3-dot button in your compose toolbar. Press ESC to cancel.' : 'Click the lock icon on your Gmail toolbar to open the dialog. Press ESC to cancel.';
    }
    if (actionsEl) {
      actionsEl.innerHTML = `
        <button id="midey-calibrator-cancel-btn" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; font-size: 11px; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer;">
          Cancel
        </button>
      `;
      const cancelBtn = actionsEl.querySelector('#midey-calibrator-cancel-btn');
      cancelBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        cleanup('Calibration cancelled.');
      });
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      cleanup('Calibration cancelled.');
    }
  }

  function cleanup(msg) {
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    window.removeEventListener('click', handleDocumentClick, true);
    window.removeEventListener('keydown', handleKeyDown, true);
    if (overlay && overlay.parentNode) {
      overlay.remove();
    }
    if (msg) console.log('[Midey Calibrator]', msg);
  }

  window.addEventListener('click', handleDocumentClick, true);
  window.addEventListener('keydown', handleKeyDown, true);
}

/**
 * Injected script: Test calibrated coordinates with visual ripple indicators
 */
async function injectedCoordinateTestScript(coords) {
  if (!coords || !coords.point1) return;

  function showClickRipple(x, y, label, color) {
    const rip = document.createElement('div');
    rip.style.cssText = `
      position: fixed;
      left: ${x - 20}px;
      top: ${y - 20}px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 3px solid ${color};
      background: rgba(99, 102, 241, 0.25);
      color: #fff;
      font-size: 10.5px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 0 16px ${color};
      transition: transform 0.4s ease, opacity 0.4s ease;
      transform: scale(1.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    rip.textContent = label;
    document.body.appendChild(rip);
    setTimeout(() => {
      rip.style.transform = 'scale(0.8)';
      rip.style.opacity = '0';
      setTimeout(() => rip.remove(), 400);
    }, 800);
  }

  function clickPoint(x, y) {
    const el = document.elementFromPoint(x, y) || document.body;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  const is3Point = coords.mode === '3point' || Boolean(coords.point3);
  const delay1 = coords.delay1Ms || coords.delayMs || 350;
  const delay2 = coords.delay2Ms || 400;

  if (is3Point) {
    showClickRipple(coords.point1.x, coords.point1.y, '1: 3-Dot', '#6366f1');
    clickPoint(coords.point1.x, coords.point1.y);

    if (coords.point2) {
      await new Promise((r) => setTimeout(r, delay1));
      showClickRipple(coords.point2.x, coords.point2.y, '2: Menu', '#f59e0b');
      clickPoint(coords.point2.x, coords.point2.y);
    }

    if (coords.point3) {
      await new Promise((r) => setTimeout(r, delay2));
      showClickRipple(coords.point3.x, coords.point3.y, '3: Save', '#10b981');
      clickPoint(coords.point3.x, coords.point3.y);
    }
  } else {
    showClickRipple(coords.point1.x, coords.point1.y, '1: Lock', '#6366f1');
    clickPoint(coords.point1.x, coords.point1.y);

    if (coords.point2) {
      await new Promise((r) => setTimeout(r, delay1));
      showClickRipple(coords.point2.x, coords.point2.y, '2: Save', '#10b981');
      clickPoint(coords.point2.x, coords.point2.y);
    }
  }
}

/**
 * Remove any active in-page dock from all open Gmail tabs
 */
async function removeInPageDockFromAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://mail.google.com/*' });
    for (const t of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: injectedRemoveInPageDockScript
        });
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Injected script: Remove in-page dock container
 */
function injectedRemoveInPageDockScript() {
  const container = document.getElementById('midey-inpage-dock-container');
  if (container) {
    container.remove();
  }
}

/**
 * Injected script: Mounts and updates in-page dock container on Gmail tab
 * Supports Left, Right, Bottom with draggable edge resizer and iframe embedding.
 */
function injectedInPageDockScript(position, iframeUrl) {
  let container = document.getElementById('midey-inpage-dock-container');
  const isNew = !container;

  if (isNew) {
    container = document.createElement('div');
    container.id = 'midey-inpage-dock-container';
    document.body.appendChild(container);
  }

  // Load saved dimensions if any
  let savedDims = {};
  try {
    savedDims = JSON.parse(localStorage.getItem('midey_dock_dims') || '{}');
  } catch (_) {}

  const defaultWidth = savedDims.width || 440;
  const defaultHeight = savedDims.height || 380;

  const isLeft = position === 'left';
  const isBottom = position === 'bottom';
  const isRight = position === 'right';

  let posCss = '';
  if (isLeft) {
    posCss = `
      left: 0;
      top: 0;
      bottom: 0;
      width: ${defaultWidth}px;
      height: 100vh;
      border-right: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
    `;
  } else if (isBottom) {
    posCss = `
      left: 0;
      right: 0;
      bottom: 0;
      width: 100vw;
      height: ${defaultHeight}px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
    `;
  } else {
    posCss = `
      right: 0;
      top: 0;
      bottom: 0;
      width: ${defaultWidth}px;
      height: 100vh;
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.5);
    `;
  }

  container.style.cssText = `
    position: fixed;
    z-index: 2147483640;
    background: #0f172a;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transition: opacity 0.2s ease, transform 0.2s ease;
    ${posCss}
  `;

  container.innerHTML = `
    <div id="midey-dock-resizer" style="
      position: absolute;
      ${isLeft ? 'top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize;' : ''}
      ${isRight ? 'top: 0; left: -4px; width: 8px; height: 100%; cursor: col-resize;' : ''}
      ${isBottom ? 'top: -4px; left: 0; width: 100%; height: 8px; cursor: row-resize;' : ''}
      z-index: 2147483645;
      background: transparent;
    " title="Drag to resize dock"></div>

    <div id="midey-dock-bar" style="
      height: 28px;
      background: #1e293b;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      user-select: none;
      box-sizing: border-box;
    ">
      <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: #f8fafc;">
        <span style="display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; background: #6366f1; border-radius: 4px; font-size: 10px; color: #fff;">M</span>
        <span>Midey Mailer</span>
        <span style="font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: rgba(99, 102, 241, 0.2); color: #a5b4fc; font-weight: 600; text-transform: uppercase;">
          Dock: ${position}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="midey-dock-popout-btn" style="background: none; border: none; color: #94a3b8; font-size: 11px; cursor: pointer; padding: 2px 5px; border-radius: 3px;" title="Pop out into separate window">
          🗗
        </button>
        <button id="midey-dock-close-btn" style="background: none; border: none; color: #ef4444; font-size: 12px; font-weight: 800; cursor: pointer; padding: 2px 6px; border-radius: 3px;" title="Close Dock">
          ✕
        </button>
      </div>
    </div>

    <iframe id="midey-dock-iframe" src="${iframeUrl}" style="
      width: 100%;
      height: calc(100% - 28px);
      border: none;
      background: transparent;
    " allow="clipboard-read; clipboard-write"></iframe>
  `;

  const popoutBtn = container.querySelector('#midey-dock-popout-btn');
  popoutBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'DOCK_POPOUT' });
  });

  const closeBtn = container.querySelector('#midey-dock-close-btn');
  closeBtn?.addEventListener('click', () => {
    container.remove();
    chrome.runtime.sendMessage({ action: 'CLOSE_INPAGE_DOCK' });
  });

  const resizer = container.querySelector('#midey-dock-resizer');
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let dragCover = null;

  function onMouseDown(e) {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = container.offsetWidth;
    startH = container.offsetHeight;

    dragCover = document.createElement('div');
    dragCover.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483647;
      cursor: ${isBottom ? 'row-resize' : 'col-resize'};
    `;
    document.body.appendChild(dragCover);

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isResizing) return;
    if (isLeft) {
      const newWidth = Math.max(320, Math.min(window.innerWidth - 80, startW + (e.clientX - startX)));
      container.style.width = newWidth + 'px';
      saveDims({ width: newWidth });
    } else if (isRight) {
      const newWidth = Math.max(320, Math.min(window.innerWidth - 80, startW - (e.clientX - startX)));
      container.style.width = newWidth + 'px';
      saveDims({ width: newWidth });
    } else if (isBottom) {
      const newHeight = Math.max(220, Math.min(window.innerHeight - 80, startH - (e.clientY - startY)));
      container.style.height = newHeight + 'px';
      saveDims({ height: newHeight });
    }
  }

  function onMouseUp() {
    isResizing = false;
    if (dragCover) {
      dragCover.remove();
      dragCover = null;
    }
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
  }

  function saveDims(update) {
    try {
      const curr = JSON.parse(localStorage.getItem('midey_dock_dims') || '{}');
      localStorage.setItem('midey_dock_dims', JSON.stringify({ ...curr, ...update }));
    } catch (_) {}
  }

  resizer?.addEventListener('mousedown', onMouseDown);
}


