/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// Overview of the tab preview tooltip:
//
// Tab preview tooltips are processed by the combination of this script
// and content scripts. Players are:
//
// * This script (CONTROLLER)
// * The content script of the active tab to load tab preview frames
//   (LOADER): injected by prepareFrame()
// * The content script of the tab preview frame (FRAME): loaded as
//   `/resources/tab-preview-frame.js`
// * The tab A: a tab to be shown in the preview tooltip.
// * The tab B: the active tab which is used to show the preview tooltip.
//
// When we need to show a tab preview:
//
// 1. The CONTROLLER detects `tab-item-substance-enter` (`mouseenter`) event
//    on a tab substance.
// 2. The CONTROLLER sends a message to the LOADER of the active tab,
//    like "do you know the 'frameId' in your paeg?"
//    1. If no response, the CONTROLLER loads a content script LOADER
//       into the active tab.
//       1. The LOADER generates a transparent iframe with the URL of
//          `/resources/tab-preview-frame.html`.
//       2. The FRAME is loaded and it sends a message to the CONTROLLER
//          like "now I'm ready!"
//       3. The CONTROLLER receives the message and gets the `sender.frameId`
//          information corresponding to the message.
//       4. The CONTROLLER sends the `frameId` information to the LOADER
//          of the active tab, like "hey, your iframe is loaded  with the
//          frameId XXX!`
//       5. The LOADER of the active tab tracks the notified `frameId`.
//    2. The LOADER of the active tab responds to the CONTROLLER, like
//       "OK, I'm ready and the frameId of my iframe is XXX!"
//    3. If these operation is not finished until some seconds, the
//       CONTROLLER gives up to show the preview.
// 3. The CONTROLLER receives the "I'm ready" response with `frameId` from
//    the LOADER of the active tab.
// 4. The CONTROLLER generates a thumbnail image for the tab A, and sends
//    a message with `frameId` to the FRAME in the active  tab, like "show
//    a preview with a thumbnail image 'data:image/png,...' at the position
//    (x,y)"
// 5. The FRAME with the specified `frameId` shows the preview.
//
// When we need to hide a tab preview:
//
// 1. The CONTROLLER detects `tab-item-substance-leave` (`mouseleave`) event
//    on a tab substance.
// 2. The CONTROLLER sends a message to the LOADER of the active tab, like
//    "do you know the 'frameId' in your paeg?"
//    1. If no response, the CONTROLLER gives up to hide the preview.
//       We have nothing to do.
// 3. The CONTROLLER receives the "I'm ready" response with `frameId` from
//    the LOADER of the active tab.
// 4. The CONTROLLER sends a message with `frameId` to the FRAME in the
//    active tab, like "hide a preview"
// 5. The FRAME with the specified `frameId` hides the preview.
//
// I think the CONTROLLER should not track `frameId` for each tab.
// Contents of tabs are frequently destroyed, so `frameId` information
// stored (cached) by the CONTROLLER will become obsolete too easily.

import {
  configs,
  shouldApplyAnimation,
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import Tab from '/common/Tab.js';

import * as TabPreviewFrame from '/resources/module/tab-preview-frame.js';

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';

import { kEVENT_TAB_SUBSTANCE_ENTER, kEVENT_TAB_SUBSTANCE_LEAVE } from './components/TabElement.js';

const TAB_PREVIEW_FRAME_STYLE = `
  background: transparent;
  border: 0 none;
  bottom: 0;
  height: 100%;
  left: 0;
  overflow: hidden;
  pointer-events: none;
  position: fixed;
  right: 0;
  top: 0;
  width: 100%;
  z-index: ${Number.MAX_SAFE_INTEGER};
`;

const DIRECT_PANEL_AVAILABLE_URLS_MATCHER = new RegExp(`^moz-extension://${location.host}/`);
const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

document.addEventListener(kEVENT_TAB_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TAB_SUBSTANCE_LEAVE, onTabSubstanceLeave);

function log(...args) {
  internalLogger('sidebar/tab-preview-tooltip', ...args);
}

// Generates a custom element name at random. This mainly aims to avoid
// conflicting of custom element names defined by webpage scripts.
// The generated name is user-unfriendly, this aims to guard your privacy.
function generateOneTimeCustomElementName() {
  const alphabets = 'abcdefghijklmnopqrstuvwxyz';
  const prefix = alphabets[Math.floor(Math.random() * alphabets.length)];
  return prefix + '-' + Date.now() + '-' + Math.round(Math.random() * 65000);
}

async function prepareFrame(tabId) {
  const tab = Tab.get(tabId);
  if (!tab)
    return;

  if (DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url)) {
    log('prepareFrame: load script to the tab contents itself ', tab.url);
    // We must not insert iframe containing script tag with the internal URL
    // if the tab is TST's internal page, because Firefox closes such tabs
    // when the addon is reloaded. Instead we load tab preview frame script
    // to the internal page directly.
    await browser.tabs.executeScript(tabId, {
      runAt: 'document_start',
      file: '/resources/module/tab-preview-frame.js',
    });
    return;
  }

  log('prepareFrame: insert iframe to the tab contents ', tab.url);
  const logging = configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug;
  await browser.tabs.executeScript(tabId, {
    matchAboutBlank: true,
    runAt: 'document_start',
    code: `(() => {
      const logging = ${!!logging};

      window.closedIframeType = window.closedIframeType || '${generateOneTimeCustomElementName()}';

      // cleanup!
      for (const oldFrame of document.querySelectorAll(window.closedIframeType)) {
        oldFrame.parentNode.removeChild(oldFrame);
      }

      // We cannot undefine custom element types, so we define it just one time.
      if (!window.customElements.get(window.closedIframeType)) {
        // This may exposes "moz-extension://<UUID>/" URL to the webpage, so
        // it may allow the webpage to identify you by fingerprinting with the
        // UUID. It is not safe for privacy, but sadly this is most safer way
        // we can do.
        // If we load iframe with "about:blank", we cannot inject arbitrary
        // script into the iframe due to restrictions of WebExtensions API
        // (tabs.executeScript()) and the cross-origin policy. We can bypass
        // the cross-origin restrictions with sandbox=allow-same-origin, but
        // it means that webpage scripts can read all contents of the iframe,
        // thus titles and URLs (and preview images) from other tabs will be
        // accessible from webpage scripts - it is seriously vulnerable.
        // Data: URI and Blob URL have same issue.
        const url = '${browser.runtime.getURL('/resources/tab-preview-frame.html')}';
        // So we use a wrapper custom element to enclose the raw iframe.
        // It should guard the raw iframe from accesses by webpage scripts.
        class ClosedIframe extends HTMLElement {
          constructor() {
            super();
            const shadow = this.attachShadow({ mode: 'closed' });
            const frame = document.createElement('iframe');
            frame.setAttribute('src', url);
            frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
            frame.setAttribute('style', ${JSON.stringify(TAB_PREVIEW_FRAME_STYLE)});
            shadow.appendChild(frame);
          }
        }
        window.customElements.define(window.closedIframeType, ClosedIframe);
      }
      const frame = document.createElement(window.closedIframeType);
      document.documentElement.appendChild(frame);

      let lastFrameId;
      let windowId;

      const onMessage = (message, _sender) => {
        switch (message?.type) {
          case 'treestyletab:ask-tab-preview-frame-id':
            if (lastFrameId)
              return Promise.resolve(lastFrameId);
            break;

          case 'treestyletab:notify-tab-preview-owner-info':
            lastFrameId = message.frameId;
            windowId = message.windowId;
            if (logging)
              console.log('tab preview owner notified: ', {
                frameId: lastFrameId,
                windowId,
              });
            //frame.dataset.frameId = message.frameId; // Just for debugging. Do not expose this on released version!
            break;

          case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
            if (logging)
              console.log('tab detached from window, destroy tab preview frame');
            destroy();
            break;
        }
      };
      browser.runtime.onMessage.addListener(onMessage);

      const destroy = () => {
        if (!frame.parentNode)
          return;
        lastFrameId = null;
        windowId = null;
        frame.parentNode.removeChild(frame);
        browser.runtime.onMessage.removeListener(onMessage);
      };
      document.documentElement.addEventListener('mousemove', () => {
        if (logging)
          console.log('mouse move on the content area, destroy tab preview frame');
        browser.runtime.sendMessage({
          type: 'treestyletab:hide-tab-preview',
          windowId,
          timestamp: Date.now(),
        });
        destroy();
      }, { once: true });
    })()`,
  });
}

const hoveringTabIds = new Set();

function shouldMessageSend(message) {
  return (
    message.type != 'treestyletab:show-tab-preview' ||
    hoveringTabIds.has(message.previewTabId)
  );
}

// returns succeeded or not (boolean)
async function sendTabPreviewMessage(tabId, message, deferredResultResolver) {
  const shouldFallbackToSidebar = configs.tabPreviewTooltipInSidebar && !message.hasCustomTooltip;
  if (!tabId) { // in-sidebar mode
    if (shouldFallbackToSidebar) {
      log(`sendTabPreviewMessage(${message.type}): no tab specified, fallback to in-sidebar preview`);
      return sendInSidebarTabPreviewMessage(message);
    }
    else {
      log(`sendTabPreviewMessage(${message.type}): no tab specified, cancel`);
      return false;
    }
  }

  const retrying = !!deferredResultResolver;

  const tab = Tab.get(tabId);
  if (!tab)
    return false;

  const promisedPreviewURL = typeof message.previewURL == 'function' && message.previewURL();

  let frameId;
  let loadedInfo;
  try {
    const [gotFrameId, gotLoadedInfo] = await Promise.all([
      browser.tabs.sendMessage(tabId, {
        type: 'treestyletab:ask-tab-preview-frame-id',
      }).catch(_error => {}),
      DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url) && browser.tabs.sendMessage(tabId, {
        type: 'treestyletab:ask-tab-preview-frame-loaded',
        tabId,
      }).catch(_error => {}),
    ]);
    frameId = gotFrameId;
    loadedInfo = gotLoadedInfo;
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): response from the tab: `, { frameId, loadedInfo });
    if (!frameId &&
        (!loadedInfo ||
         loadedInfo.tabId != tabId)) {
      if (!message.canRetry) {
        log(` => no response, give up to send`);
        return false;
      }

      if (retrying) {
        // Retried to load tab preview frame, but failed, so
        // now we fall back to the in-sidebar tab preview.
        if (!shouldFallbackToSidebar ||
            !shouldMessageSend(message) ||
            DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url)) {
          log(` => no response after retrying, give up to send`);
          deferredResultResolver(false);
          return false;
        }
        log(` => no response after retrying, fall back to in-sidebar previes`);
        return sendInSidebarTabPreviewMessage(message)
          .then(() => {
            deferredResultResolver(true);
            return true;
          });
      }

      if (!shouldMessageSend(message)) {
        log(` => no response, already canceled, give up to send`);
        return false;
      }

      // We prepare tab preview frame now, and retry sending after that.
      log(` => no response, retry`);
      let resultResolver;
      const promisedResult = new Promise((resolve, _reject) => {
        resultResolver = resolve;
      });
      waitUntilPreviewFrameLoadedIntoTab(tabId).then(() => {
        sendTabPreviewMessage(tabId, message, resultResolver);
      });
      await prepareFrame(tabId);
      return promisedResult;
    }
  }
  catch (error) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): failed to ask to the tab `, error);
    // We cannot show tab preview tooltip in a tab with privileged contents.
    // Let's fall back to the in-sidebar tab preview.
    await sendInSidebarTabPreviewMessage(message);
    if (deferredResultResolver)
      deferredResultResolver(true);
    return true;
  }

  // hide in-sidebar tab preview if in-content tab preview is available
  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
  });

  let response;
  try {
    const timestamp = Date.now();
    response = await browser.tabs.sendMessage(tabId, {
      tabId,
      timestamp,
      ...message,
      ...TabPreviewFrame.getColors(),
      ...(promisedPreviewURL ? { previewURL: null } : {}),
      animation: shouldApplyAnimation(),
      logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
    }, frameId ? { frameId } : {});
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): message was sent to the frame, response=`, response, ', promisedPreviewURL=', promisedPreviewURL);
    if (deferredResultResolver)
      deferredResultResolver(!!response);

    if (response && promisedPreviewURL) {
      log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}, with previewURL): trying to get preview URL`);
      promisedPreviewURL.then(async previewURL => {
        const response = await browser.tabs.sendMessage(tabId, {
          tabId,
          timestamp,
          ...message,
          previewURL,
          ...TabPreviewFrame.getColors(),
          animation: shouldApplyAnimation(),
          logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
        }, frameId ? { frameId } : {});
        log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}, with previewURL): message was sent to the frame again, response=`, response);
      });
    }
  }
  catch (error) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): failed to send message to the frame `, error);
    if (!message.canRetry) {
      log(` => no response, give up to send`);
      return false;
    }

    if (retrying) {
      // Retried to load tab preview frame, but failed, so
      // now we fall back to the in-sidebar tab preview.
      if (!shouldFallbackToSidebar ||
          !shouldMessageSend(message)) {
        log(` => no response after retrying, give up to send`);
        deferredResultResolver(false);
        return false;
      }
      log(` => no response after retrying, fall back to in-sidebar previes`);
      return sendInSidebarTabPreviewMessage(message)
        .then(() => {
          deferredResultResolver(true);
          return true;
        });
    }

    if (!shouldMessageSend(message)) {
      log(` => no response, already canceled, give up to send`);
      return false;
    }

    // the frame was destroyed unexpectedly, so we re-prepare it.
    log(` => no response, retry`);
    let resultResolver;
    const promisedResult = new Promise((resolve, _reject) => {
      resultResolver = resolve;
    });
    waitUntilPreviewFrameLoadedIntoTab(tabId).then(() => {
      sendTabPreviewMessage(tabId, message, resultResolver);
    });
    await prepareFrame(tabId);
    return promisedResult;
  }

  if (typeof response != 'boolean' &&
      shouldMessageSend(message)) {
    log(`sendTabPreviewMessage(${message.type}${retrying ? ', retrying' : ''}): got invalid response, fallback to in-sidebar preview`);
    // Failed to send message to the in-content tab preview frame, so
    // now we fall back to the in-sidebar tab preview.
    return sendInSidebarTabPreviewMessage(message);
  }

  // Everything is OK!
  return !!response;
}

async function waitUntilPreviewFrameLoadedIntoTab(tabId) {
  let resolver;
  const promisedLoaded = new Promise((resolve, _reject) => {
    resolver = resolve;
  });
  let timeout;
  const onMessage = (message, sender) => {
    if (message?.type != 'treestyletab:tab-preview-frame-loaded' ||
        sender.tab?.id != tabId)
      return;
    log('waitUntilPreviewFrameLoadedIntoTab: loaded in the tab ', tabId);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    resolver();
  };
  browser.runtime.onMessage.addListener(onMessage);
  timeout = setTimeout(() => {
    if (!timeout)
      return;
    log('waitUntilPreviewFrameLoadedIntoTab: timeout for the tab ', tabId);
    timeout = null;
    browser.runtime.onMessage.removeListener(onMessage);
    resolver();
  }, 1000);
  return promisedLoaded;
}


async function sendInSidebarTabPreviewMessage(message) {
  const startAt = message.startAt || Date.now();
  log(`sendInSidebarTabPreviewMessage(${message.type}})`);
  if (typeof message.previewURL == 'function')
    message.previewURL = await message.previewURL();
  await TabPreviewFrame.handleMessage({
    timestamp: startAt,
    ...message,
    windowId: TabsStore.getCurrentWindowId(),
    animation: shouldApplyAnimation(),
    logging: configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug,
  });
  return true;
}

async function onTabSubstanceEnter(event) {
  const startAt = Date.now();

  const canRunScript = Permissions.isGrantedSync(Permissions.ALL_URLS);
  if (!canRunScript)
    return;

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());

  if (!configs.tabPreviewTooltip) {;
    sendTabPreviewMessage(activeTab.id, {
      type: 'treestyletab:hide-tab-preview',
    });
    return;
  }

  const active = event.target.tab.id == activeTab.id;
  const url = PREVIEW_WITH_HOST_URLS_MATCHER.test(event.target.tab.url) ? new URL(event.target.tab.url).host :
    PREVIEW_WITH_TITLE_URLS_MATCHER.test(event.target.tab.url) ? null :
      event.target.tab.url;
  const hasCustomTooltip = !!event.target.hasCustomTooltip;
  const hasPreview = (
    !active &&
    !event.target.tab.discarded &&
    CAPTURABLE_URLS_MATCHER.test(event.target.tab.url) &&
    !hasCustomTooltip
  );
  const previewURL = (
    hasPreview &&
    canRunScript &&
    configs.tabPreviewTooltip &&
    (async () => { // We just define a getter function for now, because further operations may contain async operations and we can call this at there for more optimization.
      try {
        return await browser.tabs.captureTab(event.target.tab.id);
      }
      catch (_error) {
      }
      return null;
    })
  ) || null;

  if (!event.target.tab)
    return;

  log(`onTabSubstanceEnter(${event.target.tab.id}}) start `, startAt);

  hoveringTabIds.add(event.target.tab.id);
  const tooltipText = event.target.appliedTooltipText;
  const tooltipHtml = event.target.appliedTooltipHtml;
  const targetTabId = Permissions.canInjectScriptToTabSync(activeTab) ?
    activeTab.id :
    null;

  const previewTabRawRect = event.target.tab.$TST.element?.substanceElement?.getBoundingClientRect();
  const previewTabRect = {
    bottom: previewTabRawRect?.bottom || 0,
    height: previewTabRawRect?.height || 0,
    left:   previewTabRawRect?.left || 0,
    right:  previewTabRawRect?.right || 0,
    top:    previewTabRawRect?.top || 0,
    width:  previewTabRawRect?.width || 0,
  };

  // This calculation logic is buggy for a window in a screen placed at
  // left of the primary display and scaled. As the result, a sidebar
  // placed at left can be mis-detected as placed at right. For safety
  // I ignore such cases and always treat such cases as "left side placed".
  // See also: https://github.com/piroor/treestyletab/issues/2984#issuecomment-901907503
  const mayBeRight = window.screenX < 0 && window.devicePixelRatio > 1 ?
    false :
    window.mozInnerScreenX - window.screenX > (window.outerWidth - window.innerWidth) / 2;

  log(`onTabSubstanceEnter(${event.target.tab.id}}) [${Date.now() - startAt}msec from start]: show tab preview in ${targetTabId || 'sidebar'} `, { hasCustomTooltip, tooltipText, hasPreview });
  const succeeded = await sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:show-tab-preview',
    previewTabId: event.target.tab.id,
    previewTabRect,
    /* These information is used to calculate offset of the sidebar header */
    offsetTop: window.mozInnerScreenY - window.screenY,
    offsetLeft: window.mozInnerScreenX - window.screenX,
    align: mayBeRight ? 'right' : 'left',
    scale: 1 / window.devicePixelRatio,
    hasCustomTooltip,
    ...(hasCustomTooltip ?
      {
        tooltipHtml,
      } :
      {
        title: event.target.tab.title,
        url,
      }
    ),
    hasPreview,
    previewURL,
    // This is required to simulate the behavior:
    // show tab preview panel with delay only when the panel is not shown yet.
    waitInitialShowUntil: startAt + Math.max(configs.tabPreviewTooltipDelayMsec, 0),
    // Don't call Date.now() here, because it can become larger than
    // the timestamp on mouseleave.
    timestamp: startAt,
    canRetry: !!targetTabId,
  }).catch(error => {
    log(`onTabSubstanceEnter(${event.target.tab.id}}) failed: `, error);
  });
  log(` => ${succeeded ? 'succeeded' : 'failed'}`);

  if (!event.target.tab) // the tab may be destroyied while we capturing tab preview
    return;

  if (event.target.tab.$TST.element &&
      succeeded)
    event.target.tab.$TST.element.invalidateTooltip();
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);

async function onTabSubstanceLeave(event) {
  const startAt = Date.now();
  if (!event.target.tab)
    return;

  hoveringTabIds.delete(event.target.tab.id);

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = await Permissions.canInjectScriptToTab(activeTab) ?
    activeTab.id :
    null;

  if (!event.target.tab) // the tab was closed while waiting
    return;

  log(`onTabSubstanceLeave(${event.target.tab.id}}) hide tab preview in ${targetTabId || 'sidebar'} `, startAt);
  sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:hide-tab-preview',
    previewTabId: event.target.tab.id,
    timestamp: startAt,
  });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);


browser.tabs.onActivated.addListener(activeInfo => {
  const startAt = Date.now();

  if (activeInfo.windowId != TabsStore.getCurrentWindowId())
    return;

  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
  sendTabPreviewMessage(activeInfo.tabId, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
  sendTabPreviewMessage(activeInfo.previousTabId, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
});


browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type != 'treestyletab:tab-preview-frame-loaded')
    return;

  log('tab preview frame is loaded, sender = ', sender);

  if (sender.envType == 'addon_child' &&
      !sender.frameId) {
    log(' => in-sidebar preview');
    return;
  }

  if (sender.tab &&
      DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(sender.tab.url)) {
    log(' => in-content previews with TST internal pages');
    browser.tabs.sendMessage(sender.tab.id, {
      type: 'treestyletab:notify-tab-preview-owner-info',
      tabId: sender.tab.id,
    });
    return;
  }

  const windowId = TabsStore.getCurrentWindowId();
  if (windowId &&
      sender.tab?.windowId == windowId) {
    log(' => in-content previews with regular webpages');
    browser.tabs.sendMessage(sender.tab.id, {
      type: 'treestyletab:notify-tab-preview-owner-info',
      frameId: sender.frameId,
      windowId,
    });
    return;
  }
});

Sidebar.onReady.addListener(() => {
  const windowId = TabsStore.getCurrentWindowId();
  TabPreviewFrame.setWindowId(windowId);
});

document.querySelector('#tabbar').addEventListener('mouseleave', async () => {
  const startAt = Date.now();
  log('mouse is left from the tab bar ', startAt);

  hoveringTabIds.clear();

  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  sendTabPreviewMessage(activeTab.id, {
    type: 'treestyletab:hide-tab-preview',
    timestamp: startAt,
  });
});
