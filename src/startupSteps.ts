/**
 * The window's startup after the tabs load: open a first tab, or show the
 * active one. A failed step stops the rest but keeps what already loaded,
 * and hands back a retry that runs that step again, then the ones after it.
 */

export type StartupStep = {
  /** Shown on the notice when the step fails ("Active tab did not load"). */
  title: string;
  run: () => Promise<void>;
};

export type StartupFailure = {
  title: string;
  error: unknown;
  /** Runs the failed step and the rest. Null when they all succeed. */
  retry: () => Promise<StartupFailure | null>;
};

export async function runStartupSteps(steps: readonly StartupStep[]): Promise<StartupFailure | null> {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    try {
      await step.run();
    } catch (error: unknown) {
      const rest = steps.slice(i);
      return { title: step.title, error, retry: () => runStartupSteps(rest) };
    }
  }
  return null;
}
