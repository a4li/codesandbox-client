const assert = require('assert');
const {
  createReloadController,
  RELOAD_WINDOW_START_KEY,
  RELOAD_WINDOW_COUNT_KEY,
} = require('../src/reload-control');

const createMemoryStorage = () => {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    _store: store,
  };
};

const createTimer = () => {
  let lastDelay = null;
  let lastCallback = null;
  let lastId = 0;

  const setTimeoutFn = (cb, delay) => {
    lastDelay = delay;
    lastCallback = cb;
    lastId += 1;
    return lastId;
  };

  const clearTimeoutFn = () => {};

  return {
    setTimeoutFn,
    clearTimeoutFn,
    getLastDelay: () => lastDelay,
    runLast: () => lastCallback && lastCallback(),
  };
};

const run = () => {
  // Test debounce delay
  {
    const storage = createMemoryStorage();
    const timer = createTimer();
    let reloaded = false;

    const controller = createReloadController({
      storage,
      now: () => 1000,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
      debounceMs: 1500,
      windowMs: 60000,
      max: 3,
      onReload: () => {
        reloaded = true;
      },
    });

    controller.scheduleReload(500);
    assert.strictEqual(timer.getLastDelay(), 1500);
    timer.runLast();
    assert.strictEqual(reloaded, true);
    assert.strictEqual(storage.getItem(RELOAD_WINDOW_COUNT_KEY), '1');
  }

  // Test rate limit block
  {
    const storage = createMemoryStorage();
    const timer = createTimer();
    let reloaded = false;
    let blocked = false;

    storage.setItem(RELOAD_WINDOW_START_KEY, '1');
    storage.setItem(RELOAD_WINDOW_COUNT_KEY, '3');

    const controller = createReloadController({
      storage,
      now: () => 1000,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
      debounceMs: 1500,
      windowMs: 60000,
      max: 3,
      onReload: () => {
        reloaded = true;
      },
      onBlocked: () => {
        blocked = true;
      },
    });

    controller.scheduleReload(2000);
    timer.runLast();
    assert.strictEqual(reloaded, false);
    assert.strictEqual(blocked, true);
  }

  // Test window reset
  {
    const storage = createMemoryStorage();
    const timer = createTimer();
    let reloaded = false;

    storage.setItem(RELOAD_WINDOW_START_KEY, '0');
    storage.setItem(RELOAD_WINDOW_COUNT_KEY, '3');

    const controller = createReloadController({
      storage,
      now: () => 70000,
      setTimeoutFn: timer.setTimeoutFn,
      clearTimeoutFn: timer.clearTimeoutFn,
      debounceMs: 1500,
      windowMs: 60000,
      max: 3,
      onReload: () => {
        reloaded = true;
      },
    });

    controller.scheduleReload(2000);
    timer.runLast();
    assert.strictEqual(reloaded, true);
    assert.strictEqual(storage.getItem(RELOAD_WINDOW_COUNT_KEY), '1');
  }

  // eslint-disable-next-line no-console
  console.log('reload-control tests passed');
};

run();