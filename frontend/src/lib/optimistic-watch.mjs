// Acquire synchronously, before React renders disabled controls.
export function createWatchMutation() {
  let pending = false;
  return async ({ optimistic, save, rollback, failed, settled }) => {
    if (pending) return false;
    pending = true;
    optimistic();
    try { await save(); }
    catch (error) { rollback(); failed(error); return false; }
    finally { pending = false; }
    settled();
    return true;
  };
}
