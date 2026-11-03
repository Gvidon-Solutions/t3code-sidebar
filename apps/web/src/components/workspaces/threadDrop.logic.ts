export function threadDropProject<T extends { readonly environmentId: string }>(
  sourceEnvironmentId: string,
  members: readonly T[],
): T | undefined {
  return members.find((project) => project.environmentId === sourceEnvironmentId) ?? members[0];
}
