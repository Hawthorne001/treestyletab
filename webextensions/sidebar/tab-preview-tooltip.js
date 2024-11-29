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
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import Tab from '/common/Tab.js';

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

const CUSTOM_PANEL_AVAILABLE_URLS_MATCHER = new RegExp(`^((https?|data):|moz-extension://${location.host}/)`);
const DIRECT_PANEL_AVAILABLE_URLS_MATCHER = new RegExp(`^moz-extension://${location.host}/`);
const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

document.addEventListener(kEVENT_TAB_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TAB_SUBSTANCE_LEAVE, onTabSubstanceLeave);

async function prepareFrame(tabId) {
  const tab = Tab.get(tabId);
  if (!tab)
    return;

  if (DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url)) {
    // We must not insert iframe containing script tag with the internal URL
    // if the tab is TST's internal page, because Firefox closes such tabs
    // when the addon is reloaded. Instead we load tab preview frame script
    // to the internal page directly.
    await browser.tabs.executeScript(tabId, {
      runAt: 'document_start',
      file: '/resources/tab-preview-frame.js',
    });
    return;
  }

  await browser.tabs.executeScript(tabId, {
    matchAboutBlank: true,
    runAt: 'document_start',
    code: `(() => {
      const url = '${browser.runtime.getURL('/resources/tab-preview-frame.html')}';

      // cleanup!
      const oldFrames = document.querySelectorAll('iframe[src="' + url + '"]');
      for (const oldFrame of oldFrames) {
        oldFrame.parentNode.removeChild(oldFrame);
      }

      const frame = document.createElement('iframe');
      frame.setAttribute('src', url);
      frame.setAttribute('style', ${JSON.stringify(TAB_PREVIEW_FRAME_STYLE)});
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
            //frame.dataset.frameId = message.frameId; // Just for debugging. Do not expose this on released version!
            break;

          case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
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
      document.documentElement.addEventListener('mouseenter', () => {
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

async function sendTabPreviewMessage(tabId, message, deferredReturnedValueResolver) {
  if (!tabId) { // in-sidebar mode
    return sendInSidebarTabPreviewMessage(message);
  }

  const retrying = !!deferredReturnedValueResolver;

  const tab = Tab.get(tabId);
  if (!tab)
    return false;

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
    if (!frameId &&
        (!loadedInfo ||
         loadedInfo.tabId != tabId)) {
      if (!message.canRetry)
        return false;

      if (retrying) {
        // Retried to load tab preview frame, but failed, so
        // now we fall back to the in-sidebar tab preview.
        if (!shouldMessageSend(message) ||
            DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url)) {
          deferredReturnedValueResolver(false);
          return false;
        }
        return sendInSidebarTabPreviewMessage(message)
          .then(deferredReturnedValueResolver)
          .then(() => true);
      }

      if (!shouldMessageSend(message))
        return false;

      // We prepare tab preview frame now, and retry sending after that.
      await prepareFrame(tabId);
      let returnedValueResolver;
      const promisedReturnedValue = new Promise((resolve, _reject) => {
        returnedValueResolver = resolve;
      });
      setTimeout(() => {
        sendTabPreviewMessage(tabId, message, returnedValueResolver);
      }, 100);
      return promisedReturnedValue;
    }
  }
  catch (_error) {
    // We cannot show tab preview tooltip in a tab with privileged contents.
    // Let's fall back to the in-sidebar tab preview.
    await sendInSidebarTabPreviewMessage(message);
    if (deferredReturnedValueResolver)
      deferredReturnedValueResolver(true);
    return true;
  }

  // hide in-sidebar tab preview if in-content tab preview is available
  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
  });

  let returnValue;
  try {
    returnValue = await browser.tabs.sendMessage(tabId, {
      tabId,
      timestamp: Date.now(),
      ...message,
    }, frameId ? { frameId } : {});
    if (deferredReturnedValueResolver)
      deferredReturnedValueResolver(returnValue);
  }
  catch (_error) {
    if (!message.canRetry)
      return false;

    if (retrying) {
      // Retried to load tab preview frame, but failed, so
      // now we fall back to the in-sidebar tab preview.
      if (!shouldMessageSend(message)) {
        deferredReturnedValueResolver(false);
        return false;
      }
      return sendInSidebarTabPreviewMessage(message)
        .then(deferredReturnedValueResolver)
        .then(() => true);
    }

    if (!shouldMessageSend(message))
      return false;

    // the frame was destroyed unexpectedly, so we re-prepare it.
    await prepareFrame(tabId);
    let returnedValueResolver;
    const promisedReturnedValue = new Promise((resolve, _reject) => {
      returnedValueResolver = resolve;
    });
    setTimeout(() => {
      sendTabPreviewMessage(tabId, message, returnedValueResolver);
    }, 100);
    return promisedReturnedValue;
  }

  if (typeof returnValue != 'boolean' &&
      shouldMessageSend(message)) {
    // Failed to send message to the in-content tab preview frame, so
    // now we fall back to the in-sidebar tab preview.
    return sendInSidebarTabPreviewMessage(message);
  }

  // Everything is OK!
  return returnValue;
}

async function sendInSidebarTabPreviewMessage(message) {
  await browser.runtime.sendMessage({
    ...message,
    timestamp: Date.now(),
    windowId: TabsStore.getCurrentWindowId(),
  });
  return true;
}

async function onTabSubstanceEnter(event) {
  const startAt = Date.now();
  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (!configs.tabPreviewTooltip) {;
    sendTabPreviewMessage(activeTab.id, {
      type: 'treestyletab:hide-tab-preview',
    });
    return;
  }

  if (!event.target.tab)
    return;

  hoveringTabIds.add(event.target.tab.id);
  const tooltipText = event.target.appliedTooltipText;
  const tooltipHtml = event.target.appliedTooltipHtml;

  const targetTabId = CUSTOM_PANEL_AVAILABLE_URLS_MATCHER.test(activeTab.url) ?
    activeTab.id :
    null;

  const tabRect = event.target.tab.$TST.element?.getBoundingClientRect();
  const active = event.target.tab.id == activeTab.id;
  const url = PREVIEW_WITH_HOST_URLS_MATCHER.test(event.target.tab.url) ? new URL(event.target.tab.url).host :
    PREVIEW_WITH_TITLE_URLS_MATCHER.test(event.target.tab.url) ? null :
      event.target.tab.url;

  // This calculation logic is buggy for a window in a screen placed at
  // left of the primary display and scaled. As the result, a sidebar
  // placed at left can be mis-detected as placed at right. For safety
  // I ignore such cases and always treat such cases as "left side placed".
  // See also: https://github.com/piroor/treestyletab/issues/2984#issuecomment-901907503
  const mayBeRight = window.screenX < 0 && window.devicePixelRatio > 1 ?
    false :
    window.mozInnerScreenX - window.screenX > (window.outerWidth - window.innerWidth) / 2;

  const hasPreview = (
    !active &&
    !event.target.tab.discarded &&
    CAPTURABLE_URLS_MATCHER.test(event.target.tab.url) &&
    tooltipText == event.target.tab.title
  );

  let succeeded = await sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:show-tab-preview',
    previewTabId: event.target.tab.id,
    tabRect: {
      bottom: tabRect?.bottom || 0,
      height: tabRect?.height || 0,
      left:   tabRect?.left || 0,
      right:  tabRect?.right || 0,
      top:    tabRect?.top || 0,
      width:  tabRect?.width || 0,
    },
    /* These information is used to calculate offset of the sidebar header */
    offsetTop: window.mozInnerScreenY - window.screenY,
    offsetLeft: window.mozInnerScreenX - window.screenX,
    align: mayBeRight ? 'right' : 'left',
    scale: 1 / window.devicePixelRatio,
    active,
    title: event.target.tab.title,
    url,
    tooltipText,
    tooltipHtml,
    hasPreview,
    timestamp: startAt, // Don't call Date.now() here, because it can become larger than the timestamp on mouseleave.
    canRetry: !!targetTabId,
  }).catch(_error => {});

  let previewURL = null;
  if (hasPreview) {
    try {
      previewURL = await browser.tabs.captureTab(event.target.tab.id);
      if (!event.target.tab) // the tab may be destroyied while capturing
        return;
    }
    catch (_error) {
    }
  }

  if (previewURL) {
    //console.log(event.type, event, event.target.tab, event.target, activeTab);
    succeeded = await sendTabPreviewMessage(targetTabId, {
      type: 'treestyletab:update-tab-preview',
      previewTabId: event.target.tab.id,
      previewURL,
      timestamp: Date.now(),
    }).catch(_error => {});
    //console.log('tab preview for ', event.target.tab?.id, ' : success? : ', success);
  }
  if (event.target.tab.$TST.element &&
      succeeded)
    event.target.tab.$TST.element.invalidateTooltip();
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);

function onTabSubstanceLeave(event) {
  const startAt = Date.now();
  if (!event.target.tab)
    return;

  hoveringTabIds.delete(event.target.tab.id);

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  const targetTabId = CUSTOM_PANEL_AVAILABLE_URLS_MATCHER.test(activeTab.url) ?
    activeTab.id :
    null;

  //console.log(event.type, event.target.tab, event.target, activeTab);
  sendTabPreviewMessage(targetTabId, {
    type: 'treestyletab:hide-tab-preview',
    previewTabId: event.target.tab.id,
    timestamp: startAt,
  });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);


browser.tabs.onActivated.addListener(activeInfo => {
  if (activeInfo.windowId != TabsStore.getCurrentWindowId())
    return;

  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
  });
  sendTabPreviewMessage(activeInfo.tabId, {
    type: 'treestyletab:hide-tab-preview',
  });
  sendTabPreviewMessage(activeInfo.previousTabId, {
    type: 'treestyletab:hide-tab-preview',
  });
});


browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type != 'treestyletab:tab-preview-frame-loaded')
    return;

  // in-sidebar preview
  if (sender.envType == 'addon_child' &&
      !sender.frameId) {
    return;
  }

  // in-tab previews with TST internal pages
  if (sender.tab &&
      DIRECT_PANEL_AVAILABLE_URLS_MATCHER.test(sender.tab.url)) {
    browser.tabs.sendMessage(sender.tab.id, {
      type: 'treestyletab:notify-tab-preview-owner-info',
      tabId: sender.tab.id,
    });
    return;
  }

  // in-tab previews
  const windowId = TabsStore.getCurrentWindowId();
  if (windowId &&
      sender.tab?.windowId == windowId) {
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
  document.querySelector('#tab-preview-tooltip-frame').src = `/resources/tab-preview-frame.html?windowId=${windowId}`;
});

document.querySelector('#tabbar').addEventListener('mouseleave', async () => {
  sendInSidebarTabPreviewMessage({
    type: 'treestyletab:hide-tab-preview',
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  sendTabPreviewMessage(activeTab.id, {
    type: 'treestyletab:hide-tab-preview',
  });
});
