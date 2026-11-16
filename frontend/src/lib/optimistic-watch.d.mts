export function createWatchMutation(): (options: {
  optimistic: () => void;
  save: () => Promise<unknown>;
  rollback: () => void;
  failed: (error: unknown) => void;
  settled: () => void;
}) => Promise<boolean>;
