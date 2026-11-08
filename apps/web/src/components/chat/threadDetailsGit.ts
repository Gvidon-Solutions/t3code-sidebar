export interface ThreadDetailsGitVisibilityInput {
  /** A lite replica has no local git checkout; its git state lives on the main copy. */
  readonly isReplica: boolean;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly activeProjectName: string | undefined;
  readonly visible: {
    readonly branch: boolean;
    readonly gitActions: boolean;
    readonly changes: boolean;
  };
}

/**
 * Which Version Control rows the right-hand project panel may draw. A replica never
 * offers Initialize Git (its folder has no .git by design); the panel simply hides
 * git there rather than inventing a checkout.
 */
export function threadDetailsGitVisibility(input: ThreadDetailsGitVisibilityInput) {
  const branch =
    !input.isReplica && input.gitCwd !== null && input.isGitRepo && input.visible.branch;
  const git =
    !input.isReplica &&
    input.gitCwd !== null &&
    input.activeProjectName !== undefined &&
    (input.visible.gitActions || (input.visible.changes && input.isGitRepo));
  return { branch, git, section: input.gitCwd !== null && (branch || git) };
}
