const RELOAD_WINDOW_START_KEY = 'sse_reload_window_start';
const RELOAD_WINDOW_COUNT_KEY = 'sse_reload_window_count';

const readStoredInt = (storage, key) => {
  const value = parseInt(storage.getItem(key), 10);
  return Number.isNaN(value) ? null : value;
};

const resetReloadWindow = (storage, nowTs) => {
  storage.setItem(RELOAD_WINDOW_START_KEY, String(nowTs));
  storage.setItem(RELOAD_WINDOW_COUNT_KEY, '0');
};

const createReloadController = ({
  storage,
  now,
  setTimeoutFn,
  clearTimeoutFn,
  debounceMs,
  windowMs,
  max,
  onReload,
  onBlocked,
  onSchedule,
  onClear,
}) => {
  let timeoutId = null;

  const canReload = () => {
    const nowTs = now();
    const windowStart = readStoredInt(storage, RELOAD_WINDOW_START_KEY);
    const windowCount = readStoredInt(storage, RELOAD_WINDOW_COUNT_KEY) || 0;

    if (!windowStart || nowTs - windowStart > windowMs) {
      resetReloadWindow(storage, nowTs);
      return true;
    }

    return windowCount < max;
  };

  const incrementReloadCount = () => {
    const nowTs = now();
    const windowStart = readStoredInt(storage, RELOAD_WINDOW_START_KEY);
    const windowCount = readStoredInt(storage, RELOAD_WINDOW_COUNT_KEY) || 0;

    if (!windowStart || nowTs - windowStart > windowMs) {
      resetReloadWindow(storage, nowTs);
      storage.setItem(RELOAD_WINDOW_COUNT_KEY, '1');
      return;
    }

    storage.setItem(RELOAD_WINDOW_COUNT_KEY, String(windowCount + 1));
  };

  const clearPending = () => {
    if (timeoutId) {
      clearTimeoutFn(timeoutId);
      if (onClear) {
        onClear(timeoutId);
      }
      timeoutId = null;
    }
  };

  const scheduleReload = delayMs => {
    const targetDelay = Math.max(delayMs, debounceMs);

    clearPending();

    timeoutId = setTimeoutFn(() => {
      timeoutId = null;

      if (!canReload()) {
        if (onBlocked) {
          onBlocked();
        }
        return;
      }

      incrementReloadCount();
      onReload();
    }, targetDelay);

    if (onSchedule) {
      onSchedule(timeoutId);
    }
  };

  return {
    canReload,
    incrementReloadCount,
    scheduleReload,
    clearPending,
  };
};

module.exports = {
  createReloadController,
  RELOAD_WINDOW_START_KEY,
  RELOAD_WINDOW_COUNT_KEY,
};