export type IpcRequirement = 'public' | 'owner' | string;

export function assertExplicitIpcRequirements(
  channels: Iterable<string>,
  requirements: Readonly<Record<string, string>>,
): void {
  for (const channel of channels) {
    const requirement = requirements[channel];
    if (!requirement || requirement.trim() === 'unknown')
      throw new Error(`Missing IPC requirement: ${channel}`);
  }
}
