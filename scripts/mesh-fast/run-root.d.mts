export function prepareArtifactsDirectory(directory: string): Promise<string>;
export function createRunRoot(directory: string): Promise<{
  artifactsDirectory: string;
  root: string;
}>;
