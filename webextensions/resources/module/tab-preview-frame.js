/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This is a sub part to show tab preview tooltip.
// See also: /siedbar/tab-preview-tooltip.js

// This script can be loaded in three ways:
//  * REGULAR case:
//    loaded into an iframe embedded to a public webpage
//  * TAB case:
//    loaded into an TST internal page loaded in a tab
//  * SIDEBAR case:
//    loaded into the TST sidebar

let panel = null;

let windowId = null; // for SIDEBAR case
let tabId = null; // for TAB case
if (!location.href.startsWith('moz-extension://')) { // for REGULAR case
  document.documentElement.style.pointerEvents = 'none';
  document.documentElement.classList.add('tab-preview-frame');
}

// https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5
const BASE_PANEL_WIDTH  = 280;
const BASE_PANEL_HEIGHT = 140;
const DATA_URI_BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

// -moz-platform @media rules looks unavailable on Web contents...
const isWindows = /^Win/i.test(navigator.platform);
const isLinux = /Linux/i.test(navigator.platform);
const isMac = /^Mac/i.test(navigator.platform);

let onMessage;

try{
  const style = document.createElement('style');
  style.setAttribute('type', 'text/css');
  style.textContent = `
    :root.tab-preview-frame {
      --show-hide-animation: opacity 0.1s ease-out;
      --scale: 1; /* Web contents may be zoomed by the user, and we need to cancel the zoom effect. */
      opacity: 1;
      transition: var(--show-hide-animation);
    }

    :root.tab-preview-frame:hover {
      opacity: 0;
    }

    .tab-preview-panel {
      /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/toolkit/themes/shared/popup.css#11-63 */
      color-scheme: light dark;

      --panel-background: Menu;
      --panel-color: MenuText;
      --panel-padding-block: calc(4px / var(--scale));
      --panel-padding: var(--panel-padding-block) 0;
      --panel-border-radius: calc(4px / var(--scale));
      --panel-border-color: ThreeDShadow;
      --panel-width: initial;

      --panel-shadow-margin: 0px;
      --panel-shadow: 0px 0px var(--panel-shadow-margin) hsla(0,0%,0%,.2);
      -moz-window-input-region-margin: var(--panel-shadow-margin);
      margin: calc(-1 * var(--panel-shadow-margin));

      /* Panel design token theming */
      --background-color-canvas: var(--panel-background);

      /*@media (-moz-platform: linux) {*/
      ${isLinux ? '' : '/*'}
        --panel-border-radius: calc(8px / var(--scale));
        --panel-padding-block: calc(3px / var(--scale));

        @media (prefers-contrast) {
          --panel-border-color: color-mix(in srgb, currentColor 60%, transparent);
        }
      ${isLinux ? '' : '*/'}
      /*}*/

      /*@media (-moz-platform: linux) or (-moz-platform: windows) {*/
      ${isLinux || isWindows ? '' : '/*'}
        --panel-shadow-margin: calc(4px / var(--scale));
      ${isLinux || isWindows ? '' : '*/'}
      /*}*/

      /* On some linux WMs we need to draw square menus because alpha is not available */
      @media /*(-moz-platform: linux) and*/ (not (-moz-gtk-csd-transparency-available)) {
        ${isLinux ? '' : '/*'}
        --panel-shadow-margin: 0px !important;
        --panel-border-radius: 0px !important;
        ${isLinux ? '' : '*/'}
      }

      /*@media (-moz-platform: macos) {*/
      ${isMac ? '' : '/*'}
        appearance: auto;
        -moz-default-appearance: menupopup;
        background-color: Menu;
        --panel-background: none;
        --panel-border-color: transparent;
        --panel-border-radius: calc(6px / var(--scale));
      ${isMac ? '' : '*/'}
      /*}*/

      /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5 */
      --panel-width: min(100%, calc(${BASE_PANEL_WIDTH}px / var(--scale)));
      --panel-padding: 0;

      /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/toolkit/themes/shared/global-shared.css#111 */
      /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/browser/themes/shared/browser-colors.css#90 */
      --panel-border-color: light-dark(rgb(240, 240, 244), rgb(82, 82, 94));


      background: var(--panel-background);
      border: var(--panel-border-color) solid calc(1px / var(--scale));
      border-radius: var(--panel-border-radius);
      box-shadow: var(--panel-shadow);
      box-sizing: border-box;
      color: var(--panel-color);
      font: Message-Box;
      left: auto;
      line-height: 1.5;
      margin-top: 0;
      max-width: var(--panel-width);
      min-width: var(--panel-width);
      opacity: 0;
      overflow: hidden; /* clip the preview with the rounded edges */
      padding: 0;
      pointer-events: none; /* for SIDEBAR and TAB case */
      position: fixed;
      right: auto;
      z-index: ${Number.MAX_SAFE_INTEGER}; /* for SIDEBAR and TAB case */
    }
    .tab-preview-panel.animation {
      transition: var(--show-hide-animation),
                  left 0.1s ease-out,
                  right 0.1s ease-out;
    }
    .tab-preview-panel.extended {
      max-width: min(100%, calc(var(--panel-width) * 2));
    }
    .tab-preview-panel.open {
      opacity: 1;
    }
    .tab-preview-panel[data-align="left"].updating,
    .tab-preview-panel[data-align="left"]:not(.open) {
      left: -1ch !important;
    }
    .tab-preview-panel[data-align="right"].updating,
    .tab-preview-panel[data-align="right"]:not(.open) {
      right: -1ch !important;
    }

    .tab-preview-panel.extended .tab-preview-title,
    .tab-preview-panel.extended .tab-preview-url,
    .tab-preview-panel.extended .tab-preview-image-container,
    .tab-preview-panel:not(.extended) .tab-preview-extended-content {
      display: none;
    }

    .tab-preview-panel-contents,
    .tab-preview-panel-contents-inner-box {
      max-width: calc(var(--panel-width) - (2px / var(--scale)));
      min-width: calc(var(--panel-width) - (2px / var(--scale)));
    }
    .tab-preview-panel.extended .tab-preview-panel-contents,
    .tab-preview-panel.extended .tab-preview-panel-contents-inner-box {
      max-width: calc(min(100%, calc(var(--panel-width) * 2)) - (2px / var(--scale)));
    }

    .tab-preview-panel-contents {
      max-height: calc(var(--panel-max-height) - (2px / var(--scale)));
    }

    .tab-preview-panel.overflow .tab-preview-panel-contents {
      mask-image: linear-gradient(to top, transparent 0, black 2em);
    }

    .tab-preview-title {
      font-size: calc(1em / var(--scale));
      font-weight: bold;
      margin: var(--panel-border-radius) var(--panel-border-radius) 0;
      max-height: 3em; /* -webkit-line-clamp looks unavailable, so this is a workaround */
      overflow: hidden;
      /* text-overflow: ellipsis; */
      -webkit-line-clamp: 2; /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#15-18 */
    }

    .tab-preview-url {
      font-size: calc(1em / var(--scale));
      margin: 0 var(--panel-border-radius);
      opacity: 0.69; /* https://searchfox.org/mozilla-central/rev/234f91a9d3ebef0d514868701cfb022d5f199cb5/toolkit/themes/shared/design-system/tokens-shared.css#182 */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tab-preview-extended-content {
      font-size: calc(1em / var(--scale));
      margin: var(--panel-border-radius);
      white-space: pre;
    }

    .tab-preview-image-container {
      border-top: calc(1px / var(--scale)) solid var(--panel-border-color);
      margin-top: 0.25em;
      max-height: calc(var(--panel-width) * ${BASE_PANEL_HEIGHT / BASE_PANEL_WIDTH}); /* use relative value instead of 140px */
      overflow: hidden;
    }

    .tab-preview-image {
      max-width: 100%;
      opacity: 1;
    }
    .tab-preview-panel.animation:not(.updating) .tab-preview-image {
      transition: opacity 0.2s ease-out;
    }
    .tab-preview-image.loading {
      min-height: ${BASE_PANEL_HEIGHT}px;
    }

    .blank,
    .hidden {
      display: none;
    }

    .loading {
      opacity: 0;
    }

    .updating {
      visibility: hidden;
    }


    /* tree */
    .tab-preview-extended-content ul,
    .tab-preview-extended-content ul ul {
      margin: 0 0 0 1em;
      padding: 0;
      list-style: disc;
    }

    .tab-preview-extended-content .title-line {
      display: flex;
      flex-direction: row;
      max-width: 100%;
      white-space: nowrap;
    }
    .tab-preview-extended-content .title-line .title {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tab-preview-extended-content .title-line .cookieStoreName {
      display: flex;
      margin-left: 1ch;
    }
    .tab-preview-extended-content .title-line .cookieStoreName::before {
      content: "- ";
    }
  `;
  document.head.appendChild(style);

  let lastTimestamp = 0;
  onMessage = (message, _sender) => {
    if ((windowId &&
         message?.windowId != windowId) ||
        (tabId &&
         message?.tabId != tabId))
      return;

    if (message?.logging)
      console.log('on message: ', message);

    switch (message?.type) {
      case 'treestyletab:show-tab-preview':
        return (async () => {
          // Simulate the behavior: show tab preview panel with delay
          // only when the panel is not shown yet.
          if (typeof message.waitInitialShowUntil == 'number' &&
              (!panel ||
               !panel.classList.contains('open'))) {
            const delay = Math.max(0, message.waitInitialShowUntil - Date.now());
            if (delay > 0) {
              await new Promise((resolve, _reject) => {
                setTimeout(resolve, delay);
              });
            }
          }
          if (message.timestamp < lastTimestamp) {
            if (message?.logging)
              console.log(' => expired, give up to show/update preview');
            return true;
          }
          lastTimestamp = message.timestamp;
          if (!panel) {
            panel = createPanel();
          }
          updatePanel(message);
          document.documentElement.appendChild(panel);
          panel.classList.add('open');
          return true;
        })();

      case 'treestyletab:hide-tab-preview':
        return (async () => {
          // Ensure the order of messages: "show" for newly hovered tab =>
          // "hide" for previously hovered tab.
          await new Promise(window.requestAnimationFrame);
          if (!panel ||
              (message.previewTabId &&
               panel.dataset.tabId != message.previewTabId)) {
            if (message?.logging)
              console.log(' => already hidden, nothing to do');
            return;
          }
          if (message.timestamp < lastTimestamp) {
            if (message?.logging)
              console.log(' => expired, give up to hide preview');
            return true;
          }
          console.log('hide');
          lastTimestamp = message.timestamp;
          panel.classList.remove('open');
          return true;
        })();

      case 'treestyletab:notify-sidebar-closed':
        if (panel) {
          panel.classList.remove('open');
        }
        break;

      // for TAB case
      case 'treestyletab:notify-tab-preview-owner-info':
        tabId = message.tabId;
        if (tabId) {
          document.documentElement.style.pointerEvents = '';
          document.documentElement.classList.remove('tab-preview-frame');
        }
        if (message?.logging)
          console.log(' => now I am loaded in the tab ${tabId}');
        break;

      // for TAB case
      case 'treestyletab:ask-tab-preview-frame-loaded':
        return Promise.resolve({ tabId, windowId });
    }
  };
  browser.runtime.onMessage.addListener(onMessage);
  window.addEventListener('unload', () => {
    browser.runtime.onMessage.removeListener(onMessage);
  }, { once: true });

  browser.runtime.sendMessage({
    type: 'treestyletab:tab-preview-frame-loaded',
  });
}
catch (error) {
  console.log('TST Tab Preview Frame fatal error: ', error);
}

function createPanel() {
  const panel = document.createElement('div');
  panel.setAttribute('class', 'tab-preview-panel');
  const contents = panel.appendChild(document.createElement('div'));
  contents.setAttribute('class', 'tab-preview-panel-contents');
  const innerBox = contents.appendChild(document.createElement('div'));
  innerBox.setAttribute('class', 'tab-preview-panel-contents-inner-box');
  const title = innerBox.appendChild(document.createElement('div'));
  title.setAttribute('class', 'tab-preview-title');
  const url = innerBox.appendChild(document.createElement('div'));
  url.setAttribute('class', 'tab-preview-url');
  const extendedContent = innerBox.appendChild(document.createElement('div'));
  extendedContent.setAttribute('class', 'tab-preview-extended-content');
  const previewContainer = innerBox.appendChild(document.createElement('div'));
  previewContainer.setAttribute('class', 'tab-preview-image-container');
  const preview = previewContainer.appendChild(document.createElement('img'));
  preview.setAttribute('class', 'tab-preview-image');
  preview.addEventListener('load', () => {
    if (preview.src)
      preview.classList.remove('loading');
  });
  return panel;
}

function updatePanel({ previewTabId, title, url, tooltipHtml, hasPreview, previewURL, previewTabRect, offsetTop, align, scale, logging, animation } = {}) {
  if (!panel)
    return;

  const startAt = updatePanel.lastStartedAt = Date.now();

  const hasLoadablePreviewURL = previewURL && /^((https?|moz-extension):|data:image\/[^,]+,.+)/.test(previewURL);
  if (previewURL)
    hasPreview = hasLoadablePreviewURL;

  if (logging)
    console.log('updatePanel ', { previewTabId, title, url, tooltipHtml, hasPreview, previewURL, previewTabRect, offsetTop, align, scale });

  panel.classList.add('updating');
  panel.classList.toggle('animation', animation);

  // This cancels the zoom effect by the user.
  // We need to calculate the scale with two devicePixelRatio values
  // from both the sidebar and the content area, because all contents
  // of the browser window can be scaled on a high-DPI display by the
  // platform.
  scale = window.devicePixelRatio * (scale || 1);
  document.documentElement.style.setProperty('--scale', scale);
  const panelWidth = Math.min(window.innerWidth, BASE_PANEL_WIDTH / scale);
  panel.style.setProperty('--panel-width', `${panelWidth}px`);

  const offsetFromWindowEdge = (window.mozInnerScreenY - window.screenY) * scale;
  const sidebarContentsOffset = (offsetTop - offsetFromWindowEdge) / scale;

  if (previewTabRect) {
    const panelTopEdge = windowId ? previewTabRect.bottom : previewTabRect.top;
    const panelBottomEdge = windowId ? previewTabRect.bottom : previewTabRect.top;
    const panelMaxHeight = Math.max(window.innerHeight - panelTopEdge - sidebarContentsOffset, panelBottomEdge);
    panel.style.maxHeight = `${panelMaxHeight}px`;
    panel.style.setProperty('--panel-max-height', `${panelMaxHeight}px`);
    if (logging)
      console.log('updatePanel: limit panel height to ', panel.style.maxHeight, { previewTabRect, maxHeight: window.innerHeight, sidebarContentsOffset, offsetFromWindowEdge });
  }

  panel.dataset.tabId = previewTabId;
  if (align)
    panel.dataset.align = align;

  const previewImage = panel.querySelector('.tab-preview-image');
  previewImage.classList.toggle('blank', !hasPreview && !hasLoadablePreviewURL);
  if (!previewURL ||
      (previewURL &&
       previewURL != previewImage.src)) {
    previewImage.classList.add('loading');
    previewImage.src = previewURL || DATA_URI_BLANK_PNG;
  }

  if (tooltipHtml) {
    const extendedContent = panel.querySelector('.tab-preview-extended-content');
    extendedContent.innerHTML = tooltipHtml;
    panel.classList.add('extended');
  }

  if (typeof title == 'string' ||
      typeof url == 'string') {
    const titleElement = panel.querySelector('.tab-preview-title');
    titleElement.textContent = title;
    const urlElement = panel.querySelector('.tab-preview-url');
    urlElement.textContent = url;
    urlElement.classList.toggle('blank', !url);
    panel.classList.remove('extended');
  }

  const completeUpdate = () => {
    previewImage.removeEventListener('load', completeUpdate);
    previewImage.removeEventListener('error', completeUpdate);

    if (panel.dataset.tabId != previewTabId ||
        updatePanel.lastStartedAt != startAt)
      return;

    if (!previewTabRect) {
      panel.classList.remove('updating');
      if (logging)
        console.log('updatePanel/completeUpdate: no tab rect, no need to update the position');
      return;
    }

    const panelBox = panel.getBoundingClientRect();
    if (!panelBox.height &&
        completeUpdate.retryCount++ < 10) {
      if (logging)
        console.log('updatePanel/completeUpdate: panel size is zero, retrying ', completeUpdate.retryCount);
      window.requestAnimationFrame(completeUpdate);
      return;
    }

    const maxY = window.innerHeight / scale;
    const panelHeight = panelBox.height;

    const contentsHeight = panel.querySelector('.tab-preview-panel-contents-inner-box').getBoundingClientRect().height;
    panel.classList.toggle('overflow', contentsHeight > panelHeight);
    if (logging)
      console.log('updatePanel/completeUpdate: overflow: ', contentsHeight, '>', panelHeight);

    if (windowId) { // in-sidebar
      if (logging)
        console.log('updatePanel/completeUpdate: in-sidebar, alignment calculating: ', { half: window.innerHeight, maxY, scale, previewTabRect });
      if (previewTabRect.top > (window.innerHeight / 2)) { // align to bottom edge of the tab
        panel.style.top = `${Math.min(maxY, previewTabRect.bottom / scale) - panelHeight - previewTabRect.height}px`;
        if (logging)
          console.log(' => align to bottom edge of the tab, top=', panel.style.top);
      }
      else { // align to top edge of the tab
        panel.style.top = `${Math.max(0, previewTabRect.top / scale) + previewTabRect.height}px`;
        if (logging)
          console.log(' => align to top edge of the tab, top=', panel.style.top);
      }

      if (logging)
        console.log(' => top=', panel.style.top);
    }
    else { // in-content
      // We need to shift the position with the height of the sidebar header.
      const alignToTopPosition = Math.max(0, previewTabRect.top / scale) + sidebarContentsOffset;
      const alignToBottomPosition = Math.min(maxY, previewTabRect.bottom + sidebarContentsOffset / scale) - panelHeight;

      if (logging)
        console.log('updatePanel/completeUpdate: in-content, alignment calculating: ', { offsetFromWindowEdge, sidebarContentsOffset, alignToTopPosition, panelHeight, maxY, scale });
      if (alignToTopPosition + panelHeight >= maxY &&
          alignToBottomPosition >= 0) { // align to bottom edge of the tab
        panel.style.top = `${alignToBottomPosition}px`;
        if (logging)
          console.log(' => align to bottom edge of the tab, top=', panel.style.top);
      }
      else { // align to top edge of the tab
        panel.style.top = `${alignToTopPosition}px`;
        if (logging)
          console.log(' => align to top edge of the tab, top=', panel.style.top);
      }
    }
    if (align == 'left') {
      panel.style.left  = 'var(--panel-shadow-margin)';
      panel.style.right = '';
    }
    else {
      panel.style.left  = '';
      panel.style.right = 'var(--panel-shadow-margin)';
    }

    panel.classList.remove('updating');
  };
  completeUpdate.retryCount = 0;

  if (!hasPreview) {
    if (logging)
      console.log('updatePanel: no preview, complete now');
    completeUpdate();
    return;
  }

  try {
    const { width, height } = !previewImage.src || previewImage.src == DATA_URI_BLANK_PNG ?
      { width: BASE_PANEL_WIDTH, height: BASE_PANEL_HEIGHT } :
      getPngDimensionsFromDataUri(previewURL);
    if (logging)
      console.log('updatePanel: determined preview size: ', { width, height });
    const imageWidth = Math.min(window.innerWidth, Math.min(width, BASE_PANEL_WIDTH) / scale);
    const imageHeight = imageWidth / width * height;
    previewImage.style.width = previewImage.style.maxWidth = `min(100%, ${imageWidth}px)`;
    previewImage.style.height = previewImage.style.maxHeight = `${imageHeight}px`;
    window.requestAnimationFrame(completeUpdate);
    return;
  }
  catch (error) {
    if (logging)
      console.log('updatePanel: could not detemine preview size ', error, previewURL);
  }

  // failsafe: if it is not a png or failed to get dimensions, give up to determine the image size before loading.
  previewImage.style.width =
    previewImage.style.height =
    previewImage.style.maxWidth =
    previewImage.style.maxHeight = '';
  previewImage.addEventListener('load', completeUpdate, { once: true });
  previewImage.addEventListener('error', completeUpdate, { once: true });
}

function getPngDimensionsFromDataUri(uri) {
  if (!/^data:image\/png;base64,/i.test(uri))
    throw new Error('impossible to parse as PNG image data ', uri);

  const base64Data = uri.split(',')[1];
  const binaryData = atob(base64Data);
  const byteArray = new Uint8Array(binaryData.length);
  const requiredScanSize = Math.min(binaryData.length, 24);
  for (let i = 0; i < requiredScanSize; i++) {
    byteArray[i] = binaryData.charCodeAt(i);
  }
  const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < pngSignature.length; i++) {
    if (byteArray[i] !== pngSignature[i])
      throw new Error('invalid PNG header');
  }
  const width =
    (byteArray[16] << 24) |
    (byteArray[17] << 16) |
    (byteArray[18] << 8) |
    byteArray[19];
  const height =
    (byteArray[20] << 24) |
    (byteArray[21] << 16) |
    (byteArray[22] << 8) |
    byteArray[23];
  return { width, height };
}


// for SIDEBAR case
export function setWindowId(id) {
  windowId = id;
}

// for SIDEBAR case
export async function handleMessage(message) {
  return onMessage(message);
}
