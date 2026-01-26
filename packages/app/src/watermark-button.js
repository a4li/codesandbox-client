// Test it here: https://codesandbox.io/s/codesandbox-watermark-5onwl?file=/src/index.js

const buttonStyles = `
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 500;
  color: white;
  background-color: rgb(21, 21, 21);
  cursor: pointer;
  border: 1px solid rgb(52,52,52);
  border-radius: 4px;
  text-decoration: none;
  font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Ubuntu,Droid Sans,Helvetica Neue,sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: antialiased;
  z-index: 99999999999;
`;

const setButtonStyles = button => {
  button.setAttribute('style', buttonStyles);
};

const setIframeStyle = iframe => {
  iframe.setAttribute(
    'style',
    `
      position: fixed;
      margin: 0;
      padding: 0;
      bottom: 16px;
      right: 16px;
      border: none;
      width: 118px;
      height: 36px;
      z-index: 9999999999999;
    `
  );

  iframe.addEventListener('load', () => {
    iframe.contentDocument.body.setAttribute('style', `margin: 0;`);
  });
};

function isStandalone() {
  if (typeof window === 'undefined') {
    return true;
  }

  if (window.location && window.location.href.indexOf('?standalone') > -1) {
    return true;
  }

  return !window.opener && window.parent === window;
}

const IFRAME_ID = 'sb__open-sandbox-watermark';
const RECREATE_DEBOUNCE_MS = 250;
let interval;
let observer;
let recreateTimeout;

function createIframe() {
  if (!isStandalone()) {
    return;
  }

  if (!document.body) {
    // eslint-disable-next-line no-use-before-define
    scheduleEnsure();
    return;
  }

  const existing = document.getElementById(IFRAME_ID);
  if (existing) {
    // eslint-disable-next-line no-use-before-define
    startSelfHeal();
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('id', IFRAME_ID);

  const link = document.createElement('a');
  setIframeStyle(iframe);

  iframe.onload = () => {
    iframe.contentDocument.body.appendChild(link);
    setButtonStyles(link);
    link.innerText = 'Open Sandbox';

    link.href =
      'https://codesandbox.io/s/' + document.location.host.split('.')[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  };

  document.body.appendChild(iframe);
  // eslint-disable-next-line no-use-before-define
  startSelfHeal();
}

function scheduleEnsure() {
  if (recreateTimeout) {
    return;
  }

  recreateTimeout = setTimeout(() => {
    recreateTimeout = null;
    createIframe();
  }, RECREATE_DEBOUNCE_MS);
}

function startSelfHeal() {
  if (!observer && typeof MutationObserver !== 'undefined' && document.body) {
    observer = new MutationObserver(() => {
      if (!document.getElementById(IFRAME_ID)) {
        scheduleEnsure();
      }
    });

    observer.observe(document.body, { childList: true });
  }

  if (!observer && !interval) {
    interval = setInterval(() => {
      if (!document.getElementById(IFRAME_ID)) {
        createIframe();
      }
    }, 5000);
  }
}

try {
  setTimeout(() => {
    createIframe();
  }, 250);
} catch (e) {
  console.error(e);
  /* catch */
}
