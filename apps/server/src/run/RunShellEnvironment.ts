const shellPathSetup = `if [ -n "\${T3CODE_RUN_SHIMS:-}" ]; then
  case "$PATH" in "$T3CODE_RUN_SHIMS:$T3CODE_RUN_BIN":*) ;; *) export PATH="$T3CODE_RUN_SHIMS:$T3CODE_RUN_BIN:$PATH" ;; esac
fi
`;
export const bashStartup = `if [ -n "\${T3CODE_RUN_PREVIOUS_BASH_ENV:-}" ] && [ "$T3CODE_RUN_PREVIOUS_BASH_ENV" != "$BASH_ENV" ] && [ -f "$T3CODE_RUN_PREVIOUS_BASH_ENV" ]; then
  . "$T3CODE_RUN_PREVIOUS_BASH_ENV"
fi
${shellPathSetup}`;
export const zshStartup = (file: string) => `typeset _t3_overlay="$ZDOTDIR"
export ZDOTDIR="\${T3CODE_RUN_PREVIOUS_ZDOTDIR:-$HOME}"
if [ -f "$ZDOTDIR/${file}" ]; then . "$ZDOTDIR/${file}"; fi
export T3CODE_RUN_PREVIOUS_ZDOTDIR="$ZDOTDIR"
export ZDOTDIR="$_t3_overlay"
unset _t3_overlay
${shellPathSetup}`;
export function commandShellEnvironment(
  environment: NodeJS.ProcessEnv,
  bashFile: string,
  zshDirectory: string,
  home: string,
) {
  return {
    ...environment,
    T3CODE_RUN_PREVIOUS_BASH_ENV:
      environment.BASH_ENV === bashFile
        ? (environment.T3CODE_RUN_PREVIOUS_BASH_ENV ?? "")
        : (environment.BASH_ENV ?? ""),
    T3CODE_RUN_PREVIOUS_ZDOTDIR:
      environment.ZDOTDIR === zshDirectory
        ? (environment.T3CODE_RUN_PREVIOUS_ZDOTDIR ?? environment.HOME ?? home)
        : (environment.ZDOTDIR ?? environment.HOME ?? home),
    BASH_ENV: bashFile,
    ZDOTDIR: zshDirectory,
  };
}
